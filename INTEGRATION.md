# Integraatio-opas

Tämä dokumentti kuvaa, miten MCP-asiakasohjelmat yhdistetään Cloud Runissa pyörivään palvelimeen, sekä miten palvelinta testataan lokaalisti tuotantoautentikoinnilla.

## Asiakasintegraatio: Suora HTTPS-yhteys

Palvelu on suojattu yksityinen Cloud Run -palvelu. Google Front End (GFE) vaatii jokaiselta pyynnöltä voimassa olevan OIDC Identity Tokenin, jonka `aud`-kentässä on palvelun URL.

### MCP-asiakaskonfiguraatio

Määritä palvelin MCP-asiakkaan konfiguraatioon:

```json
{
  "mcpServers": {
    "gcp-mcp": {
      "url": "https://mcp-gcp-server-754758809337.europe-north1.run.app/mcp"
    }
  }
}
```

Antigravity-IDE ja muut GCP-integraatiota tukevat MCP-asiakkaat hakevat OIDC-tokenin automaattisesti aktiivisesta gcloud-profiilista ja liittävät sen `Authorization: Bearer <token>` -otsikkoon.

### Manuaalinen testaus curl:lla

Hae ensin OIDC-token:

```bash
TOKEN=$(gcloud auth print-identity-token \
  --audiences="https://mcp-gcp-server-754758809337.europe-north1.run.app")
```

Testaa työkalun kutsu:

```bash
curl -X POST https://mcp-gcp-server-754758809337.europe-north1.run.app/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "list_gcp_apis",
      "arguments": { "filter": "run" }
    }
  }'
```

## Lokaalitestaus tuotantoautentikoinnilla

Lokaalisti palvelin käyttää `google-auth-library` -pakettia ja ADC-tunnistetta (Application Default Credentials). Tämä tarkoittaa, että testissä käytetään kehittäjän omia GCP-oikeuksia — ei mock-dataa.

### 1. Kirjaudu sisään ADC:ksi

```bash
gcloud auth application-default login
```

Tämä avaa selaimen ja kirjoittaa tunnisteet tiedostoon:
- macOS/Linux: `~/.config/gcloud/application_default_credentials.json`
- Windows: `%APPDATA%\gcloud\application_default_credentials.json`

### 2. Aseta kohde-projekti

```bash
export GCLOUD_PROJECT=uutisseuranta-activitystreams
```

Voit myös lisätä tämän `.env`-tiedostoon (muista lisätä `.gitignore`:en).

### 3. Asenna riippuvuudet ja käynnistä

```bash
npm install
npm run dev
```

Palvelin käynnistyy portissa `8080` (tai `PORT`-ympäristömuuttujan arvossa).

### 4. Testaa lokaalisti ilman autentikointivaatimusta

Lokaalissa ympäristössä palvelu ei vaadi OIDC-tokenia Cloud Run -tasolla. Bearer-token haetaan ADC:stä suoraan koodissa.

```bash
# Listaa Cloud Run API:n metodit
curl -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "describe_gcp_api",
      "arguments": { "api": "run", "version": "v2" }
    }
  }'
```

```bash
# Listaa projektin Cloud Run -palvelut
curl -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "call_gcp_api",
      "arguments": {
        "api": "run",
        "version": "v2",
        "method_id": "projects.locations.services.list",
        "path_params": {
          "projectsId": "uutisseuranta-activitystreams",
          "locationsId": "europe-north1"
        }
      }
    }
  }'
```

```bash
# Terveyspiste — ei vaadi autentikointia
curl http://localhost:8080/healthz
```

### 5. Testaa Cloud Logging -kysely

```bash
curl -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "call_gcp_api",
      "arguments": {
        "api": "logging",
        "version": "v2",
        "method_id": "entries.list",
        "body": {
          "resourceNames": ["projects/uutisseuranta-activitystreams"],
          "filter": "resource.type=\"cloud_run_revision\" severity>=ERROR",
          "pageSize": 10
        }
      }
    }
  }'
```

## Autentikoinnin toimintalogiikka

Palvelin yrittää tokenin hakua kahdessa vaiheessa:

| Ympäristö | Metodi | Vaatimus |
|---|---|---|
| Cloud Run | GCP metadata-serveri | Ei lisätoimia — automaattinen |
| Lokaali | google-auth-library + ADC | `gcloud auth application-default login` |

Metadata-serverin timeout on 2 sekuntia. Jos se ei vastaa (lokaalikehitys), siirrytään automaattisesti google-auth-library -pakettiin.

## Huomioita oikeuksista

Lokaalitestauksessa käytetään kehittäjän omia IAM-oikeuksia. Varmista, että käyttäjätunnuksellasi on oikeudet testattaviin resursseihin. Cloud Runissa käytetään palvelun service accountia — sen oikeudet voivat poiketa kehittäjän oikeuksista. Testaa aina lopulliset käyttötapaukset myös tuotantoympäristössä.
