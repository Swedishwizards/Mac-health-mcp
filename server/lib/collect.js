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

module.exports = { collectOverview, COMMANDS };
