'use strict';
/**
 * Builds the answers for top_processes, memory_report and disk_report from raw command output.
 * Pure functions (no commands run here), so they can be tested against fixtures on any OS.
 */

const p = require('./parse');
const { memorySection, diskSection, batterySection, thermalSection, GRADE, LIMITS, toGB } = require('./overview');
const { explainProcess } = require('./explain');

const MB = 1024 ** 2;
const toMB = (b) => (typeof b === 'number' ? Math.round(b / MB) : null);
const round1 = (n) => Math.round(n * 10) / 10;

function notesFrom(failures) {
  return Object.entries(failures || {}).map(([k, why]) => `Kommandot för "${k}" ${why}.`);
}

// ---------- top_processes ----------

// Our own measurement tools should not show up as "heavy" apps.
const SELF = new Set(['top', 'ps']);

function describe(name, app) {
  const e = explainProcess(name, app);
  return e ? { label: e.label, explanation: e.explain } : { label: null, explanation: null };
}

/**
 * @param {object} raw { top, ps }   @param {object} opts { limit, failures }
 */
function buildTopProcesses(raw = {}, { limit = 10, failures = {} } = {}) {
  const top = p.parseTop(raw.top);
  const names = p.parsePs(raw.ps);
  const notes = notesFrom(failures);
  if (!top || !top.processes.length) {
    return { grade: GRADE.UNKNOWN, summary: 'Kunde inte läsa processerna (top).', by_cpu: [], by_memory: [], apps: [], notes };
  }

  const procs = top.processes.map((t) => {
    const n = names.get(t.pid) || (t.pid === 0 ? { name: 'kernel_task', app: null } : { name: 'Okänd', app: null });
    return { pid: t.pid, name: n.name || 'Okänd', app: n.app, cpu_percent: t.cpu_percent, mem_bytes: t.mem_bytes };
  }).filter((x) => !SELF.has(x.name));

  const shape = (x) => ({
    name: x.name,
    app: x.app && x.app !== x.name ? x.app : null,
    cpu_percent: round1(x.cpu_percent),
    memory_mb: toMB(x.mem_bytes),
    ...describe(x.name, x.app),
  });

  const byCpu = [...procs].filter((x) => x.cpu_percent > 0).sort((a, b) => b.cpu_percent - a.cpu_percent).slice(0, limit).map(shape);
  const byMem = [...procs].sort((a, b) => b.mem_bytes - a.mem_bytes).slice(0, limit).map(shape);

  // Group helpers under their app (Chrome, Claude …) so "many small processes" adds up.
  const groups = new Map();
  for (const x of procs) {
    const key = x.app || x.name;
    const g = groups.get(key) || { name: key, processes: 0, cpu: 0, mem: 0 };
    g.processes++; g.cpu += x.cpu_percent; g.mem += x.mem_bytes;
    groups.set(key, g);
  }
  const apps = [...groups.values()].sort((a, b) => b.mem - a.mem).slice(0, limit).map((g) => ({
    name: g.name,
    processes: g.processes,
    cpu_percent: round1(g.cpu),
    memory_mb: toMB(g.mem),
    ...describe(g.name, null),
  }));

  const idle = top.cpu_usage ? top.cpu_usage.idle_percent : null;
  const busy = idle === null ? null : round1(100 - idle);
  let grade = GRADE.UNKNOWN;
  if (busy !== null) grade = busy >= 80 ? GRADE.BAD : busy >= 50 ? GRADE.OK : GRADE.GOOD;

  const heaviest = byCpu[0];
  const summary = [
    busy !== null ? `Processorn är ${busy} % upptagen` : 'Processorns totala last är okänd',
    heaviest ? `mest CPU: ${heaviest.label ? `${heaviest.name} (${heaviest.label})` : heaviest.name} ${heaviest.cpu_percent} %` : null,
    byMem[0] ? `mest minne: ${byMem[0].name} ${byMem[0].memory_mb} MB` : null,
  ].filter(Boolean).join(', ');

  return {
    grade,
    cpu_busy_percent: busy,
    cpu_usage: top.cpu_usage,
    by_cpu: byCpu,
    by_memory: byMem,
    apps,
    summary,
    advice: grade === GRADE.BAD ? 'Processorn är hårt belastad. Titta på apparna överst under by_cpu och stäng det du inte behöver.' : null,
    notes: [...notes, '100 % CPU motsvarar en hel processorkärna, så en process kan visa mer än 100 %.'],
  };
}

function summarizeTopProcesses(r) {
  const out = [`Processer: [${r.grade}] ${r.summary}`];
  const row = (x) => `  - ${x.name}${x.app ? ` (${x.app})` : ''}: ${x.cpu_percent} % CPU, ${x.memory_mb} MB${x.label ? ` – ${x.label}` : ''}`;
  if (r.by_cpu.length) out.push('Mest CPU:', ...r.by_cpu.slice(0, 5).map(row));
  if (r.by_memory.length) out.push('Mest minne:', ...r.by_memory.slice(0, 5).map(row));
  const explained = new Map();
  for (const x of [...r.by_cpu, ...r.by_memory]) if (x.label && !explained.has(x.label)) explained.set(x.label, x.explanation);
  for (const [label, text] of explained) out.push(`${label}: ${text}`);
  if (r.advice) out.push(`→ ${r.advice}`);
  for (const n of r.notes || []) out.push(`Obs: ${n}`);
  return out.join('\n');
}

// ---------- memory_report ----------

function buildMemoryReport(raw = {}, { failures = {} } = {}) {
  const sys = p.parseSysctl(raw.sysctl);
  const mem = memorySection(sys, raw.memory_pressure, raw.vm_stat);
  const notes = notesFrom(failures);
  const explanations = [];
  if (mem.pressure_level) {
    explanations.push({
      normal: 'Minnestryck normalt: det finns gott om minne för det som är öppet.',
      varning: 'Minnestryck varning: macOS måste jobba för att få minnet att räcka (komprimerar och använder swap). Datorn kan kännas seg.',
      kritisk: 'Minnestryck kritiskt: minnet räcker inte. Program kan bli långsamma eller stängas.',
    }[mem.pressure_level] || `Minnestryck: ${mem.pressure_level}.`);
  }
  const b = mem.breakdown || {};
  if (typeof b.compressed_gb === 'number') {
    explanations.push(`${b.compressed_gb} GB komprimerat: macOS packar ihop minne som inte används just nu i stället för att skriva det till disken. Det är normalt och snabbare än swap.`);
  }
  if (typeof mem.swap_used_gb === 'number') {
    explanations.push(mem.swap_used_gb > toGB(LIMITS.swap_ok_bytes)
      ? `${mem.swap_used_gb} GB swap: minne har flyttats ut till disken eftersom det inte fick plats. Mycket swap gör datorn långsammare och tyder på för lite minne för det du kör.`
      : `${mem.swap_used_gb} GB swap: lite eller ingen swap används. Bra.`);
  }
  if (typeof b.file_cache_gb === 'number') {
    explanations.push(`${b.file_cache_gb} GB filcache: kopior av filer som macOS sparar för att gå snabbare. Frigörs direkt när program behöver minnet.`);
  }
  return { ...mem, explanations, notes };
}

function summarizeMemoryReport(r) {
  const out = [`Minne: [${r.grade}] ${r.summary}`];
  for (const e of r.explanations || []) out.push(`- ${e}`);
  if (r.advice) out.push(`→ ${r.advice}`);
  for (const n of r.notes || []) out.push(`Obs: ${n}`);
  return out.join('\n');
}

// ---------- disk_report ----------

function buildDiskReport(raw = {}, { failures = {}, duTimedOut = false, limit = 10 } = {}) {
  const disk = diskSection(raw.df);
  const du = p.parseDu(raw.du_stdout, raw.du_stderr, raw.home);
  const notes = notesFrom(failures);
  const folders = du ? du.folders.slice(0, limit).map((f) => ({ path: f.path, size_gb: round1(f.bytes / 1024 ** 3), size_mb: Math.round(f.bytes / 1024 ** 2) })) : [];
  if (duTimedOut) {
    const left = Array.isArray(raw.du_unfinished) && raw.du_unfinished.length ? ` Hann inte mätas: ${raw.du_unfinished.join(', ')}.` : '';
    notes.push(`Mätningen av hemkatalogen tog för lång tid och avbröts. Listan visar bara de mappar som hann mätas.${left}`);
  }
  if (du && du.denied) notes.push(`${du.denied} mappar kunde inte läsas eftersom macOS skyddar dem (t.ex. Bilder-biblioteket och Mail). Storlekarna kan därför vara något för låga.`);
  if (du && du.other_errors) notes.push(`${du.other_errors} mappar gav andra läsfel.`);
  const homeTotal = du && typeof du.total_bytes === 'number' ? round1(du.total_bytes / 1024 ** 3) : null;
  return {
    ...disk,
    home_total_gb: homeTotal,
    largest_home_folders: folders,
    home_scan_complete: Boolean(du && !duTimedOut && du.total_bytes !== null),
    unmeasured_folders: duTimedOut && Array.isArray(raw.du_unfinished) ? raw.du_unfinished : [],
    notes,
  };
}

function summarizeDiskReport(r) {
  const out = [`Disk: [${r.grade}] ${r.summary}`];
  if (r.advice) out.push(`→ ${r.advice}`);
  if (r.largest_home_folders.length) {
    out.push(`Största mapparna i hemkatalogen${r.home_total_gb !== null ? ` (totalt ${r.home_total_gb} GB)` : ''}:`);
    for (const f of r.largest_home_folders) out.push(`  - ${f.path}: ${f.size_mb >= 1024 ? `${f.size_gb} GB` : `${f.size_mb} MB`}`);
  }
  out.push('Verktyget läser bara storlekar och raderar aldrig något.');
  for (const n of r.notes || []) out.push(`Obs: ${n}`);
  return out.join('\n');
}

// ---------- battery_report ----------

function buildBatteryReport(raw = {}, { failures = {} } = {}) {
  const b = batterySection(raw.pmset_batt, raw.ioreg_battery);
  const notes = notesFrom(failures);
  if (b.present === false) {
    return { ...b, summary: 'Den här Macen har inget batteri (stationär Mac), så det finns inget att kontrollera.', tips: [], notes };
  }
  const tips = [];
  if (b.present) {
    tips.push('Batterihälsa är hur mycket batteriet rymmer jämfört med när det var nytt. Under 80 % rekommenderar Apple service.');
    tips.push('Låt "Optimerad batteriladdning" vara på (Systeminställningar > Batteri) så slits batteriet långsammare.');
    if (typeof b.temperature_c === 'number' && b.temperature_c >= 35) tips.push(`Batteriet är ${b.temperature_c} °C. Värme sliter på batteriet – undvik att ladda i solen eller under täcke.`);
    if (typeof b.cycle_count === 'number') tips.push(`${b.cycle_count} laddcykler. Moderna MacBook-batterier är byggda för 1000 cykler.`);
  }
  return { ...b, tips, notes };
}

function summarizeBatteryReport(r) {
  const out = [`Batteri: ${r.grade ? `[${r.grade}] ` : ''}${r.summary}`];
  if (r.advice) out.push(`→ ${r.advice}`);
  for (const t of r.tips || []) out.push(`- ${t}`);
  for (const n of r.notes || []) out.push(`Obs: ${n}`);
  return out.join('\n');
}

// ---------- thermal_status ----------

function buildThermalStatus(raw = {}, { failures = {} } = {}) {
  const t = thermalSection(raw.pmset_therm, raw.ioreg_battery);
  const throttled = typeof t.cpu_speed_limit_percent === 'number' ? t.cpu_speed_limit_percent < 100 : null;
  return {
    ...t,
    throttled,
    explanation: 'När en Mac blir för varm sänker macOS processorns hastighet för att kyla ner den ("strypning"). Då känns datorn långsam.',
    notes: notesFrom(failures),
  };
}

function summarizeThermalStatus(r) {
  const out = [`Värme: [${r.grade}] ${r.summary}`];
  if (r.advice) out.push(`→ ${r.advice}`);
  out.push(r.explanation);
  for (const n of r.notes || []) out.push(`Obs: ${n}`);
  return out.join('\n');
}

// ---------- startup_items ----------

const DIR_ERROR_SV = { missing: 'finns inte (helt normalt)', denied: 'kunde inte läsas (macOS nekade åtkomst)', failed: 'kunde inte läsas' };
const DIR_KIND = {
  '~/Library/LaunchAgents': 'startar när du loggar in (bara för dig)',
  '/Library/LaunchAgents': 'startar när någon loggar in',
  '/Library/LaunchDaemons': 'startar med datorn, i bakgrunden',
};

/** @param {{dirs: Array<{dir: string, files: string[]|null, error: string|null}>}} raw */
function buildStartupItems(raw = {}) {
  const items = [];
  const folders = [];
  const notes = [];
  for (const d of (raw && raw.dirs) || []) {
    if (!d.files) {
      folders.push({ folder: d.dir, count: null, status: DIR_ERROR_SV[d.error] || DIR_ERROR_SV.failed });
      if (d.error !== 'missing') notes.push(`${d.dir} ${DIR_ERROR_SV[d.error] || DIR_ERROR_SV.failed}.`);
      continue;
    }
    const plists = d.files.filter((f) => /\.plist$/i.test(f) && !f.startsWith('.')).map((f) => f.split('/').pop()).sort();
    folders.push({ folder: d.dir, count: plists.length, status: 'läst' });
    for (const file of plists) {
      const label = file.replace(/\.plist$/i, '');
      const apple = /^com\.apple\./i.test(label);
      items.push({ label, file, folder: d.dir, when: DIR_KIND[d.dir] || null, maker: apple ? 'Apple' : 'tredjepart' });
    }
  }
  const third = items.filter((i) => i.maker === 'tredjepart').length;
  const apple = items.length - third;
  const readable = folders.some((f) => f.count !== null || f.status === DIR_ERROR_SV.missing);
  return {
    total: items.length,
    third_party: third,
    apple,
    folders,
    items,
    summary: readable ? `${items.length} saker startar automatiskt: ${third} från tredjepart, ${apple} från Apple.` : 'Kunde inte läsa startmapparna.',
    advice: third
      ? 'Tredjepartsposter kan vara rester från program du inte längre använder. Stäng av autostart under Systeminställningar > Allmänt > Inloggningsobjekt och tillägg, eller avinstallera programmet på vanligt sätt. Mac Health ändrar eller raderar aldrig något.'
      : null,
    notes,
  };
}

function summarizeStartupItems(r) {
  const out = [`Autostart: ${r.summary}`];
  for (const f of r.folders) {
    const list = r.items.filter((i) => i.folder === f.folder);
    out.push(`${f.folder}: ${f.count === null ? f.status : `${f.count} st`}${DIR_KIND[f.folder] ? ` – ${DIR_KIND[f.folder]}` : ''}`);
    for (const i of list) out.push(`  - ${i.label} (${i.maker})`);
  }
  if (r.advice) out.push(`→ ${r.advice}`);
  out.push('Verktyget läser bara listorna och ändrar eller raderar aldrig något.');
  for (const n of r.notes || []) out.push(`Obs: ${n}`);
  return out.join('\n');
}

module.exports = {
  buildBatteryReport, summarizeBatteryReport,
  buildThermalStatus, summarizeThermalStatus,
  buildStartupItems, summarizeStartupItems,
  buildTopProcesses, summarizeTopProcesses,
  buildMemoryReport, summarizeMemoryReport,
  buildDiskReport, summarizeDiskReport,
};
