/**
 * mcp-gcp-server.ts
 *
 * Tilaton MCP-palvelin (Model Context Protocol) Google Cloud Run -alustalle.
 * Käyttää Streamable HTTP -transporttia — ei session affinitya tarvita.
 *
 * Tarjoaa kolme dynaamista työkalua GCP:n kaikkiin REST API -rajapintoihin:
 *   - list_gcp_apis     : hakee saatavilla olevat API:t Discovery Serviceltä
 *   - describe_gcp_api  : palauttaa yhden API-version metodilistan
 *   - call_gcp_api      : suorittaa minkä tahansa GCP REST -metodin
 *
 * Autentikointi:
 *   Cloud Run -ympäristössä ADC toimii automaattisesti GCP metadata-serverin
 *   kautta. Lokaalikehityksessä käytetään google-auth-library -pakettia ja
 *   gcloud-sovelluskredentiaalia (ks. UNIT-TESTAUS TUOTANTOAUTENTIKOINNILLA).
 *
 * UNIT-TESTAUS TUOTANTOAUTENTIKOINNILLA
 * ─────────────────────────────────────
 * 1. Kirjaudu gcloudiin kehittäjätunnuksilla:
 *      gcloud auth application-default login
 *    Tämä kirjoittaa ~/.config/gcloud/application_default_credentials.json
 *    jota google-auth-library löytää automaattisesti GOOGLE_APPLICATION_CREDENTIALS
 *    -ympäristömuuttujasta tai oletuspoluista.
 *
 * 2. Aseta kohde-projekti:
 *      export GCLOUD_PROJECT=uutisseuranta-activitystreams
 *
 * 3. Käynnistä palvelin lokaalisti:
 *      npm run build && node dist/mcp-gcp-server.js
 *
 * 4. Testaa yksittäistä työkalua suoraan HTTP:llä:
 *      curl -X POST http://localhost:8080/mcp \
 *        -H 'Content-Type: application/json' \
 *        -d '{
 *          "jsonrpc": "2.0",
 *          "id": 1,
 *          "method": "tools/call",
 *          "params": {
 *            "name": "list_gcp_apis",
 *            "arguments": { "filter": "run" }
 *          }
 *        }'
 *
 * 5. Testaa call_gcp_api -kutsulla tuotannon Cloud Run -palveluilla:
 *      Vaihda path_params-arvot vastaamaan omaa projektiasi.
 *
 * HUOM: gcloud auth application-default -tunnisteet antavat kehittäjän
 * omat oikeudet. Testaa vain resursseilla joihin sinulla on lupa.
 */

import express, { Request, Response, NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const app = express();
app.use(express.json());

// Pyyntöloki — kirjataan Cloud Loggingiin stdout:n kautta
app.use((req, res, next) => {
  process.stdout.write(`Received request: ${req.method} ${req.path}\n`);
  next();
});

// ---------------------------------------------------------------------------
// ADC-TOKEN HELPER
// Hakee GCP Bearer-tokenin kahdella tavalla tärkeysjärjestyksessä:
//   1. GCP metadata-serveri (toimii Cloud Runissa automaattisesti)
//   2. google-auth-library + application_default_credentials (lokaalikehitys)
// ---------------------------------------------------------------------------
async function getAccessToken(): Promise<string> {
  // Yritys 1: Cloud Run -metadata-serveri
  // Timeout 2 s — jos ei vastaa, ollaan todennäköisesti lokaalissa ympäristössä
  const metadataUrl =
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
  try {
    const res = await fetch(metadataUrl, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = (await res.json()) as { access_token: string };
      return data.access_token;
    }
  } catch {
    // Metadata-serveri ei vastannut — siirrytään seuraavaan
  }

  // Yritys 2: google-auth-library (lokaalikehitys)
  // Vaatii: gcloud auth application-default login
  // Paketti ladataan dynaamisesti, joten se ei kaada palvelinta jos puuttuu
  try {
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const client = await auth.getClient();
    const tokenRes = await client.getAccessToken();
    if (tokenRes.token) return tokenRes.token;
  } catch {
    // google-auth-library ei löydy tai autentikointi epäonnistui
  }

  throw new Error(
    "GCP access token -haku epäonnistui. " +
      "Cloud Run: varmista service accountin IAM-oikeudet. " +
      "Lokaali: aja 'gcloud auth application-default login'."
  );
}

// ---------------------------------------------------------------------------
// DISCOVERY-CACHE
// Discovery Service -haku on hidas (~200–400 ms) ja muuttuu harvoin.
// Välimuisti pitää tulokset muistissa 1 tunnin ajan per prosessi-instanssi.
// Tilaton Cloud Run nollaa välimuistin uuden instanssin käynnistyksen yhteydessä.
// ---------------------------------------------------------------------------
interface DiscoveryItem {
  name: string;             // API:n tunniste, esim. "run", "storage"
  version: string;          // Versio, esim. "v2", "v1beta1"
  title: string;            // Luettava nimi, esim. "Cloud Run Admin API"
  description: string;      // Lyhyt kuvaus
  documentationLink?: string;
  discoveryRestUrl?: string; // URL josta API:n skeema haetaan
}

let discoveryCache: DiscoveryItem[] | null = null;
let discoveryCacheTime = 0;
const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 tunti

/** Hakee kaikki Google API:t Discovery Serviceltä, välimuistilla. */
async function fetchDiscoveryList(): Promise<DiscoveryItem[]> {
  const now = Date.now();
  if (discoveryCache && now - discoveryCacheTime < DISCOVERY_CACHE_TTL_MS) {
    return discoveryCache;
  }
  const res = await fetch(
    "https://discovery.googleapis.com/discovery/v1/apis" +
      "?fields=items(name,version,title,description,documentationLink,discoveryRestUrl)"
  );
  if (!res.ok) throw new Error(`Discovery-lista haku epäonnistui: ${res.status}`);
  const data = (await res.json()) as { items: DiscoveryItem[] };
  discoveryCache = data.items ?? [];
  discoveryCacheTime = now;
  return discoveryCache;
}

// Yksittäisen API:n discovery-dokumentti (metodit, skeema, baseUrl)
// Tätä ei vanhenneta — API-skeema muuttuu vain uuden version julkaisun yhteydessä
const apiDocCache: Record<string, unknown> = {};

/** Hakee yhden API-version täydellisen discovery-dokumentin, välimuistilla. */
async function fetchApiDoc(discoveryRestUrl: string): Promise<unknown> {
  if (apiDocCache[discoveryRestUrl]) return apiDocCache[discoveryRestUrl];
  const res = await fetch(discoveryRestUrl);
  if (!res.ok)
    throw new Error(`API-dokumentti haku epäonnistui: ${res.status} ${discoveryRestUrl}`);
  const doc = await res.json();
  apiDocCache[discoveryRestUrl] = doc;
  return doc;
}

// ---------------------------------------------------------------------------
// URL-TEMPLATE RENDERER
// GCP REST -polut sisältävät {param} -placeholdereita, esim.:
//   "projects/{projectsId}/locations/{locationsId}/services"
// Tämä funktio korvaa ne path_params-arvoilla ja palauttaa
// käyttämättömät avaimet query-parametreiksi.
// ---------------------------------------------------------------------------
function renderUrlTemplate(
  template: string,
  params: Record<string, string>
): { url: string; unusedParams: Record<string, string> } {
  const unused: Record<string, string> = { ...params };
  const url = template.replace(/\{(\+?)([^}]+)\}/g, (_match, _plus, key) => {
    const val = unused[key];
    if (val !== undefined) {
      delete unused[key];
      return encodeURIComponent(val);
    }
    return ""; // puuttuva parametri jätetään tyhjäksi
  });
  return { url, unusedParams: unused };
}

// ---------------------------------------------------------------------------
// METODILISTAUS
// Discovery-dokumentin resources-puu on rekursiivinen:
//   resources.projects.resources.locations.methods.list
// Tämä funktio kävelee puun läpi ja kerää kaikki metodit
// pistenotaatiolla ilmaistuine id:ineen (esim. "projects.locations.services.list").
// ---------------------------------------------------------------------------
interface MethodInfo {
  id: string;
  path: string;
  httpMethod: string;
  description?: string;
  parameterOrder?: string[];
}

function collectMethods(
  resources: Record<string, unknown> | undefined,
  methods: Record<string, unknown> | undefined,
  prefix = ""
): MethodInfo[] {
  const result: MethodInfo[] = [];

  // Tason omat metodit
  if (methods) {
    for (const [name, m] of Object.entries(methods as Record<string, MethodInfo>)) {
      result.push({ ...m, id: prefix ? `${prefix}.${name}` : name });
    }
  }

  // Rekursiivinen alipuiden käsittely
  if (resources) {
    for (const [rName, r] of Object.entries(
      resources as Record<string, { methods?: unknown; resources?: unknown }>
    )) {
      const sub = r as {
        methods?: Record<string, MethodInfo>;
        resources?: Record<string, unknown>;
      };
      result.push(
        ...collectMethods(
          sub.resources,
          sub.methods,
          prefix ? `${prefix}.${rName}` : rName
        )
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// TOOL-MÄÄRITYKSET
// Rekisteröidään MCP-asiakkaille tools/list -vastauksessa.
// inputSchema noudattaa JSON Schema Draft-07 -muotoa.
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "list_gcp_apis",
    description:
      "Lists available Google Cloud REST APIs from the Discovery Service. " +
      "Optionally filter by name keyword (e.g. 'run', 'storage', 'bigquery'). " +
      "Results are cached for 1 hour per server instance.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Optional keyword to filter API names or titles (case-insensitive)",
        },
      },
    },
  },

  {
    name: "describe_gcp_api",
    description:
      "Returns all available methods for a specific GCP API version, " +
      "including HTTP method, URL path template, and required parameters. " +
      "Use list_gcp_apis first to find the correct api name and version.",
    inputSchema: {
      type: "object",
      properties: {
        api: {
          type: "string",
          description: "API name from list_gcp_apis, e.g. 'run', 'storage', 'bigquery'",
        },
        version: {
          type: "string",
          description: "API version from list_gcp_apis, e.g. 'v2', 'v1', 'v1beta1'",
        },
      },
      required: ["api", "version"],
    },
  },

  {
    name: "call_gcp_api",
    description:
      "Calls any GCP REST API method dynamically using the current service account. " +
      "Use describe_gcp_api to discover the correct method_id and path parameters. " +
      "path_params: URL path placeholders (e.g. projectsId, locationsId). " +
      "query_params: URL query string parameters. " +
      "body: JSON request body for POST/PATCH/PUT methods.",
    inputSchema: {
      type: "object",
      properties: {
        api: {
          type: "string",
          description: "API name, e.g. 'run', 'storage'",
        },
        version: {
          type: "string",
          description: "API version, e.g. 'v2', 'v1'",
        },
        method_id: {
          type: "string",
          description:
            "Method id from describe_gcp_api, e.g. 'projects.locations.services.list'",
        },
        path_params: {
          type: "object",
          description: "URL path parameters as key-value pairs, e.g. { projectsId: 'my-project' }",
          additionalProperties: { type: "string" },
        },
        query_params: {
          type: "object",
          description: "Query string parameters, e.g. { pageSize: '10' }",
          additionalProperties: { type: "string" },
        },
        body: {
          type: "object",
          description: "Request body for POST/PATCH/PUT methods",
        },
      },
      required: ["api", "version", "method_id"],
    },
  },
];

// ---------------------------------------------------------------------------
// TOOL-TOTEUTUKSET
// Jokainen handler vastaa yhtä TOOLS-taulun merkintää.
// Handlerit heittävät Error-olion virhetilanteissa —
// dispatchRPC muuntaa ne JSON-RPC -32603 -virhevastauksiksi.
// ---------------------------------------------------------------------------
const toolHandlers: Record<string, (args: unknown) => Promise<unknown>> = {

  /**
   * list_gcp_apis
   * Hakee Discovery Service -hakemiston ja suodattaa tulokset.
   * Välimuisti päivittyy kerran tunnissa.
   */
  list_gcp_apis: async (args) => {
    const { filter } = (args ?? {}) as { filter?: string };
    const items = await fetchDiscoveryList();
    const filtered = filter
      ? items.filter(
          (i) =>
            i.name.toLowerCase().includes(filter.toLowerCase()) ||
            (i.title ?? "").toLowerCase().includes(filter.toLowerCase())
        )
      : items;
    return filtered.map((i) => ({
      name: i.name,
      version: i.version,
      title: i.title,
      description: i.description,
      docs: i.documentationLink,
    }));
  },

  /**
   * describe_gcp_api
   * Hakee yksittäisen API-version discovery-dokumentin ja
   * kerää siitä kaikkien metodien metatiedot rekursiivisesti.
   */
  describe_gcp_api: async (args) => {
    const { api, version } = args as { api: string; version: string };
    const items = await fetchDiscoveryList();
    const entry = items.find(
      (i) => i.name === api && i.version === version && i.discoveryRestUrl
    );
    if (!entry?.discoveryRestUrl) {
      throw new Error(
        `API '${api}' versio '${version}' ei löydy Discovery Serviceltä`
      );
    }
    const doc = (await fetchApiDoc(entry.discoveryRestUrl)) as {
      baseUrl?: string;
      resources?: Record<string, unknown>;
      methods?: Record<string, unknown>;
    };
    const methods = collectMethods(
      doc.resources,
      doc.methods as Record<string, MethodInfo>
    );
    return {
      api,
      version,
      baseUrl: doc.baseUrl,
      methods: methods.map((m) => ({
        id: m.id,
        httpMethod: m.httpMethod,
        path: m.path,
        description: m.description,
        parameterOrder: m.parameterOrder,
      })),
    };
  },

  /**
   * call_gcp_api
   * Rakentaa GCP REST -kutsun discovery-dokumentin tietojen pohjalta:
   *   1. Hae discovery-dokumentti (välimuistista tai verkosta)
   *   2. Etsi metodi method_id:llä
   *   3. Renderöi URL-template path_params-arvoilla
   *   4. Lisää query_params URL:iin
   *   5. Hae Bearer-token ADC:ltä
   *   6. Suorita HTTP-kutsu ja palauta JSON-vastaus
   */
  call_gcp_api: async (args) => {
    const {
      api,
      version,
      method_id,
      path_params = {},
      query_params = {},
      body,
    } = args as {
      api: string;
      version: string;
      method_id: string;
      path_params?: Record<string, string>;
      query_params?: Record<string, string>;
      body?: unknown;
    };

    // Vaihe 1: hae discovery-dokumentti
    const items = await fetchDiscoveryList();
    const entry = items.find(
      (i) => i.name === api && i.version === version && i.discoveryRestUrl
    );
    if (!entry?.discoveryRestUrl) {
      throw new Error(`API '${api}' versio '${version}' ei löydy`);
    }
    const doc = (await fetchApiDoc(entry.discoveryRestUrl)) as {
      baseUrl: string;
      resources?: Record<string, unknown>;
      methods?: Record<string, unknown>;
    };

    // Vaihe 2: etsi metodi pistenotaatiolla
    const allMethods = collectMethods(
      doc.resources,
      doc.methods as Record<string, MethodInfo>
    );
    const method = allMethods.find((m) => m.id === method_id);
    if (!method) {
      throw new Error(
        `Metodia '${method_id}' ei löydy API:sta ${api}@${version}. ` +
          `Käytä describe_gcp_api saadaksesi saatavilla olevat metodit.`
      );
    }

    // Vaihe 3: renderöi URL-template
    const baseUrl = doc.baseUrl.replace(/\/$/, "");
    const pathTemplate = method.path.replace(/^\//, "");
    const { url: renderedPath, unusedParams } = renderUrlTemplate(
      pathTemplate,
      path_params
    );
    const fullUrl = new URL(`${baseUrl}/${renderedPath}`);

    // Vaihe 4: lisää query-parametrit
    // unusedParams = path_params-arvot joita ei löydetty URL-templatesta
    // → siirretään query stringiin automaattisesti
    for (const [k, v] of Object.entries(unusedParams)) {
      fullUrl.searchParams.set(k, v);
    }
    for (const [k, v] of Object.entries(query_params)) {
      fullUrl.searchParams.set(k, v);
    }

    // Vaihe 5: hae Bearer-token
    const token = await getAccessToken();

    // Vaihe 6: suorita HTTP-kutsu
    const fetchOptions: RequestInit = {
      method: method.httpMethod,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    };
    if (body && ["POST", "PUT", "PATCH"].includes(method.httpMethod)) {
      fetchOptions.body = JSON.stringify(body);
    }

    const apiRes = await fetch(fullUrl.toString(), fetchOptions);
    const responseText = await apiRes.text();

    // JSON-parsinta — virheen sattuessa palautetaan raakamerkkijono
    let responseData: unknown;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    if (!apiRes.ok) {
      throw new Error(
        `GCP API virhe ${apiRes.status}: ${JSON.stringify(responseData)}`
      );
    }

    return responseData;
  },
};

// ---------------------------------------------------------------------------
// HEALTH CHECK -TILA
// Kolme tilaa kuvaavat palvelimen elinkaarta:
//   starting  — käynnistymisikkuna (30 s), ei merkki ongelmasta
//   ok        — viimeisestä onnistuneesta pyynnöstä alle 5 min
//   degraded  — liian kauan ilman onnistunutta pyyntöä (503)
// Cloud Run käyttää /healthz:ta startup- ja liveness-tarkistuksiin.
// ---------------------------------------------------------------------------
type HealthState = "starting" | "ok" | "degraded";

let lastSuccessfulRequest: Date | null = null;
const serverStartTime: Date = new Date();
const HEALTH_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minuuttia
const STARTUP_GRACE_MS = 30 * 1000;              // 30 sekunnin käynnistysikkuna

const DEPLOYED_SHA = process.env.DEPLOY_SHA ?? "unknown";
const CLOUD_RUN_REVISION = process.env.K_REVISION ?? "unknown";

// ---------------------------------------------------------------------------
// JSON-RPC DISPATCHER
// Käsittelee MCP-protokollan viestit metodin mukaan.
// Notification-viestit (notifications/*) ovat fire-and-forget — ei vastausta.
// Kaikki muut viestit vaativat id-kentän (JSON-RPC 2.0 §4).
// ---------------------------------------------------------------------------
async function dispatchRPC(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
  const msg = message as any;

  // Notifikaatiot: asiakas ei odota vastausta
  const isNotification = msg.method?.startsWith("notifications/");
  if (isNotification) return null;

  // Malformed request: ei-notifikaatio ilman id:tä
  if (msg.id === undefined) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "Invalid Request: id vaaditaan ei-notifikaatioviesteissä",
      },
    } as any;
  }

  // MCP-kättely: palautetaan protokollaversio ja capabilities
  if (msg.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-gcp-server", version: "2.0.0" },
      },
    } as any;
  }

  // Työkalujen listaus
  if (msg.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: { tools: TOOLS },
    } as any;
  }

  // Työkalun suoritus
  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params as {
      name: string;
      arguments: unknown;
    };
    const handler = toolHandlers[name];
    if (!handler) {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Työkalu '${name}' ei löydy` },
      } as any;
    }
    try {
      const result = await handler(args);
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }] },
      } as any;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Tuntematon virhe";
      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: errorMsg },
      } as any;
    }
  }

  // Tuntematon metodi
  return {
    jsonrpc: "2.0",
    id: msg.id ?? null,
    error: { code: -32601, message: `Metodia ei löydy: ${msg.method}` },
  } as any;
}

// ---------------------------------------------------------------------------
// EXPRESS-REITIT
// ---------------------------------------------------------------------------

/**
 * POST /mcp — pääreitti kaikelle MCP-liikenteelle.
 * StreamableHTTPServerTransport hoitaa framing/streamingin,
 * dispatchRPC JSON-RPC-logiikan.
 */
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // tilaton — ei session affinitya
  });

  transport.onmessage = async (message) => {
    try {
      const response = await dispatchRPC(message);
      if (response) await transport.send(response);
    } catch (err) {
      process.stderr.write(`dispatchRPC virhe: ${err}\n`);
    }
  };

  try {
    await transport.handleRequest(req, res, req.body);
    lastSuccessfulRequest = new Date();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Sisäinen palvelinvirhe" },
        id: null,
      });
    }
  }
});

/** OPTIONS /mcp — CORS preflight tulevaa suoraa remote-yhteyttä varten */
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "*";

app.options("/mcp", (_req, res) => {
  res.set({
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.status(204).send();
});

/** Muut metodit /mcp-reitillä hylätään */
app.use("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method Not Allowed" });
});

/**
 * GET /healthz — Cloud Runin startup- ja liveness-probe.
 * Palauttaa 200 tiloissa 'starting' ja 'ok', 503 tilassa 'degraded'.
 */
app.get("/healthz", (_req, res) => {
  const now = Date.now();
  const inGrace = now - serverStartTime.getTime() < STARTUP_GRACE_MS;
  let state: HealthState;
  if (lastSuccessfulRequest === null) {
    state = inGrace ? "starting" : "degraded";
  } else {
    const stale =
      now - lastSuccessfulRequest.getTime() > HEALTH_STALE_THRESHOLD_MS;
    state = stale ? "degraded" : "ok";
  }
  const statusCode = state === "degraded" ? 503 : 200;
  res.status(statusCode).json({
    status: state,
    uptime: process.uptime(),
    last_request: lastSuccessfulRequest?.toISOString() ?? "none",
    deploy_sha: DEPLOYED_SHA,
    revision: CLOUD_RUN_REVISION,
  });
});

/** Globaali virheenkäsittely — kirjataan strukturoidusti Cloud Loggingiin */
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  process.stderr.write(
    JSON.stringify({
      severity: "ERROR",
      message: err.message,
      path: req.path,
      timestamp: new Date().toISOString(),
    }) + "\n"
  );
  res.status(500).json({
    jsonrpc: "2.0",
    error: { code: -32603, message: "Sisäinen palvelinvirhe" },
    id: null,
  });
});

// ---------------------------------------------------------------------------
// KÄYNNISTYS
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  process.stdout.write(`MCP GCP -palvelin kuuntelee portissa ${PORT}\n`);
});
