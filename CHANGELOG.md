# Changelog

Alla viktiga ändringar dokumenteras här. Formatet följer [Keep a Changelog](https://keepachangelog.com/) och projektet använder [semver](https://semver.org/).

## [0.2.0] - Oreleasad (milstolpe 2)

### Tillagt
- `top_processes`: de appar och processer som drar mest CPU och minne just nu, grupperat per app. Bara processnamn returneras, aldrig användarnamn eller fullständiga sökvägar. Valfritt argument `limit` (1-25).
- `memory_report`: minnestryck, swap, komprimerat minne och filcache förklarat på vanlig svenska med betyg.
- `disk_report`: ledigt utrymme på startdisken med betyg och varning, plus de största mapparna i hemkatalogen (visas som ~/Library, ~/Downloads). Skyddade mappar hoppas över och rapporteras.
- `battery_report`: batterihälsa, laddcykler, laddstatus, temperatur och tips, med betyg. Stationära Macar utan batteri får ett lugnt svar. Serienummer returneras aldrig.
- `thermal_status`: visar om macOS bromsar processorn på grund av värme, med betyg och råd.
- `startup_items`: vad som startar automatiskt (launch agents och daemons), markerat som Apple eller tredje part. Listar bara mappinnehåll.
- Ordlistan `explain.js`: översätter kryptiska macOS-processnamn (till exempel mds_stores, kernel_task, WindowServer, bird/cloudd, backupd) till begriplig svenska.
- Fler tester (53 totalt).

Alla verktyg är skrivskyddade och lokala. Status: ej släppt.

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
