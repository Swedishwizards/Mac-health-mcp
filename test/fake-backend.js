'use strict';
// Preloaded with `node -r` in tests: replaces the command collector with fixture data
// (made-up output in the same format as macOS), so the server can be tested on any OS.
//   FAKE_MISSING=key1,key2  -> those commands behave as if missing
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const FILES = {
  sysctl: 'sysctl.txt', sw_vers: 'sw_vers.txt', uptime: 'uptime.txt', memory_pressure: 'memory_pressure.txt',
  vm_stat: 'vm_stat.txt', df: 'df.txt', pmset_batt: 'pmset-batt.txt', pmset_therm: 'pmset-therm.txt',
  ioreg_battery: 'ioreg-battery.txt',
};

const fake = {
  async collectOverview() {
    const missing = (process.env.FAKE_MISSING || '').split(',').filter(Boolean);
    const raw = {};
    const failures = {};
    for (const [k, f] of Object.entries(FILES)) {
      if (missing.includes(k)) { raw[k] = null; failures[k] = 'saknas på den här datorn'; } else raw[k] = fx(f);
    }
    return { raw, failures };
  },
  async collectProcesses() {
    const missing = (process.env.FAKE_MISSING || '').split(',').filter(Boolean);
    const raw = {}; const failures = {};
    for (const [k, f] of [['top', 'top.txt'], ['ps', 'ps.txt']]) {
      if (missing.includes(k)) { raw[k] = null; failures[k] = 'saknas på den här datorn'; } else raw[k] = fx(f);
    }
    return { raw, failures };
  },
  async collectMemory() {
    return { raw: { sysctl: fx('sysctl.txt'), memory_pressure: fx('memory_pressure.txt'), vm_stat: fx('vm_stat.txt') }, failures: {} };
  },
  //   FAKE_DU_TIMEOUT=1 -> du was cut off: only the first folders, no total line
  async collectDisk() {
    let du = fx('du.txt');
    const timedOut = process.env.FAKE_DU_TIMEOUT === '1';
    if (timedOut) du = du.split('\n').slice(0, 10).join('\n') + '\n';
    return {
      raw: { df: fx('df.txt'), du_stdout: du, du_stderr: fx('du-stderr.txt'), home: '/Users/testuser', du_unfinished: timedOut ? ['~/Library'] : [] },
      failures: {},
      du_timed_out: timedOut,
    };
  },
};

// The server refuses to run off macOS; pretend to be a Mac inside the test process only.
Object.defineProperty(process, 'platform', { value: 'darwin' });

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (/lib[\\/]collect$/.test(request) && parent && /server[\\/]index\.js$/.test(parent.filename)) return fake;
  return origLoad.call(this, request, parent, isMain);
};
