'use strict';
/**
 * Builds the get_mac_overview answer from raw command output.
 * Pure: takes { sysctl, sw_vers, uptime, memory_pressure, vm_stat, df, pmset_batt, pmset_therm, ioreg_battery }
 * (each a string, or null when the command was missing/failed) plus `now`, and returns plain data.
 */

const p = require('./parse');

const GRADE = { GOOD: 'Bra', OK: 'Okej', BAD: 'Behöver åtgärd', UNKNOWN: 'Okänd' };
const RANK = { [GRADE.GOOD]: 0, [GRADE.OK]: 1, [GRADE.BAD]: 2 };

// Thresholds in one place so they are easy to review and tune.
const LIMITS = {
  uptime_ok_days: 7, // under this: Bra
  uptime_bad_days: 14, // from this: Behöver åtgärd
  cpu_ok_ratio: 0.7, // 1-min load per logical core
  cpu_bad_ratio: 1.0,
  mem_free_ok_percent: 20,
  mem_free_bad_percent: 10,
  swap_ok_bytes: 2 * 1024 ** 3,
  disk_free_ok_percent: 20,
  disk_free_bad_percent: 10,
  battery_health_ok_percent: 85,
  battery_health_bad_percent: 80,
  battery_cycles_bad: 1000,
};

const GB = 1024 ** 3;
const round1 = (n) => Math.round(n * 10) / 10;
const toGB = (b) => (typeof b === 'number' ? round1(b / GB) : null);

function unknown(reason) {
  return { grade: GRADE.UNKNOWN, summary: reason || 'Kunde inte läsas.' };
}

function formatDuration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} ${d === 1 ? 'dag' : 'dagar'} ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

function modelSection(sys, memTotal) {
  const model = sys['hw.model'] || null;
  const chip = sys['machdep.cpu.brand_string'] || null;
  const cores = Number(sys['hw.ncpu']) || null;
  const mem = Number(sys['hw.memsize']) || memTotal || null;
  if (!model && !chip) return unknown('Kunde inte läsa modell (sysctl).');
  return {
    model_identifier: model,
    chip,
    cpu_cores: cores,
    memory_gb: toGB(mem),
    summary: [model, chip, cores ? `${cores} kärnor` : null, mem ? `${toGB(mem)} GB minne` : null].filter(Boolean).join(', '),
  };
}

function macosSection(swText) {
  const v = p.parseSwVers(swText);
  if (!v) return unknown('Kunde inte läsa macOS-version (sw_vers).');
  return { ...v, summary: `${v.product_name} ${v.version}${v.build ? ` (${v.build})` : ''}` };
}

function uptimeSection(sys, uptimeText, now) {
  let seconds = null;
  let source = null;
  const boot = p.parseBoottime(sys['kern.boottime']);
  if (boot) { seconds = Math.max(0, Math.floor(now / 1000) - boot); source = 'sysctl kern.boottime'; }
  if (seconds === null) {
    const u = p.parseUptime(uptimeText);
    if (u && u.uptime_seconds !== null) { seconds = u.uptime_seconds; source = 'uptime'; }
  }
  if (seconds === null) return unknown('Kunde inte läsa drifttid.');
  const days = round1(seconds / 86400);
  let grade = GRADE.GOOD;
  let advice = null;
  if (days >= LIMITS.uptime_bad_days) {
    grade = GRADE.BAD;
    advice = 'Starta om datorn – efter lång drifttid samlar macOS på sig minnesläckor och processer som hängt sig.';
  } else if (days >= LIMITS.uptime_ok_days) {
    grade = GRADE.OK;
    advice = 'En omstart snart kan göra Macen snabbare.';
  }
  return { grade, uptime_seconds: seconds, uptime_days: days, source, summary: `Igång i ${formatDuration(seconds)}`, advice };
}

function cpuSection(sys, uptimeText) {
  let load = p.parseLoadavg(sys['vm.loadavg']);
  if (!load) { const u = p.parseUptime(uptimeText); load = u && u.load_average; }
  const cores = Number(sys['hw.ncpu']) || null;
  if (!load) return unknown('Kunde inte läsa CPU-last.');
  const ratio = cores ? load[0] / cores : null;
  let grade = GRADE.UNKNOWN;
  let advice = null;
  if (ratio !== null) {
    if (ratio >= LIMITS.cpu_bad_ratio) {
      grade = GRADE.BAD;
      advice = 'Processorn är fullt upptagen. Något program drar mycket – kolla Aktivitetskontroll (CPU-fliken).';
    } else if (ratio >= LIMITS.cpu_ok_ratio) {
      grade = GRADE.OK;
      advice = 'Processorn har ganska mycket att göra just nu.';
    } else grade = GRADE.GOOD;
  }
  return {
    grade,
    load_average_1_5_15: load,
    cpu_cores: cores,
    load_per_core: ratio !== null ? Math.round(ratio * 100) / 100 : null,
    summary: `Last ${load[0].toFixed(2)} (1 min) på ${cores ?? '?'} kärnor${ratio !== null ? ` = ${Math.round(ratio * 100)} % av kapaciteten` : ''}`,
    advice,
  };
}

const PRESSURE_LEVEL = { 1: 'normal', 2: 'varning', 4: 'kritisk' };

function memorySection(sys, mpText, vmText) {
  const mp = p.parseMemoryPressure(mpText);
  const vm = p.parseVmStat(vmText);
  const swap = p.parseSwapusage(sys['vm.swapusage']);
  const levelNum = Number(sys['kern.memorystatus_vm_pressure_level']) || null;
  const level = levelNum ? (PRESSURE_LEVEL[levelNum] || `nivå ${levelNum}`) : null;
  const total = Number(sys['hw.memsize']) || (mp && mp.total_bytes) || null;
  if (!mp && !vm && !swap && !level) return unknown('Kunde inte läsa minnet (memory_pressure, vm_stat, sysctl).');

  let breakdown = null;
  if (vm) {
    const pg = (k) => (typeof vm.pages[k] === 'number' ? toGB(vm.pages[k] * vm.page_size) : null);
    breakdown = {
      free_gb: pg('free'),
      active_gb: pg('active'),
      inactive_gb: pg('inactive'),
      wired_gb: pg('wired_down'),
      compressed_gb: pg('occupied_by_compressor'),
      file_cache_gb: pg('file_backed_pages'),
    };
  }
  const free = mp ? mp.free_percent : null;
  const swapUsed = swap ? swap.used_bytes : null;

  let grade = GRADE.GOOD;
  const reasons = [];
  if (levelNum === 4 || (free !== null && free < LIMITS.mem_free_bad_percent)) {
    grade = GRADE.BAD;
    reasons.push(levelNum === 4 ? 'minnestrycket är kritiskt' : `bara ${free} % minne ledigt`);
  } else {
    if (levelNum === 2) reasons.push('macOS rapporterar förhöjt minnestryck');
    if (free !== null && free < LIMITS.mem_free_ok_percent) reasons.push(`bara ${free} % minne ledigt`);
    if (swapUsed !== null && swapUsed > LIMITS.swap_ok_bytes) reasons.push(`${toGB(swapUsed)} GB används som swap på disken`);
    if (reasons.length) grade = GRADE.OK;
  }
  if (free === null && !level && swapUsed === null) grade = GRADE.UNKNOWN;
  const advice = grade === GRADE.BAD
    ? 'För lite minne för det som är öppet. Stäng program eller flikar du inte använder.'
    : grade === GRADE.OK ? 'Minnet är ansträngt – stäng gärna program du inte använder.' : null;

  return {
    grade,
    pressure_level: level,
    free_percent: free,
    total_gb: toGB(total),
    swap_used_gb: toGB(swapUsed),
    swap_total_gb: swap ? toGB(swap.total_bytes) : null,
    breakdown,
    summary: [
      free !== null ? `${free} % ledigt` : null,
      level ? `minnestryck ${level}` : null,
      swapUsed !== null ? `swap ${toGB(swapUsed)} GB` : null,
    ].filter(Boolean).join(', ') + (reasons.length ? ` (${reasons.join('; ')})` : ''),
    advice,
  };
}

function diskSection(dfText) {
  const d = p.parseDf(dfText);
  if (!d || !d.total_bytes) return unknown('Kunde inte läsa disken (df).');
  // On APFS "Used" for / only counts the system volume, so derive used from total - available.
  const freePct = Math.round((d.available_bytes / d.total_bytes) * 100);
  let grade = GRADE.GOOD;
  let advice = null;
  if (freePct < LIMITS.disk_free_bad_percent) {
    grade = GRADE.BAD;
    advice = 'Disken är nästan full – macOS blir segt när det inte finns plats för swap och cache. Frigör utrymme.';
  } else if (freePct < LIMITS.disk_free_ok_percent) {
    grade = GRADE.OK;
    advice = 'Det börjar bli trångt på disken. Håll gärna minst 15–20 % ledigt.';
  }
  return {
    grade,
    mount: d.mount,
    free_gb: toGB(d.available_bytes),
    total_gb: toGB(d.total_bytes),
    free_percent: freePct,
    summary: `${toGB(d.available_bytes)} GB ledigt av ${toGB(d.total_bytes)} GB (${freePct} %)`,
    advice,
  };
}

const BATTERY_STATE_SV = {
  charging: 'laddar', discharging: 'laddar ur', charged: 'fulladdat',
  'finishing charge': 'slutför laddning', 'AC attached': 'nätadapter ansluten',
};

function batterySection(battText, ioregText) {
  const b = p.parsePmsetBatt(battText);
  const io = p.parseIoregBattery(ioregText);
  if (!b && !io) return unknown('Kunde inte läsa batteriet (pmset, ioreg).');
  const present = Boolean((b && b.present) || (io && io.installed));
  if (!present) {
    return { grade: null, present: false, power_source: b ? b.power_source : null, summary: 'Inget batteri (stationär Mac).', advice: null };
  }
  const health = io ? io.health_percent : null;
  const cycles = io ? io.cycle_count : null;
  let grade = health === null ? GRADE.UNKNOWN : GRADE.GOOD;
  let advice = null;
  if ((io && io.permanent_failure) || (health !== null && health < LIMITS.battery_health_bad_percent)
    || (cycles !== null && cycles >= LIMITS.battery_cycles_bad)) {
    grade = GRADE.BAD;
    advice = 'Batteriet är slitet – Apple rekommenderar service när kapaciteten är under 80 %.';
  } else if (health !== null && health < LIMITS.battery_health_ok_percent) {
    grade = GRADE.OK;
    advice = 'Batteriet har börjat slitas men fungerar fortfarande bra.';
  }
  const pct = b ? b.percent : null;
  return {
    grade,
    present: true,
    charge_percent: pct,
    state: b ? b.state : null,
    power_source: b ? b.power_source : null,
    time_remaining_minutes: b ? b.time_remaining_minutes : null,
    health_percent: health,
    cycle_count: cycles,
    temperature_c: io ? io.temperature_c : null,
    summary: [
      pct !== null ? `${pct} % laddat` : null,
      b && b.state ? (BATTERY_STATE_SV[b.state] || b.state) : null,
      health !== null ? `hälsa ${health} %` : null,
      cycles !== null ? `${cycles} laddcykler` : null,
    ].filter(Boolean).join(', '),
    advice,
  };
}

function thermalSection(thermText, ioregText) {
  const t = p.parsePmsetTherm(thermText);
  if (!t) return unknown('Kunde inte läsa värmestatus (pmset -g therm).');
  const io = p.parseIoregBattery(ioregText);
  const limit = t.cpu_speed_limit;
  let grade = GRADE.GOOD;
  let advice = null;
  if (limit !== null && limit < 80) {
    grade = GRADE.BAD;
    advice = `Macen bromsar processorn till ${limit} % för att kyla sig. Ge den luft, stäng tunga program.`;
  } else if ((limit !== null && limit < 100) || (t.thermal_warning_level || 0) > 0 || (t.performance_warning_level || 0) > 0) {
    grade = GRADE.OK;
    advice = 'Macen har registrerat värmevarning och kan bromsa lite.';
  } else if (t.thermal_warning_level === null && limit === null) {
    grade = GRADE.UNKNOWN;
  }
  return {
    grade,
    thermal_warning_level: t.thermal_warning_level,
    performance_warning_level: t.performance_warning_level,
    cpu_speed_limit_percent: limit,
    battery_temperature_c: io ? io.temperature_c : null,
    summary: grade === GRADE.GOOD ? 'Ingen värmevarning – processorn bromsas inte.'
      : limit !== null ? `Processorn begränsad till ${limit} %` : `Värmevarningsnivå ${t.thermal_warning_level ?? '?'}`,
    advice,
  };
}

/**
 * @param {object} raw  command output per key (string or null)
 * @param {object} [opts] { now: ms since epoch, failures: { key: reason } }
 */
function buildOverview(raw = {}, { now = Date.now(), failures = {} } = {}) {
  const sys = p.parseSysctl(raw.sysctl);
  const mp = p.parseMemoryPressure(raw.memory_pressure);
  const sections = {
    model: modelSection(sys, mp && mp.total_bytes),
    macos: macosSection(raw.sw_vers),
    uptime: uptimeSection(sys, raw.uptime, now),
    cpu: cpuSection(sys, raw.uptime),
    memory: memorySection(sys, raw.memory_pressure, raw.vm_stat),
    disk: diskSection(raw.df),
    battery: batterySection(raw.pmset_batt, raw.ioreg_battery),
    thermal: thermalSection(raw.pmset_therm, raw.ioreg_battery),
  };

  const graded = ['uptime', 'cpu', 'memory', 'disk', 'battery', 'thermal']
    .map((k) => [k, sections[k].grade])
    .filter(([, g]) => g in RANK);
  const worst = graded.reduce((acc, [, g]) => (RANK[g] > RANK[acc] ? g : acc), GRADE.GOOD);
  const needs = graded.filter(([, g]) => g === GRADE.BAD).map(([k]) => k);
  const ok = graded.filter(([, g]) => g === GRADE.OK).map(([k]) => k);
  const unknownParts = Object.entries(sections).filter(([, s]) => s.grade === GRADE.UNKNOWN).map(([k]) => k);

  const notes = Object.entries(failures).map(([k, why]) => `Kommandot för "${k}" ${why}.`);
  if (unknownParts.length) notes.push(`Kunde inte bedöma: ${unknownParts.join(', ')}.`);

  return {
    checked_at: new Date(now).toISOString(),
    overall_grade: graded.length ? worst : GRADE.UNKNOWN,
    needs_attention: needs,
    could_be_better: ok,
    ...sections,
    notes,
  };
}

const LABELS = { model: 'Modell', macos: 'macOS', uptime: 'Drifttid', cpu: 'CPU', memory: 'Minne', disk: 'Disk', battery: 'Batteri', thermal: 'Värme' };

function summarizeOverview(o) {
  const out = [`Mac-hälsa: ${o.overall_grade}`];
  for (const k of Object.keys(LABELS)) {
    const s = o[k];
    if (!s) continue;
    const g = s.grade ? `[${s.grade}] ` : '';
    out.push(`- ${LABELS[k]}: ${g}${s.summary}${s.advice ? ` → ${s.advice}` : ''}`);
  }
  for (const n of o.notes || []) out.push(`Obs: ${n}`);
  return out.join('\n');
}

module.exports = { buildOverview, summarizeOverview, GRADE, LIMITS, formatDuration };
