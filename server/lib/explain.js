'use strict';
/**
 * Small dictionary that turns cryptic macOS process names into plain Swedish.
 * Matched against the process name and, when there is one, the app bundle name.
 * Will be extended in milestone 3.
 */

const ENTRIES = [
  { re: /^(mds|mds_stores|mdworker|mdworker_shared|mdsync|corespotlightd|Spotlight)$/i, label: 'Spotlight', explain: 'Spotlight indexerar filer så att sökningen fungerar. Brukar lugna sig av sig själv, särskilt efter en uppdatering eller många nya filer.' },
  { re: /^kernel_task$/i, label: 'macOS-kärnan', explain: 'Själva macOS. Hög CPU här betyder ofta att datorn är varm och bromsar sig själv för att kyla ner.' },
  { re: /^WindowServer$/i, label: 'Skärmritning', explain: 'Ritar allt du ser på skärmen. Drar mer med många fönster, externa skärmar eller animationer.' },
  { re: /^(photoanalysisd|photolibraryd|mediaanalysisd)$/i, label: 'Bilder analyserar', explain: 'Appen Bilder analyserar foton (ansikten, motiv). Körs mest när datorn är inkopplad och inte används.' },
  { re: /^(bird|cloudd|fileproviderd|CloudDocs|iCloudDrive)$/i, label: 'iCloud', explain: 'iCloud synkar filer. Drar mer när mycket laddas upp eller ned.' },
  { re: /^(backupd|backupd-helper)$/i, label: 'Time Machine', explain: 'Time Machine gör en säkerhetskopia. Låt den bli klar.' },
  { re: /^(softwareupdated|com\.apple\.MobileSoftwareUpdate.*)$/i, label: 'Programuppdatering', explain: 'macOS letar efter eller laddar ner uppdateringar.' },
  { re: /^(launchd)$/i, label: 'macOS start', explain: 'Startar och håller igång andra program. Normalt.' },
  { re: /^(coreaudiod)$/i, label: 'Ljud', explain: 'Hanterar ljud i macOS.' },
  { re: /^(syspolicyd|XprotectService|XProtect.*)$/i, label: 'Säkerhetskontroll', explain: 'macOS kontrollerar att program är säkra att köra.' },
  { re: /^(Google Chrome( Helper.*)?)$/i, label: 'Chrome', explain: 'Webbläsaren Chrome. Varje flik och tillägg är en egen process, så många flikar drar mycket minne.' },
  { re: /^(Safari|com\.apple\.WebKit\..*)$/i, label: 'Safari/WebKit', explain: 'Safari eller en webbvy i en app. Varje flik är en egen process.' },
];

/** @returns {{label: string, explain: string} | null} */
function explainProcess(name, app) {
  for (const candidate of [name, app]) {
    if (!candidate) continue;
    const hit = ENTRIES.find((e) => e.re.test(candidate));
    if (hit) return { label: hit.label, explain: hit.explain };
  }
  return null;
}

module.exports = { explainProcess, ENTRIES };
