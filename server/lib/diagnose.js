'use strict';
/**
 * diagnose_slowness: finds likely reasons why the Mac feels slow and ranks them.
 * Pure: takes raw command output that has already been collected (the same keys as
 * get_mac_overview plus top/ps, and du only when the disk is nearly full) and returns plain data.
 * No commands are run here, so every rule can be tested with fixtures on any OS.
 */

const p = require('./parse');
const { buildOverview, GRADE, LIMITS } = require('./overview');
const { buildTopProcesses, buildDiskReport, buildStartupItems } = require('./reports');
const { explainProcess } = require('./explain');
const { scrubString } = require('./privacy');

// Thresholds for the rules, in one place.
const RULES = {
  uptime_days: LIMITS.uptime_bad_days, // more than 14 days
  swap_bytes: LIMITS.swap_ok_bytes, // more than 2 GB
  disk_free_percent: LIMITS.disk_free_bad_percent, // under 10 %
  process_cpu_percent: 80, // in both measurements (top ~1 s and ps ~1 min)
  spotlight_cpu_percent: 50, // mds_stores + mdworker* together, in top
  kernel_task_cpu_percent: 50,
  battery_health_percent: LIMITS.battery_health_bad_percent, // under 80 %
  startup_third_party: 15, // at least 15 startup items not from Apple
  startup_names_shown: 3,
  max_process_causes: 3,
};

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const round1 = (n) => Math.round(n * 10) / 10;
const SPOTLIGHT = /^(mds_stores|mdworker|mdworker_shared|mds)$/i;
const SELF = new Set(['top', 'ps']);

function sizeText(mb) {
  return mb >= 1024 ? `${round1(mb / 1024).toString().replace('.', ',')} GB` : `${mb} MB`;
}
const num = (n) => String(n).replace('.', ',');
/** "a, b och c" with only the first word capitalised as in a sentence; proper names (Spotlight) keep their capital. */
const PROPER_NAMES = /^Spotlight/;
function listText(names) {
  const lower = names.map((n, i) => (i === 0 || PROPER_NAMES.test(n) ? n : n.charAt(0).toLowerCase() + n.slice(1)));
  return lower.length > 1 ? `${lower.slice(0, -1).join(', ')} och ${lower[lower.length - 1]}` : lower[0] || '';
}

/** Joins top (CPU over ~1 s) with ps (name, app, CPU averaged over ~1 min) per pid. */
function processList(raw) {
  const top = p.parseTop(raw.top);
  const names = p.parsePs(raw.ps);
  if (!top || !top.processes.length) return null;
  return top.processes.map((t) => {
    const n = names.get(t.pid) || (t.pid === 0 ? { name: 'kernel_task', app: null, cpu_percent: null } : { name: 'Okänd', app: null, cpu_percent: null });
    return { pid: t.pid, name: n.name || 'Okänd', app: n.app, top_cpu: t.cpu_percent, ps_cpu: n.cpu_percent, mem_bytes: t.mem_bytes };
  }).filter((x) => !SELF.has(x.name));
}

function label(name, app) {
  const e = explainProcess(name, app);
  return e ? { label: e.label, explanation: e.explain } : { label: null, explanation: null };
}

// ---------- rules: each returns a cause or null ----------

function uptimeRule(o) {
  const u = o.uptime;
  if (typeof u.uptime_days !== 'number') return { status: 'okänd' };
  if (!(u.uptime_days > RULES.uptime_days)) return { status: 'ok', value: `${num(u.uptime_days)} dagar` };
  const days = Math.floor(u.uptime_days);
  return {
    kind: 'long_uptime',
    score: 60 + Math.min(10, Math.floor(days / 14)),
    severity: 'medel',
    title: 'Lång tid sedan omstart',
    explanation: 'macOS har varit igång länge utan omstart. Med tiden samlar systemet på sig minne som inte lämnas tillbaka och processer som hängt sig, och det gör datorn segare.',
    evidence: `Igång i ${days} dagar (gränsen är ${RULES.uptime_days} dagar).`,
    numbers: { uptime_days: u.uptime_days, limit_days: RULES.uptime_days },
    actions: ['Starta om datorn (Apple-menyn > Starta om). Det är det enklaste som brukar göra mest skillnad.'],
  };
}

function memoryRule(o, top) {
  const m = o.memory;
  if (m.grade === GRADE.UNKNOWN) return { status: 'okänd' };
  const swapGB = typeof m.swap_used_gb === 'number' ? m.swap_used_gb : null;
  const level = m.pressure_level;
  const pressureHigh = level === 'varning' || level === 'kritisk';
  const swapHigh = swapGB !== null && swapGB * GB > RULES.swap_bytes;
  if (!pressureHigh && !swapHigh) return { status: 'ok', value: [level ? `minnestryck ${level}` : null, swapGB !== null ? `swap ${num(swapGB)} GB` : null].filter(Boolean).join(', ') };

  const apps = top && top.apps ? top.apps.slice(0, 3) : [];
  const appText = apps.length ? apps.map((a) => `${a.name}${a.label && !a.name.toLowerCase().includes(a.label.toLowerCase()) ? ` (${a.label})` : ''} ${sizeText(a.memory_mb)}`).join(', ') : null;
  const facts = [
    level ? `Minnestryck: ${level}.` : null,
    swapGB !== null ? `${num(swapGB)} GB swap används (gränsen är ${RULES.swap_bytes / GB} GB).` : null,
    typeof m.free_percent === 'number' ? `${m.free_percent} % av minnet ledigt.` : null,
    typeof m.total_gb === 'number' ? `Macen har ${num(m.total_gb)} GB minne.` : null,
  ].filter(Boolean);
  const critical = level === 'kritisk';
  return {
    kind: 'memory_pressure',
    score: (critical ? 90 : pressureHigh ? 72 : 65) + (pressureHigh && swapHigh ? 3 : 0),
    severity: critical ? 'hög' : 'medel',
    title: 'För lite minne för det som är öppet',
    explanation: 'Minnet räcker inte till allt som är igång. macOS packar ihop minne och flyttar ut delar till disken (swap), och det är mycket långsammare än vanligt minne.'
      + (appText ? ` Mest minne tar just nu: ${appText}.` : ''),
    evidence: facts.join(' '),
    numbers: { pressure_level: level, swap_used_gb: swapGB, free_percent: m.free_percent, total_gb: m.total_gb },
    top_memory_apps: apps.map((a) => ({ name: a.name, label: a.label, memory_mb: a.memory_mb, processes: a.processes })),
    actions: [
      apps.length ? `Stäng program och flikar du inte använder, särskilt de som tar mest minne (${apps.map((a) => a.name).join(', ')}).` : 'Stäng program och flikar du inte använder.',
      'En omstart tömmer swap och ger en ren start.',
    ],
  };
}

function diskRule(o, disk) {
  const d = o.disk;
  if (typeof d.free_percent !== 'number') return { status: 'okänd' };
  if (!(d.free_percent < RULES.disk_free_percent)) return { status: 'ok', value: `${d.free_percent} % ledigt` };
  const folders = disk && disk.largest_home_folders ? disk.largest_home_folders.slice(0, 5) : [];
  return {
    kind: 'disk_full',
    score: d.free_percent < 5 ? 95 : 85,
    severity: 'hög',
    title: 'Disken är nästan full',
    explanation: 'När disken nästan är full får macOS svårt att skapa swap och cache, och uppdateringar kan misslyckas. Datorn blir märkbart segare.'
      + (folders.length ? ` Största mapparna i hemkatalogen: ${folders.map((f) => `${f.path} ${sizeText(f.size_mb)}`).join(', ')}.` : ''),
    evidence: `${num(d.free_gb)} GB ledigt av ${num(d.total_gb)} GB (${d.free_percent} %, gränsen är ${RULES.disk_free_percent} %).`,
    numbers: { free_percent: d.free_percent, free_gb: d.free_gb, total_gb: d.total_gb, limit_percent: RULES.disk_free_percent },
    largest_home_folders: folders,
    actions: [
      'Töm papperskorgen och gå igenom Hämtade filer.',
      'Se Systeminställningar > Allmänt > Lagring för förslag på vad som tar plats.',
      ...(folders.length ? [`Börja med de största mapparna (${folders.slice(0, 3).map((f) => f.path).join(', ')}). Mac Health raderar aldrig något själv.`] : []),
    ],
  };
}

function spotlightRule(procs) {
  if (!procs) return { status: 'okänd' };
  const hits = procs.filter((x) => SPOTLIGHT.test(x.name));
  const total = round1(hits.reduce((a, x) => a + x.top_cpu, 0));
  if (!(total > RULES.spotlight_cpu_percent)) return { status: 'ok', value: `${num(total)} % CPU` };
  return {
    kind: 'spotlight_indexing',
    score: 50,
    severity: 'låg',
    title: 'Spotlight indexerar',
    explanation: 'Spotlight går igenom filer så att sökningen fungerar. Det händer efter en macOS-uppdatering eller när många nya filer har tillkommit, och brukar gå över av sig självt.',
    evidence: `Spotlight-processerna (mds_stores, mdworker) använder tillsammans ${num(total)} % CPU (gränsen är ${RULES.spotlight_cpu_percent} %).`,
    numbers: { cpu_percent: total, processes: hits.length, limit_percent: RULES.spotlight_cpu_percent },
    actions: ['Låt datorn vara på, gärna med laddaren inkopplad, så blir indexeringen klar.', 'Om det håller på i flera dagar: starta om datorn.'],
    covers: hits.map((x) => x.pid),
  };
}

function heatRule(o, procs) {
  if (!procs) return { status: 'okänd' };
  const kt = procs.find((x) => x.pid === 0 || x.name === 'kernel_task');
  const cpu = kt ? round1(kt.top_cpu) : 0;
  const t = o.thermal;
  const warm = t.grade === GRADE.OK || t.grade === GRADE.BAD;
  if (!(cpu > RULES.kernel_task_cpu_percent && warm)) {
    return { status: t.grade === GRADE.UNKNOWN ? 'okänd' : 'ok', value: `kernel_task ${num(cpu)} % CPU, ${warm ? 'värmevarning' : 'ingen värmevarning'}` };
  }
  const limit = t.cpu_speed_limit_percent;
  return {
    kind: 'thermal',
    score: t.grade === GRADE.BAD ? 88 : 80,
    severity: 'hög',
    title: 'Macen kyler sig själv genom att bromsa',
    explanation: 'Datorn är varm. macOS låter då kernel_task ta processortid och sänker hastigheten så att den inte blir för het, och då känns allt långsamt.',
    evidence: `kernel_task använder ${num(cpu)} % CPU och macOS rapporterar värmevarning${typeof limit === 'number' ? ` (processorn begränsad till ${limit} %)` : ''}.`,
    numbers: { kernel_task_cpu_percent: cpu, cpu_speed_limit_percent: limit, thermal_warning_level: t.thermal_warning_level },
    actions: ['Ställ datorn på ett hårt underlag så att luften kommer åt, inte i knät eller på en kudde.', 'Stäng tunga program och låt den svalna en stund.'],
    covers: kt ? [kt.pid] : [],
  };
}

function processRules(procs, covered) {
  if (!procs) return { status: 'okänd', causes: [] };
  const hasPs = procs.some((x) => typeof x.ps_cpu === 'number');
  const hot = procs
    .filter((x) => !covered.has(x.pid) && x.top_cpu > RULES.process_cpu_percent && (!hasPs || (typeof x.ps_cpu === 'number' && x.ps_cpu > RULES.process_cpu_percent)))
    .sort((a, b) => b.top_cpu - a.top_cpu);
  const causes = hot.slice(0, RULES.max_process_causes).map((x) => {
    const l = label(x.name, x.app);
    const who = x.app && x.app !== x.name ? `${x.name} (${x.app})` : x.name;
    const both = typeof x.ps_cpu === 'number';
    return {
      kind: 'busy_process',
      score: 70 + Math.min(10, Math.floor(x.top_cpu / 50)),
      severity: 'medel',
      title: `${who} drar mycket processorkraft`,
      explanation: (l.explanation ? `${l.label}: ${l.explanation}` : 'Ingen förklaring finns i ordlistan för det här programmet.')
        + ' När ett program drar så mycket hela tiden blir det mindre kvar till allt annat.',
      evidence: both
        ? `${num(round1(x.top_cpu))} % CPU just nu och ${num(round1(x.ps_cpu))} % i snitt den senaste minuten (gränsen är ${RULES.process_cpu_percent} % i båda mätningarna; 100 % = en hel kärna).`
        : `${num(round1(x.top_cpu))} % CPU just nu (gränsen är ${RULES.process_cpu_percent} %; 100 % = en hel kärna). Bara en mätning fanns.`,
      numbers: { name: x.name, app: x.app && x.app !== x.name ? x.app : null, cpu_percent_now: round1(x.top_cpu), cpu_percent_last_minute: both ? round1(x.ps_cpu) : null, memory_mb: Math.round(x.mem_bytes / MB), limit_percent: RULES.process_cpu_percent },
      label: l.label,
      actions: [
        x.app || !l.label
          ? `Om du inte behöver ${x.app || x.name} just nu: avsluta det på vanligt sätt. Fortsätter det, titta i Aktivitetskontroll (CPU-fliken).`
          : `Det här är en bakgrundstjänst${l.label ? ` (${l.label})` : ''}. Ofta lugnar den sig av sig själv; annars kan en omstart hjälpa. Kontrollera gärna programmets egna inställningar.`,
      ],
    };
  });
  return {
    status: causes.length ? 'utlöst' : 'ok',
    value: hot.length ? `${hot.length} process(er) över ${RULES.process_cpu_percent} %` : 'ingen process över gränsen',
    causes,
    note: hasPs ? null : 'CPU kunde bara mätas en gång (ps saknade %cpu), så regeln för enskilda processer bygger på en mätning.',
  };
}

function batteryRule(o) {
  const b = o.battery;
  if (b.present === false) return { status: 'ej aktuell', value: 'inget batteri' };
  if (typeof b.health_percent !== 'number') return { status: 'okänd' };
  if (!(b.health_percent < RULES.battery_health_percent)) return { status: 'ok', value: `hälsa ${b.health_percent} %` };
  return {
    kind: 'worn_battery',
    score: 30,
    severity: 'låg',
    title: 'Slitet batteri',
    explanation: 'Batteriet rymmer klart mindre än när det var nytt. Det märks mest som kortare batteritid, men ett slitet batteri kan också göra att macOS sänker prestandan för att skydda det.',
    evidence: `Batterihälsa ${b.health_percent} %${typeof b.cycle_count === 'number' ? `, ${b.cycle_count} laddcykler` : ''} (Apple rekommenderar service under ${RULES.battery_health_percent} %).`,
    numbers: { health_percent: b.health_percent, cycle_count: b.cycle_count, limit_percent: RULES.battery_health_percent },
    actions: ['Kontrollera under Systeminställningar > Batteri > Batterihälsa och boka service hos Apple om det står "Service rekommenderas".'],
  };
}

/**
 * Startup items from third parties (launchd folders, read by collectStartup and parsed by
 * buildStartupItems, the same as startup_items). Only a count and at most three names leave
 * this rule: never folders, paths or user names.
 */
function startupName(label) {
  // Defensive: a name is a file name, so keep only the last part and let privacy.js remove home paths.
  const name = scrubString(String(label).split('/').pop());
  return name.replace(/\s+/g, ' ').trim();
}

function startupRule(startup) {
  if (!startup || !Array.isArray(startup.dirs) || !startup.dirs.length) return { status: 'okänd' };
  const r = buildStartupItems(startup);
  const readable = r.folders.some((f) => f.count !== null);
  if (!readable) return { status: 'okänd' };
  const third = r.items.filter((i) => i.maker === 'tredjepart');
  // A folder that exists but could not be read may hide items, so a low count is not proof that all is fine.
  const partly = startup.dirs.some((d) => !d.files && d.error !== 'missing');
  if (third.length < RULES.startup_third_party) {
    return partly ? { status: 'okänd' } : { status: 'ok', value: `${third.length} från tredjepart` };
  }
  const names = [...new Set(third.map((i) => startupName(i.label)).filter(Boolean))].slice(0, RULES.startup_names_shown);
  return {
    kind: 'many_startup_items',
    score: 40 + Math.min(5, Math.floor((third.length - RULES.startup_third_party) / 10)),
    severity: 'låg',
    title: 'Många program startar automatiskt',
    explanation: 'Många program från andra tillverkare än Apple startar av sig själva och ligger kvar i bakgrunden. Var och en tar lite minne och processorkraft, och tillsammans kan de göra att datorn startar långsamt och känns segare. Ofta är det rester från program som inte används längre.',
    evidence: `${third.length} startobjekt från tredjepart (gränsen är ${RULES.startup_third_party}).${names.length ? ` Till exempel: ${names.join(', ')}.` : ''}`,
    numbers: { third_party: third.length, apple: r.apple, limit: RULES.startup_third_party, examples: names },
    actions: [
      'Fråga efter startup_items för att se hela listan, märkt Apple eller tredjepart.',
      'Stäng av det du inte behöver under Systeminställningar > Allmänt > Inloggningsobjekt, eller avinstallera programmet på vanligt sätt. Mac Health ändrar eller raderar aldrig något.',
    ],
  };
}

/** True when free disk is under the limit, so the caller knows whether to measure folders (du is slow). */
function needsDiskFolders(dfText) {
  const d = p.parseDf(dfText);
  if (!d || !d.total_bytes) return false;
  return Math.round((d.available_bytes / d.total_bytes) * 100) < RULES.disk_free_percent;
}

const CHECK_NAMES = {
  uptime: 'Drifttid', memory: 'Minne och swap', disk: 'Ledig disk', process: 'Enskild process med hög CPU',
  spotlight: 'Spotlight', heat: 'Värme (kernel_task)', battery: 'Batterihälsa', startup: 'Startobjekt',
};

/**
 * @param {object} raw  { sysctl, sw_vers, uptime, memory_pressure, vm_stat, df, pmset_batt, pmset_therm,
 *                        ioreg_battery, top, ps, startup?, du_stdout?, du_stderr?, home?, du_unfinished? }
 *                      startup: { dirs } from collectStartup (missing or unreadable gives "okänd")
 * @param {object} opts { now, failures, duTimedOut }
 */
function buildDiagnosis(raw = {}, { now = Date.now(), failures = {}, duTimedOut = false } = {}) {
  const o = buildOverview(raw, { now });
  const procs = processList(raw);
  const top = procs ? buildTopProcesses({ top: raw.top, ps: raw.ps }, { limit: 10 }) : null;
  const disk = raw.du_stdout !== undefined || raw.du_stderr !== undefined ? buildDiskReport(raw, { duTimedOut }) : null;

  const results = {
    uptime: uptimeRule(o),
    memory: memoryRule(o, top),
    disk: diskRule(o, disk),
    spotlight: spotlightRule(procs),
    heat: heatRule(o, procs),
  };
  const covered = new Set([...(results.spotlight.covers || []), ...(results.heat.covers || [])]);
  const proc = processRules(procs, covered);
  results.battery = batteryRule(o);
  results.startup = startupRule(raw.startup);

  let causes = [results.uptime, results.memory, results.disk, results.spotlight, results.heat, ...proc.causes, results.battery, results.startup]
    .filter((c) => c && c.kind);
  causes.sort((a, b) => b.score - a.score);
  causes = causes.map(({ score, covers, ...c }, i) => ({ rank: i + 1, ...c }));

  const checks = Object.entries(CHECK_NAMES).map(([key, name]) => {
    const r = key === 'process' ? proc : results[key];
    const status = key === 'process' ? proc.status : r.kind ? 'utlöst' : r.status;
    return { check: name, status, value: r.value || (r.evidence || null) };
  });

  const notes = Object.entries(failures).map(([k, why]) => `Kommandot för "${k}" ${why}.`);
  if (proc.note) notes.push(proc.note);
  if (disk) notes.push(...disk.notes);
  const unknown = checks.filter((c) => c.status === 'okänd').map((c) => c.check);
  if (unknown.length) notes.push(`Kunde inte kontrollera: ${unknown.join(', ')}.`);

  const ok = checks.filter((c) => c.status === 'ok').map((c) => c.check);
  const untested = unknown.length ? ` Kunde inte kontrollera: ${listText(unknown)}.` : '';
  let summary;
  let advice;
  if (causes.length) {
    summary = `Hittade ${causes.length} trolig${causes.length === 1 ? '' : 'a'} orsak${causes.length === 1 ? '' : 'er'} till att Macen kan kännas seg. Den mest troliga: ${causes[0].title.toLowerCase()}.${untested}`;
    advice = 'Det här är troliga orsaker, inte säkra. Börja med den första. Mac Health ändrar, stänger eller raderar aldrig något.';
  } else if (!ok.length) {
    summary = 'Macen gick inte att undersöka just nu: inga av kontrollerna kunde göras, så det går inte att säga om något gör den seg.';
    advice = 'Försök igen om en stund. Se anteckningarna för vad som inte gick att kontrollera.';
  } else if (unknown.length) {
    summary = `Hittade inget som tyder på att Macen borde vara seg bland det som gick att kontrollera. ${listText(ok)} ser bra ut.${untested}`;
    advice = 'Allt kunde inte kontrolleras, så svaret är ofullständigt. Försök gärna igen om en stund. Känns datorn seg kan du också fråga efter top_processes när det händer.';
  } else {
    summary = `Hittade inget som tyder på att Macen borde vara seg just nu. ${listText(ok)} ser bra ut.`;
    advice = 'Känns datorn ändå seg kan det vara ett enskilt program eller webbsidor. Fråga gärna efter top_processes när det händer.';
  }

  return {
    checked_at: new Date(now).toISOString(),
    found: causes.length,
    summary,
    likely_causes: causes,
    checks,
    advice,
    notes,
  };
}

function summarizeDiagnosis(d) {
  const out = [d.summary];
  if (d.likely_causes.length) out.push('', 'Troliga orsaker (mest trolig först):');
  for (const c of d.likely_causes) {
    out.push(`${c.rank}. ${c.title} [${c.severity}]`);
    out.push(`   Siffror: ${c.evidence}`);
    out.push(`   Varför: ${c.explanation}`);
    for (const a of c.actions) out.push(`   Gör så här: ${a}`);
  }
  const ok = d.checks.filter((c) => c.status === 'ok');
  if (ok.length) out.push('', `Ser bra ut: ${ok.map((c) => `${c.check}${c.value ? ` (${c.value})` : ''}`).join('; ')}.`);
  out.push('', d.advice);
  for (const n of d.notes || []) out.push(`Obs: ${n}`);
  return out.join('\n');
}

module.exports = { buildDiagnosis, summarizeDiagnosis, needsDiskFolders, RULES };
