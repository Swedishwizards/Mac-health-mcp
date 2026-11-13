'use strict';
/**
 * Pure parsers for the output of built-in macOS commands.
 * Every function takes plain text and returns plain data (or null when the
 * input is missing or unreadable), so they can be tested against fixtures on any OS.
 */

const num = (s) => {
  if (s === undefined || s === null) return null;
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

const lines = (text) => (typeof text === 'string' ? text.split(/\r?\n/) : []);

/** `sysctl a b c` -> { a: '...', b: '...' } (only "key: value" lines). */
function parseSysctl(text) {
  const out = {};
  for (const line of lines(text)) {
    const m = line.match(/^([a-z0-9_.]+):\s?(.*)$/i);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** kern.boottime value "{ sec = 1765194600, usec = 0 } Mon Dec  8 ..." -> epoch seconds. */
function parseBoottime(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/sec\s*=\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** vm.loadavg value "{ 4.30 4.14 3.89 }" -> [4.3, 4.14, 3.89]. */
function parseLoadavg(value) {
  if (typeof value !== 'string') return null;
  const nums = value.replace(/[{}]/g, ' ').trim().split(/\s+/).map(num).filter((n) => n !== null);
  return nums.length >= 3 ? nums.slice(0, 3) : null;
}

/** vm.swapusage "total = 4096.00M  used = 3277.25M  free = 818.75M  (encrypted)" -> bytes. */
function parseSwapusage(value) {
  if (typeof value !== 'string') return null;
  const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  const get = (k) => {
    const m = value.match(new RegExp(`${k}\\s*=\\s*([\\d.]+)([KMGT])`));
    return m ? Math.round(Number(m[1]) * unit[m[2]]) : null;
  };
  const total = get('total');
  if (total === null) return null;
  return { total_bytes: total, used_bytes: get('used'), free_bytes: get('free') };
}

/** `sw_vers` -> { product_name, version, build }. */
function parseSwVers(text) {
  const kv = {};
  for (const line of lines(text)) {
    const m = line.match(/^\s*(\w+):\s*(.+?)\s*$/);
    if (m) kv[m[1]] = m[2];
  }
  if (!kv.ProductVersion) return null;
  return { product_name: kv.ProductName || 'macOS', version: kv.ProductVersion, build: kv.BuildVersion || null };
}

/**
 * `uptime` -> { uptime_seconds, load_average }.
 * Handles "up 38 days, 21:10,", "up 3 days, 5 mins,", "up 2:05,", "up 17 mins," and "up 1 day, 3 hrs,".
 */
function parseUptime(text) {
  if (typeof text !== 'string' || !/\bup\b/.test(text)) return null;
  const upPart = text.split(/\bup\b/)[1].split(/\d+\s+users?|load averages?/)[0];
  let secs = 0;
  let matched = false;
  const days = upPart.match(/(\d+)\s+days?/);
  if (days) { secs += Number(days[1]) * 86400; matched = true; }
  const hm = upPart.match(/(\d+):(\d{2})/);
  if (hm) { secs += Number(hm[1]) * 3600 + Number(hm[2]) * 60; matched = true; }
  const hrs = upPart.match(/(\d+)\s+hrs?/);
  if (hrs) { secs += Number(hrs[1]) * 3600; matched = true; }
  const mins = upPart.match(/(\d+)\s+mins?/);
  if (mins) { secs += Number(mins[1]) * 60; matched = true; }
  const secsM = upPart.match(/(\d+)\s+secs?/);
  if (secsM) { secs += Number(secsM[1]); matched = true; }
  const la = text.match(/load averages?:\s*([\d.,]+)[,\s]+([\d.,]+)[,\s]+([\d.,]+)/);
  const load = la ? [la[1], la[2], la[3]].map((s) => num(s.replace(/,$/, ''))) : null;
  return { uptime_seconds: matched ? secs : null, load_average: load };
}

/** `memory_pressure -Q` -> { free_percent, total_bytes }. */
function parseMemoryPressure(text) {
  if (typeof text !== 'string') return null;
  const free = text.match(/free percentage:\s*(\d+)%/i);
  const total = text.match(/system has (\d+)/i);
  if (!free && !total) return null;
  return { free_percent: free ? Number(free[1]) : null, total_bytes: total ? Number(total[1]) : null };
}

/** `vm_stat` -> { page_size, pages: { free, active, ... } } with snake_case keys. */
function parseVmStat(text) {
  if (typeof text !== 'string') return null;
  const ps = text.match(/page size of (\d+) bytes/);
  const pages = {};
  for (const line of lines(text)) {
    const m = line.match(/^"?([A-Za-z][A-Za-z\- ]+?)"?:\s+(\d+)\.?\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase().replace(/^pages\s+/, '').replace(/[\s-]+/g, '_');
    pages[key] = Number(m[2]);
  }
  if (!ps || !Object.keys(pages).length) return null;
  return { page_size: Number(ps[1]), pages };
}

/** `df -k /` -> { total_bytes, used_bytes, available_bytes, capacity_percent, mount }. */
function parseDf(text) {
  const rows = lines(text).filter((l) => l.trim());
  if (rows.length < 2) return null;
  // The filesystem name can contain spaces; numbers follow it. Mount point is last and starts with "/".
  const m = rows[rows.length - 1].match(/\s(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%(?:\s+\d+\s+\d+\s+\d+%)?\s+(\/.*)$/);
  if (!m) return null;
  return {
    total_bytes: Number(m[1]) * 1024,
    used_bytes: Number(m[2]) * 1024,
    available_bytes: Number(m[3]) * 1024,
    capacity_percent: Number(m[4]),
    mount: m[5].trim(),
  };
}

/** `pmset -g batt` -> { power_source, present, percent, state, time_remaining_minutes }. */
function parsePmsetBatt(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const src = text.match(/drawing from '([^']+)'/);
  const line = lines(text).find((l) => /InternalBattery/.test(l));
  if (!src && !line) return null; // unreadable output: say nothing rather than "no battery"
  const out = { power_source: src ? src[1] : null, present: false, percent: null, state: null, time_remaining_minutes: null };
  if (!line) return out;
  out.present = !/present:\s*false/i.test(line);
  const pct = line.match(/(\d+)%/);
  if (pct) out.percent = Number(pct[1]);
  const st = line.match(/\d+%;\s*([^;]+);/);
  if (st) out.state = st[1].trim();
  const t = line.match(/;\s*(\d+):(\d{2})\s+remaining/);
  if (t) out.time_remaining_minutes = Number(t[1]) * 60 + Number(t[2]);
  return out;
}

/** `pmset -g therm` -> { thermal_warning_level, performance_warning_level, cpu_speed_limit, ... }. */
function parsePmsetTherm(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const out = {
    thermal_warning_level: null, // null = none recorded
    performance_warning_level: null,
    cpu_speed_limit: null,
    cpu_scheduler_limit: null,
    cpu_available_cpus: null,
  };
  const tw = text.match(/thermal warning level (?:set to|is)\s*(\d+)/i);
  if (tw) out.thermal_warning_level = Number(tw[1]);
  else if (/No thermal warning level/i.test(text)) out.thermal_warning_level = 0;
  const pw = text.match(/performance warning level (?:set to|is)\s*(\d+)/i);
  if (pw) out.performance_warning_level = Number(pw[1]);
  else if (/No performance warning level/i.test(text)) out.performance_warning_level = 0;
  const sp = text.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
  if (sp) out.cpu_speed_limit = Number(sp[1]);
  const sc = text.match(/CPU_Scheduler_Limit\s*=\s*(\d+)/);
  if (sc) out.cpu_scheduler_limit = Number(sc[1]);
  const ac = text.match(/CPU_Available_CPUs\s*=\s*(\d+)/);
  if (ac) out.cpu_available_cpus = Number(ac[1]);
  return out;
}

// Only these keys are ever read from ioreg. Everything else (Serial, ManufacturerData,
// DeviceName, nested BatteryData with UUID/serial, ...) is ignored on purpose.
const IOREG_BATTERY_KEYS = ['CycleCount', 'DesignCapacity', 'AppleRawMaxCapacity', 'NominalChargeCapacity',
  'MaxCapacity', 'CurrentCapacity', 'Temperature', 'IsCharging', 'ExternalConnected', 'FullyCharged',
  'BatteryInstalled', 'PermanentFailureStatus'];

/** `ioreg -rn AppleSmartBattery -d1` -> whitelisted battery facts, or null if no battery. */
function parseIoregBattery(text) {
  if (typeof text !== 'string' || !/AppleSmartBattery/.test(text)) return null;
  const raw = {};
  for (const line of lines(text)) {
    const m = line.match(/^\s*"([A-Za-z]+)"\s*=\s*(-?\d+|Yes|No)\s*$/);
    if (!m || !IOREG_BATTERY_KEYS.includes(m[1])) continue;
    raw[m[1]] = m[2] === 'Yes' ? true : m[2] === 'No' ? false : Number(m[2]);
  }
  if (!Object.keys(raw).length) return null;
  const full = raw.AppleRawMaxCapacity ?? raw.NominalChargeCapacity ?? null;
  const health = full && raw.DesignCapacity ? Math.round((full / raw.DesignCapacity) * 100) : null;
  return {
    installed: raw.BatteryInstalled ?? true,
    cycle_count: raw.CycleCount ?? null,
    design_capacity_mah: raw.DesignCapacity ?? null,
    full_charge_capacity_mah: full,
    health_percent: health,
    // Temperature is reported in hundredths of a degree Celsius.
    temperature_c: typeof raw.Temperature === 'number' ? Math.round(raw.Temperature / 10) / 10 : null,
    is_charging: raw.IsCharging ?? null,
    external_connected: raw.ExternalConnected ?? null,
    fully_charged: raw.FullyCharged ?? null,
    permanent_failure: typeof raw.PermanentFailureStatus === 'number' ? raw.PermanentFailureStatus !== 0 : null,
  };
}

module.exports = {
  parseSysctl, parseBoottime, parseLoadavg, parseSwapusage, parseSwVers, parseUptime,
  parseMemoryPressure, parseVmStat, parseDf, parsePmsetBatt, parsePmsetTherm, parseIoregBattery,
  IOREG_BATTERY_KEYS,
};
