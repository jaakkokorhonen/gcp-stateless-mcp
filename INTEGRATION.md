# Antigravity-IDE Client Integration Guide

Tämä dokumentti kuvaa, miten paikallinen Antigravity-IDE -asiakasohjelma yhdistetään Cloud Runissa pyörivään MCP-palvelimeen.

## Integraatiomalli: Suora HTTPS-yhteys (OIDC)

Palvelu on deploattu suojattuna (private) Cloud Run -palveluna. Google Front End (GFE) vaatii jokaiselta pyynnöltä voimassa olevan OIDC-tunnisteen (Identity Token), jonka kohdeyleisöksi (Audience) on asetettu palvelun URL.

### Automaattinen valtuutus IDE:ssä

Antigravity-IDE tukee GCP-autentikointia natiivisti. Kun asiakasohjelma havaitsee Cloud Run -osoitteen, se hakee aktiivisen kehittäjäprofiilin (esim. `jaakko.korhonen@gmail.com`) tunnistetiedot ja liittää ne pyynnön otsikoihin:

```http
Authorization: Bearer <OIDC_IDENTITY_TOKEN>
```

### Konfiguraatio

Määritä palvelin IDE:n MCP-palvelinlistaan (`mcp_config.json`):

```json
{
  "mcpServers": {
    "remote-gcp-mcp": {
      "url": "https://mcp-gcp-server-754758809337.europe-north1.run.app/mcp"
    }
  }
}
```

Tämän konfiguraation avulla IDE kytkeytyy suoraan etäpalvelimeen ilman paikallisten proxy-prosessien käynnistämistä.
