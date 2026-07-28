# GCP MCP Host on Cloud Run

Tämä repositorio sisältää konfiguraatiot ja lähdekoodin Model Context Protocol (MCP) -palvelimen isännöimiseksi Google Cloud Runissa. Palvelin tarjoaa työkaluja GCP-resurssien hallintaan ja AI-kehitysapureiden (kuten Antigravity-IDE) integroimiseen.

## Arkkitehtuuri

Palvelin käyttää **tilatonta Streamable HTTP -transporttia** (StreamableHTTPServerTransport).
* **Tilattomuus**: MCP-palvelimen tila ei säily pyyntöjen välillä, mikä poistaa tarpeen istuntokohtaiselle sticky session/session affinity -hallinnalle Cloud Runissa.
* **Manuaalinen JSON-RPC Dispatch**: Pyynnöt käsitellään suoraan ilman SDK:n `McpServer`-luokkaa. Tämä takaa täyden kontrollin JSON-RPC-viestien reitityksestä ja virheiden käsittelystä.

## Tiedostot

Projektin litteä kansiorakenne noudattaa organisaation koodisopimuksia:
* `mcp-gcp-server.ts`: Express-pohjainen Node.js MCP-palvelin.
* `service.yaml`: Knative-määritys Cloud Run -palvelulle terveystarkastuksineen.
* `Dockerfile`: Monivaiheinen kontitusrakenne.
* `deploy-mcp.sh`: Automaattinen asennus- ja päivitysskripti.
* `package.json` & `tsconfig.json`: Riippuvuudet ja TypeScript-konfiguraatiot.

## Käyttöönotto (Deployment)

Aja asennus ja päivitys suorittamalla:
```bash
./deploy-mcp.sh
```
Skripti suorittaa seuraavat vaiheet:
1. Varmistaa pääsyn GCP-projektiin `uutisseuranta-activitystreams`.
2. Kääntää ja lataa konttikuvan Artifact Registryn `mcp-servers`-repositorioon.
3. Päivittää palvelun Cloud Run -määrityksen `service.yaml`-tiedoston mukaisesti.

## Oikeudet (IAM)

Palvelu on suojattu, eikä se salli anonyymeja kutsuja (`--no-allow-unauthenticated`). Kutsujilla on oltava `roles/run.invoker` -oikeus palveluun.

Oikeuden lisääminen kehittäjälle:
```bash
gcloud run services add-iam-policy-binding mcp-gcp-server \
  --region europe-north1 \
  --member="user:jaakko.korhonen@gmail.com" \
  --role="roles/run.invoker" \
  --project=uutisseuranta-activitystreams
```
