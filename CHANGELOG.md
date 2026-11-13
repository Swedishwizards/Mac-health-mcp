# Changelog

Alla viktiga ändringar dokumenteras här. Formatet följer [Keep a Changelog](https://keepachangelog.com/) och projektet använder [semver](https://semver.org/).

## [0.3.0] - Oreleasad (milstolpe 3)

### Tillagt
- `diagnose_slowness`: svarar på "varför är min Mac seg?". Sju regler (lång drifttid, minnestryck och swap, nästan full disk, enskild process med hög CPU, Spotlight-indexering, värmebromsning (kernel_task över 50 % CPU samtidigt som macOS rapporterar värmevarning) och sliten batterihälsa) ger rangordnade troliga orsaker, var och en med siffran bakom, förklaring och vad man kan göra. Alla kommandon körs en gång och delas mellan reglerna. CPU mäts med `top` (cirka 1 sekund) och `ps %cpu` (medel över cirka 1 minut), och en process räknas bara som hög om den ligger över gränsen i båda mätningarna. Diagnosen säger bara "ser bra ut" om de kontroller som faktiskt gick att göra; kontroller som inte gick att göra listas som okända. Resultatet kommer som text och JSON, utan identifierande uppgifter. Skrivskyddat.
- Ordlistan `explain.js` utökad: McAfee och andra antivirusprogram, synk- och mötesappar (till exempel Zoom) samt vanliga macOS-bakgrundstjänster.
- Fler tester (79 totalt), bland annat ett stdio-test för `diagnose_slowness` med fake-backend.

### Ändrat
- Drifttid: exakt 14 dagar ger inte längre Behöver åtgärd i `get_mac_overview`. Gränsen är mer än 14 dagar (rättat gränsfall).
- `top_processes` och diagnosen läser även `%cpu` från `ps` för en längre CPU-mätning bredvid `top`.
- Kosmetiskt: egennamnet Spotlight behåller versal i uppräkningen "Kunde inte kontrollera: ... och Spotlight ..." i diagnosens text.

Status: ej släppt.

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
