# GCP Stateless MCP Server

Tilaton [Model Context Protocol (MCP)](https://modelcontextprotocol.io) -palvelin Google Cloud Run -alustalle. Toimii dynaamisena välityspalvelimena GCP:n kaikkiin REST API -rajapintoihin Discovery Servicen kautta.

## Arkkitehtuuri

Palvelin käyttää **tilatonta Streamable HTTP -transporttia** (`StreamableHTTPServerTransport`). Tilattomuus tarkoittaa, ettei pyyntöjen välillä säily tilaa — jokainen HTTP-pyyntö on itsenäinen. Tämä mahdollistaa Cloud Runin scale-to-zero -käytön ilman session affinity -vaatimusta.

JSON-RPC-viestit reititetään manuaalisesti ilman SDK:n `McpServer`-luokkaa, mikä antaa täyden kontrollin protokollan käsittelystä.

## Tarjotut työkalut

| Työkalu | Kuvaus |
|---|---|
| `list_gcp_apis` | Listaa saatavilla olevat GCP REST API:t Discovery Serviceltä. Tukee valinnaista filtteröintiä. |
| `describe_gcp_api` | Palauttaa yksittäisen API-version kaikki metodit polkutemplaatteineen ja parametreineen. |
| `call_gcp_api` | Suorittaa minkä tahansa GCP REST -metodin dynaamisesti palvelun service accountin oikeuksilla. |

### Tyypillinen käyttöketju

```
1. list_gcp_apis { filter: "run" }
   → [{ name: "run", version: "v2", ... }]

2. describe_gcp_api { api: "run", version: "v2" }
   → [{ id: "projects.locations.services.list", httpMethod: "GET", ... }]

3. call_gcp_api {
     api: "run", version: "v2",
     method_id: "projects.locations.services.list",
     path_params: { projectsId: "my-project", locationsId: "europe-north1" }
   }
   → { services: [...] }
```

## Tiedostorakenne

```
gcp-stateless-mcp/
├── mcp-gcp-server.ts   — palvelimen pääkoodi (TypeScript)
├── Dockerfile          — monivaiheinen konttikuva
├── service.yaml        — Cloud Run -palvelun Knative-määritys
├── deploy-mcp.sh       — automaattinen deploy-skripti
├── package.json        — riippuvuudet
├── tsconfig.json       — TypeScript-konfiguraatio
├── README.md           — tämä tiedosto
└── INTEGRATION.md      — asiakasintegraation ohjeet
```

## Käyttöönotto

Aja deploy suorittamalla:

```bash
./deploy-mcp.sh
```

Skripti suorittaa seuraavat vaiheet:
1. Varmistaa pääsyn GCP-projektiin `uutisseuranta-activitystreams`.
2. Kääntää TypeScript-lähdekoodin ja rakentaa Docker-konttikuvan.
3. Lataa konttikuvan Artifact Registryn `mcp-servers`-repositorioon.
4. Päivittää Cloud Run -palvelun `service.yaml`-määrityksen mukaisesti.

## IAM-oikeudet

Palvelu on yksityinen (`--no-allow-unauthenticated`). Kutsujilla täytyy olla `roles/run.invoker` -rooli.

Oikeuden lisääminen kehittäjälle:

```bash
gcloud run services add-iam-policy-binding mcp-gcp-server \
  --region europe-north1 \
  --member="user:jaakko.korhonen@gmail.com" \
  --role="roles/run.invoker" \
  --project=uutisseuranta-activitystreams
```

Palvelun service accountille tarvitaan oikeudet niihin GCP-resursseihin joita `call_gcp_api` kutsuu. Esimerkiksi Cloud Run -palveluiden listaukseen:

```bash
gcloud projects add-iam-policy-binding uutisseuranta-activitystreams \
  --member="serviceAccount:<SERVICE_ACCOUNT_EMAIL>" \
  --role="roles/run.viewer"
```

## Lokaalikehitys ja testaus

Ks. [INTEGRATION.md](./INTEGRATION.md) asiakasintegraation ohjeista ja lokaalitestauksesta.
