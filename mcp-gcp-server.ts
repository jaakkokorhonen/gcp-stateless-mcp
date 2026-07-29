import express, { Request, Response, NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  process.stdout.write(`Received request: ${req.method} ${req.path}\n`);
  next();
});

// ---------------------------------------------------------------------------
// ADC-token helper — hakee access tokenin GCP metadata-serveriltä (Cloud Run)
// tai GOOGLE_APPLICATION_CREDENTIALS-ympäristömuuttujasta (lokaali kehitys)
// ---------------------------------------------------------------------------
async function getAccessToken(): Promise<string> {
  // Cloud Run: metadata-serveri antaa tokenin automaattisesti
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
    // ei Cloud Run -ympäristössä, yritetään seuraavaa
  }

  // Lokaalikehitys: google-auth-library (valinnainen riippuvuus)
  try {
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const client = await auth.getClient();
    const tokenRes = await client.getAccessToken();
    if (tokenRes.token) return tokenRes.token;
  } catch {
    // google-auth-library ei ole asennettuna
  }

  throw new Error(
    "Ei pystytty hakemaan GCP access tokenia. " +
      "Varmista että palvelu pyörii Cloud Runissa tai GOOGLE_APPLICATION_CREDENTIALS on asetettu."
  );
}

// ---------------------------------------------------------------------------
// Discovery-cache — vähennetään ulkoisia HTTP-kutsuja
// ---------------------------------------------------------------------------
interface DiscoveryItem {
  name: string;
  version: string;
  title: string;
  description: string;
  documentationLink?: string;
  discoveryRestUrl?: string;
}

let discoveryCache: DiscoveryItem[] | null = null;
let discoveryCacheTime = 0;
const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 h

async function fetchDiscoveryList(): Promise<DiscoveryItem[]> {
  const now = Date.now();
  if (discoveryCache && now - discoveryCacheTime < DISCOVERY_CACHE_TTL_MS) {
    return discoveryCache;
  }
  const res = await fetch(
    "https://discovery.googleapis.com/discovery/v1/apis?fields=items(name,version,title,description,documentationLink,discoveryRestUrl)"
  );
  if (!res.ok) throw new Error(`Discovery list fetch failed: ${res.status}`);
  const data = (await res.json()) as { items: DiscoveryItem[] };
  discoveryCache = data.items ?? [];
  discoveryCacheTime = now;
  return discoveryCache;
}

// Yksittäisen API:n discovery-dokumentti (metodit, skeema, baseUrl)
const apiDocCache: Record<string, unknown> = {};

async function fetchApiDoc(discoveryRestUrl: string): Promise<unknown> {
  if (apiDocCache[discoveryRestUrl]) return apiDocCache[discoveryRestUrl];
  const res = await fetch(discoveryRestUrl);
  if (!res.ok) throw new Error(`API doc fetch failed: ${res.status} ${discoveryRestUrl}`);
  const doc = await res.json();
  apiDocCache[discoveryRestUrl] = doc;
  return doc;
}

// ---------------------------------------------------------------------------
// URL-template renderer — korvaa {param} -placeholderit arvoilla
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
    return "";
  });
  return { url, unusedParams: unused };
}

// Rekursiivinen metodilistaus discovery-dokumentin resources-puusta
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
  if (methods) {
    for (const [name, m] of Object.entries(methods as Record<string, MethodInfo>)) {
      result.push({ ...m, id: prefix ? `${prefix}.${name}` : name });
    }
  }
  if (resources) {
    for (const [rName, r] of Object.entries(resources as Record<string, { methods?: unknown; resources?: unknown }>)) {
      const sub = r as { methods?: Record<string, MethodInfo>; resources?: Record<string, unknown> };
      result.push(...collectMethods(sub.resources, sub.methods, prefix ? `${prefix}.${rName}` : rName));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool-määritykset
// ---------------------------------------------------------------------------
const TOOLS = [
  // --- Alkuperäinen työkalu (säilytetty) ---
  {
    name: "get_project_status",
    description: "Returns current GCP project status (stub)",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "GCP project ID" },
      },
      required: ["projectId"],
    },
  },

  // --- Uudet dynaamiset työkalut ---
  {
    name: "list_gcp_apis",
    description:
      "Lists available Google Cloud REST APIs from the Discovery Service. " +
      "Optionally filter by name keyword (e.g. 'run', 'storage', 'bigquery').",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Optional keyword to filter API names (case-insensitive)",
        },
      },
    },
  },

  {
    name: "describe_gcp_api",
    description:
      "Returns available methods for a specific GCP API version. " +
      "Use list_gcp_apis first to find the correct api name and version.",
    inputSchema: {
      type: "object",
      properties: {
        api: {
          type: "string",
          description: "API name, e.g. 'run', 'storage', 'bigquery'",
        },
        version: {
          type: "string",
          description: "API version, e.g. 'v2', 'v1', 'v1beta1'",
        },
      },
      required: ["api", "version"],
    },
  },

  {
    name: "call_gcp_api",
    description:
      "Calls any GCP REST API method dynamically. " +
      "Use describe_gcp_api to find the correct method id and required parameters. " +
      "Path parameters (e.g. projectId, location) go into path_params; " +
      "query parameters go into query_params; request body goes into body.",
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
          description: "Method id from describe_gcp_api, e.g. 'projects.locations.services.list'",
        },
        path_params: {
          type: "object",
          description: "URL path parameters as key-value pairs",
          additionalProperties: { type: "string" },
        },
        query_params: {
          type: "object",
          description: "Query string parameters as key-value pairs",
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
// Tool-toteutukset
// ---------------------------------------------------------------------------
const toolHandlers: Record<string, (args: unknown) => Promise<unknown>> = {
  get_project_status: async (args) => {
    const { projectId } = args as { projectId: string };
    return { status: "active", projectId };
  },

  list_gcp_apis: async (args) => {
    const { filter } = (args ?? {}) as { filter?: string };
    const items = await fetchDiscoveryList();
    const filtered = filter
      ? items.filter(
          (i) =>
            i.name.toLowerCase().includes(filter.toLowerCase()) ||
            i.title?.toLowerCase().includes(filter.toLowerCase())
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

  describe_gcp_api: async (args) => {
    const { api, version } = args as { api: string; version: string };
    const items = await fetchDiscoveryList();
    const entry = items.find(
      (i) => i.name === api && i.version === version && i.discoveryRestUrl
    );
    if (!entry?.discoveryRestUrl) {
      throw new Error(`API '${api}' version '${version}' not found in Discovery Service`);
    }
    const doc = (await fetchApiDoc(entry.discoveryRestUrl)) as {
      baseUrl?: string;
      resources?: Record<string, unknown>;
      methods?: Record<string, unknown>;
    };
    const methods = collectMethods(doc.resources, doc.methods as Record<string, MethodInfo>);
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

    // Hae discovery-dokumentti
    const items = await fetchDiscoveryList();
    const entry = items.find(
      (i) => i.name === api && i.version === version && i.discoveryRestUrl
    );
    if (!entry?.discoveryRestUrl) {
      throw new Error(`API '${api}' version '${version}' not found`);
    }
    const doc = (await fetchApiDoc(entry.discoveryRestUrl)) as {
      baseUrl: string;
      resources?: Record<string, unknown>;
      methods?: Record<string, unknown>;
    };

    // Etsi metodi
    const allMethods = collectMethods(
      doc.resources,
      doc.methods as Record<string, MethodInfo>
    );
    const method = allMethods.find((m) => m.id === method_id);
    if (!method) {
      throw new Error(
        `Method '${method_id}' not found in ${api}@${version}. ` +
          `Use describe_gcp_api to list available methods.`
      );
    }

    // Rakenna URL
    const baseUrl = doc.baseUrl.replace(/\/$/, "");
    const pathTemplate = method.path.replace(/^\//, "");
    const { url: renderedPath, unusedParams } = renderUrlTemplate(
      pathTemplate,
      path_params
    );
    const fullUrl = new URL(`${baseUrl}/${renderedPath}`);

    // Query-parametrit: unused path_params + explicit query_params
    for (const [k, v] of Object.entries(unusedParams)) {
      fullUrl.searchParams.set(k, v);
    }
    for (const [k, v] of Object.entries(query_params)) {
      fullUrl.searchParams.set(k, v);
    }

    // Autentikointi
    const token = await getAccessToken();

    // HTTP-kutsu
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

    let responseData: unknown;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    if (!apiRes.ok) {
      throw new Error(
        `GCP API error ${apiRes.status}: ${JSON.stringify(responseData)}`
      );
    }

    return responseData;
  },
};

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
type HealthState = "starting" | "ok" | "degraded";

let lastSuccessfulRequest: Date | null = null;
const serverStartTime: Date = new Date();
const HEALTH_STALE_THRESHOLD_MS = 5 * 60 * 1000;
const STARTUP_GRACE_MS = 30 * 1000;

const DEPLOYED_SHA = process.env.DEPLOY_SHA ?? "unknown";
const CLOUD_RUN_REVISION = process.env.K_REVISION ?? "unknown";

// ---------------------------------------------------------------------------
// JSON-RPC dispatcher
// ---------------------------------------------------------------------------
async function dispatchRPC(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
  const msg = message as any;
  const isNotification = msg.method?.startsWith("notifications/");
  if (isNotification) return null;

  if (msg.id === undefined) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "Invalid Request: id is required for non-notification messages",
      },
    } as any;
  }

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

  if (msg.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: { tools: TOOLS },
    } as any;
  }

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
        error: { code: -32601, message: `Tool not found: ${name}` },
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
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: errorMsg },
      } as any;
    }
  }

  return {
    jsonrpc: "2.0",
    id: msg.id ?? null,
    error: { code: -32601, message: `Method not found: ${msg.method}` },
  } as any;
}

// ---------------------------------------------------------------------------
// Express-reitit
// ---------------------------------------------------------------------------
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  transport.onmessage = async (message) => {
    try {
      const response = await dispatchRPC(message);
      if (response) await transport.send(response);
    } catch (err) {
      process.stderr.write(`Error in dispatchRPC: ${err}\n`);
    }
  };

  try {
    await transport.handleRequest(req, res, req.body);
    lastSuccessfulRequest = new Date();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "*";

app.options("/mcp", (_req, res) => {
  res.set({
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.status(204).send();
});

app.use("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method Not Allowed" });
});

app.get("/healthz", (_req, res) => {
  const now = Date.now();
  const inGrace = now - serverStartTime.getTime() < STARTUP_GRACE_MS;
  let state: HealthState;
  if (lastSuccessfulRequest === null) {
    state = inGrace ? "starting" : "degraded";
  } else {
    const stale = now - lastSuccessfulRequest.getTime() > HEALTH_STALE_THRESHOLD_MS;
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
    error: { code: -32603, message: "Internal server error" },
    id: null,
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  process.stdout.write(`Server listening on port ${PORT}\n`);
});
