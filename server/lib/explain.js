'use strict';
/**
 * Small dictionary that turns cryptic macOS process names into plain Swedish.
 * Matched against the process name and, when there is one, the app bundle name.
 * Third-party entries are neutral on purpose: what the program is and that it can use a lot,
 * never advice to uninstall it.
 */

const ENTRIES = [
  { re: /^(mds|mds_stores|mdworker|mdworker_shared|mdsync|corespotlightd|spotlightknowledged(\..*)?|Spotlight)$/i, label: 'Spotlight', explain: 'Spotlight indexerar filer så att sökningen fungerar. Brukar lugna sig av sig själv, särskilt efter en uppdatering eller många nya filer.' },
  { re: /^kernel_task$/i, label: 'macOS-kärnan', explain: 'Själva macOS. Hög CPU här betyder ofta att datorn är varm och bromsar sig själv för att kyla ner.' },
  { re: /^WindowServer$/i, label: 'Skärmritning', explain: 'Ritar allt du ser på skärmen. Drar mer med många fönster, externa skärmar eller animationer.' },
  { re: /^(photoanalysisd|photolibraryd|mediaanalysisd)$/i, label: 'Bilder analyserar', explain: 'Appen Bilder analyserar foton (ansikten, motiv). Körs mest när datorn är inkopplad och inte används.' },
  { re: /^(bird|cloudd|fileproviderd|CloudDocs|iCloudDrive)$/i, label: 'iCloud', explain: 'iCloud synkar filer. Drar mer när mycket laddas upp eller ned.' },
  { re: /^(backupd|backupd-helper)$/i, label: 'Time Machine', explain: 'Time Machine gör en säkerhetskopia. Låt den bli klar.' },
  { re: /^(softwareupdated|com\.apple\.MobileSoftwareUpdate.*)$/i, label: 'Programuppdatering', explain: 'macOS letar efter eller laddar ner uppdateringar.' },
  { re: /^(launchd)$/i, label: 'macOS start', explain: 'Startar och håller igång andra program. Normalt.' },
  { re: /^(coreaudiod)$/i, label: 'Ljud', explain: 'Hanterar ljud i macOS.' },
  { re: /^(syspolicyd|XprotectService|XProtect.*)$/i, label: 'Säkerhetskontroll', explain: 'macOS kontrollerar att program är säkra att köra.' },
  { re: /^(mobileassetd)$/i, label: 'macOS hämtar resurser', explain: 'macOS laddar ner resurser till systemfunktioner, till exempel röster, ordlistor, typsnitt och språkmodeller. Brukar lugna sig när nedladdningen är klar.' },
  { re: /^(nsurlsessiond)$/i, label: 'Bakgrundsnedladdning', explain: 'Sköter nedladdningar i bakgrunden åt appar och macOS. Drar mer när mycket laddas ner.' },
  { re: /^(triald|triald_system)$/i, label: 'Funktionsinställningar från Apple', explain: 'Hämtar inställningar och små funktionsuppdateringar från Apple i bakgrunden. Normalt.' },
  { re: /^(sirittsd|siriknowledged|siriactionsd|assistantd)$/i, label: 'Siri', explain: 'Del av Siri (t.ex. talsyntes och förslag). Normalt, drar oftast lite.' },
  { re: /^(suggestd)$/i, label: 'Siri-förslag', explain: 'Analyserar mejl, meddelanden och kalender lokalt för att ge förslag. Kan dra en stund efter en uppdatering.' },
  { re: /^(trustd)$/i, label: 'Certifikatkontroll', explain: 'Kontrollerar certifikat för säkra anslutningar och signerade program. Normalt.' },
  { re: /^(logd)$/i, label: 'Systemloggar', explain: 'Samlar in macOS loggmeddelanden. Drar mer om något program loggar väldigt mycket.' },
  { re: /^(cfprefsd)$/i, label: 'Inställningar', explain: 'Läser och sparar inställningar åt program. Normalt.' },
  { re: /^(oahd|oahd-helper)$/i, label: 'Rosetta', explain: 'Översätter program byggda för Intel-processorer så att de kan köras på Apple-chip. Drar mest första gången ett sådant program startas.' },
  { re: /^(Finder)$/i, label: 'Finder', explain: 'Finder visar filer och mappar. Drar mer när den räknar ut storlekar eller visar förhandsbilder.' },
  { re: /^(com\.apple\.Virtualization\.VirtualMachine)$/i, label: 'Virtuell maskin', explain: 'En virtuell maskin körs, alltså ett helt eget system inuti Macen (används av t.ex. Docker, UTM och vissa utvecklarverktyg). Reserverar ofta mycket minne.' },
  { re: /^(StatefulFirewall|VShield.*|McAfee.*|Mcafee Reporter|masagent|macmnsvc|macompatsvc|fmpd|mfe[a-z]*|com\.mcafee\..*)$/i, label: 'McAfee antivirus/brandvägg', explain: 'Del av säkerhetsprogrammet McAfee: VShield söker igenom filer efter skadlig kod och StatefulFirewall filtrerar nätverkstrafik. Sådana program kan dra mycket CPU och minne, särskilt under en genomsökning.' },
  { re: /^(wdavdaemon.*|Microsoft Defender.*)$/i, label: 'Microsoft Defender antivirus', explain: 'Säkerhetsprogrammet Microsoft Defender söker igenom filer efter skadlig kod. Kan dra mycket under en genomsökning.' },
  { re: /^(Norton.*|SymDaemon|com\.symantec\..*)$/i, label: 'Norton antivirus', explain: 'Säkerhetsprogrammet Norton söker igenom filer och nätverkstrafik. Kan dra mycket under en genomsökning.' },
  { re: /^(Sophos.*)$/i, label: 'Sophos antivirus', explain: 'Säkerhetsprogrammet Sophos söker igenom filer efter skadlig kod. Kan dra mycket under en genomsökning.' },
  { re: /^(falcond|com\.crowdstrike\..*)$/i, label: 'CrowdStrike säkerhetsprogram', explain: 'CrowdStrike Falcon, ett säkerhetsprogram som ofta installeras av arbetsgivare. Övervakar vad som händer på datorn.' },
  { re: /^(com\.docker\..*|Docker Desktop|Docker)$/i, label: 'Docker', explain: 'Docker kör utvecklarcontainrar i en virtuell maskin. Reserverar ofta flera GB minne även när inget används.' },
  { re: /^(Dropbox.*)$/i, label: 'Dropbox', explain: 'Dropbox synkar filer. Drar mer när mycket laddas upp eller ned.' },
  { re: /^(OneDrive.*|FileProvider.*OneDrive.*)$/i, label: 'OneDrive', explain: 'OneDrive synkar filer. Drar mer när mycket laddas upp eller ned.' },
  { re: /^(Google Drive.*)$/i, label: 'Google Drive', explain: 'Google Drive synkar filer. Drar mer när mycket laddas upp eller ned.' },
  { re: /^(MSTeams|Microsoft Teams.*)$/i, label: 'Microsoft Teams', explain: 'Teams för möten och chatt. Drar mycket CPU under videomöten.' },
  { re: /^(zoom\.us|ZoomOpener|CptHost)$/i, label: 'Zoom', explain: 'Zoom för videomöten. Drar mycket CPU under möten, särskilt med bakgrundseffekter.' },
  { re: /^(Slack( Helper.*)?)$/i, label: 'Slack', explain: 'Chattappen Slack. Bygger på webbteknik och kan dra mycket minne.' },
  { re: /^(AdobeIPCBroker|Adobe.*|Creative Cloud.*|CCXProcess|CCLibrary|Core Sync)$/i, label: 'Adobe', explain: 'Program och bakgrundstjänster från Adobe (Creative Cloud). Synkar och söker uppdateringar i bakgrunden.' },
  { re: /^(Claude( Helper.*)?)$/i, label: 'Claude', explain: 'Claude-appen. Bygger på webbteknik, så den består av flera processer.' },
  { re: /^(firefox|plugin-container)$/i, label: 'Firefox', explain: 'Webbläsaren Firefox. Många flikar drar mycket minne.' },
  { re: /^(Microsoft Edge( Helper.*)?)$/i, label: 'Edge', explain: 'Webbläsaren Edge. Varje flik och tillägg är en egen process, så många flikar drar mycket minne.' },
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
