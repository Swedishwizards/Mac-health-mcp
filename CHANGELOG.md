# Changelog

Alla viktiga ändringar dokumenteras här. Formatet följer [Keep a Changelog](https://keepachangelog.com/) och projektet använder [semver](https://semver.org/).

## [0.1.0] - Oreleasad (milstolpe 1)

### Tillagt
- Projektskelett: MCP-server över stdio utan beroenden (Node.js 18+), `manifest.json` och byggskript för `.mcpb`.
- Verktyget `get_mac_overview`: hälsokontroll av Macen med modell, macOS, drifttid, CPU-last, minne (inkl. swap), disk, batteri och temperatur.
- Betyg per del: Bra, Okej eller Behöver åtgärd, med råd när något avviker.
- Integritetsfilter: serienummer, UUID, hårdvaru-ID, MAC-adresser, användarnamn och hemkatalogssökvägar filtreras bort innan data skickas till Claude.
- Felhantering: saknas ett kommando eller misslyckas det rapporteras delen som Okänd i stället för att hela verktyget faller. Ogiltiga förfrågningar får JSON-RPC-fel, och argument som `__proto__` och `constructor` avvisas.
- Allt körs lokalt, skrivskyddat och utan nätverksanrop. Kommandon körs utan shell, med absoluta sökvägar och timeout.
- Tester (`node --test`) med sparad kommandoutput.

Status: ej släppt. Ingen `.mcpb` är byggd (hör till milstolpe 4).
