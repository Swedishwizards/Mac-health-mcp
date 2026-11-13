'use strict';
/**
 * Runs the built-in, read-only macOS commands that get_mac_overview needs.
 * No shell, absolute paths, a timeout per command, and no admin rights.
 * A missing or failing command just gives null for that part (plus a reason),
 * so one broken tool never takes down the whole overview.
 */
const { run } = require('./exec');

const COMMANDS = {
  sysctl: ['/usr/sbin/sysctl', ['hw.model', 'hw.memsize', 'hw.ncpu', 'machdep.cpu.brand_string',
    'kern.boottime', 'vm.loadavg', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level']],
  sw_vers: ['/usr/bin/sw_vers', []],
  uptime: ['/usr/bin/uptime', []],
  memory_pressure: ['/usr/bin/memory_pressure', ['-Q']],
  vm_stat: ['/usr/bin/vm_stat', []],
  df: ['/bin/df', ['-k', '/']],
  pmset_batt: ['/usr/bin/pmset', ['-g', 'batt']],
  pmset_therm: ['/usr/bin/pmset', ['-g', 'therm']],
  ioreg_battery: ['/usr/sbin/ioreg', ['-rn', 'AppleSmartBattery', '-d1']],
};

async function collectOverview({ timeoutMs = 8000, runner = run } = {}) {
  const raw = {};
  const failures = {};
  await Promise.all(Object.entries(COMMANDS).map(async ([key, [file, args]]) => {
    const r = await runner(file, args, { timeoutMs, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' } });
    // sysctl exits non-zero if a single key is unknown but still prints the others, so keep any stdout.
    if (r.stdout && r.stdout.trim()) { raw[key] = r.stdout; return; }
    raw[key] = null;
    // ioreg prints nothing on Macs without a battery – that is not an error.
    if (key === 'ioreg_battery' && r.code === 0) return;
    failures[key] = r.missing ? 'saknas på den här datorn' : r.timedOut ? 'tog för lång tid' : 'misslyckades';
  }));
  return { raw, failures };
}

const ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' };

function failReason(r) {
  return r.missing ? 'saknas på den här datorn' : r.timedOut ? 'tog för lång tid' : 'misslyckades';
}

/** Runs a set of commands in parallel; keeps any stdout, records a reason for the rest. */
async function collectSet(commands, { timeoutMs, runner }) {
  const raw = {};
  const failures = {};
  await Promise.all(Object.entries(commands).map(async ([key, [file, args]]) => {
    const r = await runner(file, args, { timeoutMs, env: ENV });
    if (r.stdout && r.stdout.trim()) { raw[key] = r.stdout; return; }
    raw[key] = null;
    failures[key] = failReason(r);
  }));
  return { raw, failures };
}

// top needs two samples (about one second apart) to give real CPU numbers.
const PROCESS_COMMANDS = {
  top: ['/usr/bin/top', ['-l', '2', '-o', 'cpu', '-n', '400', '-stats', 'pid,cpu,mem']],
  ps: ['/bin/ps', ['-Axo', 'pid=,comm=']],
};

const MEMORY_COMMANDS = {
  sysctl: ['/usr/sbin/sysctl', ['hw.memsize', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level']],
  memory_pressure: COMMANDS.memory_pressure,
  vm_stat: COMMANDS.vm_stat,
};

function collectProcesses({ timeoutMs = 10000, runner = run } = {}) {
  return collectSet(PROCESS_COMMANDS, { timeoutMs, runner });
}

function collectMemory({ timeoutMs = 8000, runner = run } = {}) {
  return collectSet(MEMORY_COMMANDS, { timeoutMs, runner });
}

/**
 * df for the startup disk plus `du -sk -x` per top-level folder in the home folder, a few at a time,
 * all sharing one deadline (default 20 s). du only reads sizes. One du per folder (instead of one
 * `du -d 1` over the whole home folder) means a timeout still leaves the folders that were finished:
 * du buffers its output when writing to a pipe, so a killed `du -d 1` would give nothing at all.
 * Output is shaped like `du -d 1 -k <home>` so parseDu can read it; the home "total" line is only
 * added when every folder was measured (it is the sum of the folders, files directly in ~ excluded).
 */
async function collectDisk({ timeoutMs = 8000, duTimeoutMs = 20000, concurrency = 4, runner = run, home, listDir } = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const homeDir = home || require('node:os').homedir();
  const { raw, failures } = await collectSet({ df: COMMANDS.df }, { timeoutMs, runner });
  raw.home = homeDir;

  let dirs = [];
  try {
    const entries = listDir ? listDir(homeDir) : fs.readdirSync(homeDir, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => path.join(homeDir, e.name));
  } catch (e) {
    raw.du_stdout = '';
    raw.du_stderr = e && e.code === 'EPERM' ? `du: ${homeDir}: Operation not permitted\n` : '';
    failures.du = 'misslyckades';
    return { raw, failures, du_timed_out: false };
  }

  const deadline = Date.now() + duTimeoutMs;
  const out = [];
  const err = [];
  const unfinished = [];
  let timedOut = false;
  let next = 0;
  async function worker() {
    while (next < dirs.length) {
      const dir = dirs[next++];
      const left = deadline - Date.now();
      if (left <= 0) { timedOut = true; unfinished.push(dir); continue; }
      const r = await runner('/usr/bin/du', ['-s', '-k', '-x', dir], { timeoutMs: left, env: ENV });
      if (r.timedOut) { timedOut = true; unfinished.push(dir); continue; }
      if (r.stdout && r.stdout.trim()) out.push(r.stdout.trim());
      if (r.stderr && r.stderr.trim()) err.push(r.stderr.trim());
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  if (!timedOut && out.length) {
    const sum = out.reduce((acc, l) => acc + (Number(l.split('\t')[0]) || 0), 0);
    out.push(`${sum}\t${homeDir}`);
  }
  raw.du_stdout = out.length ? out.join('\n') + '\n' : '';
  raw.du_stderr = err.length ? err.join('\n') + '\n' : '';
  // Only "~/name" leaves this module, never the real home path.
  raw.du_unfinished = unfinished.map((d) => `~/${path.basename(d)}`).sort();
  if (!out.length && dirs.length) failures.du = timedOut ? 'tog för lång tid' : 'misslyckades';
  return { raw, failures, du_timed_out: timedOut };
}

module.exports = { collectOverview, collectProcesses, collectMemory, collectDisk, COMMANDS, PROCESS_COMMANDS, MEMORY_COMMANDS };
