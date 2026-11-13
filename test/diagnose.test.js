'use strict';
// diagnose_slowness: every rule triggered and not triggered, ranking and the calm answer.
// All input is made up here (no real machine data, no identifiers).
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDiagnosis, summarizeDiagnosis, needsDiskFolders, RULES } = require('../server/lib/diagnose');
const { explainProcess } = require('../server/lib/explain');

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const DAY = 86400;

/** Made-up startup folders (shaped like collectStartup): `third` items from third parties plus two from Apple. */
function startupDirs(third, { userError = null } = {}) {
  const made = Array.from({ length: third }, (_, i) => (i % 2 ? `com.exampleco.helper${i}.plist` : `DemoSync${i}.plist`));
  return {
    dirs: [
      userError ? { dir: '~/Library/LaunchAgents', files: null, error: userError } : { dir: '~/Library/LaunchAgents', files: made.slice(0, Math.ceil(third / 2)), error: null },
      { dir: '/Library/LaunchAgents', files: [...made.slice(Math.ceil(third / 2)), 'com.apple.example.helper.plist'], error: null },
      { dir: '/Library/LaunchDaemons', files: ['com.apple.example.daemon.plist'], error: null },
    ],
  };
}

/** A healthy, made-up Mac. Override pieces to trigger single rules. */
function mac({
  uptimeDays = 3, pressure = 1, swapMB = 512, freePct = 40, diskFreePct = 50,
  procs = [], therm = null, health = 95, battery = true, du = null, startup = startupDirs(2),
} = {}) {
  const boot = Math.floor(NOW / 1000) - Math.round(uptimeDays * DAY);
  const totalK = 1000000000; // ~1 TB in 1K blocks
  const availK = Math.round(totalK * diskFreePct / 100);
  const rows = [
    { pid: 0, name: '(kernel_task)', top: 5.0, ps: 4.0, mem: '100M' },
    { pid: 101, name: '/Applications/Demo Editor.app/Contents/MacOS/Demo Editor', top: 3.0, ps: 2.0, mem: '900M' },
    { pid: 102, name: '/usr/libexec/exempeld', top: 1.0, ps: 1.0, mem: '20M' },
    ...procs,
  ];
  const top = [
    'Processes: 3 total', 'CPU usage: 5.0% user, 3.0% sys, 92.0% idle', '', 'PID    %CPU  MEM', ...rows.map((r) => `${r.pid}  0.0  ${r.mem}`),
    '', 'Processes: 3 total', 'CPU usage: 5.0% user, 3.0% sys, 92.0% idle', '', 'PID    %CPU  MEM', ...rows.map((r) => `${r.pid}  ${r.top.toFixed(1)}  ${r.mem}`), '',
  ].join('\n');
  const ps = rows.map((r) => `${String(r.pid).padStart(5)} ${r.ps === null ? '' : `${r.ps.toFixed(1).padStart(5)} `}${r.name}`).join('\n') + '\n';
  const raw = {
    sysctl: [
      'hw.model: Mac99,1', 'hw.memsize: 17179869184', 'hw.ncpu: 8', 'machdep.cpu.brand_string: Apple M9',
      `kern.boottime: { sec = ${boot}, usec = 0 } Mon Jan  1 00:00:00 2026`, 'vm.loadavg: { 1.00 1.00 1.00 }',
      `vm.swapusage: total = 4096.00M  used = ${swapMB.toFixed(2)}M  free = 1.00M  (encrypted)`,
      `kern.memorystatus_vm_pressure_level: ${pressure}`, '',
    ].join('\n'),
    sw_vers: 'ProductName:\t\tmacOS\nProductVersion:\t\t26.1\nBuildVersion:\t\t25A1\n',
    uptime: null,
    memory_pressure: `The system has 17179869184 (1048576 pages with a page size of 16384).\nSystem-wide memory free percentage: ${freePct}%\n`,
    vm_stat: null,
    df: `Filesystem     1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on\n/dev/disk3s1s1   ${totalK}  12000000  ${availK}    10%  1 1    0%   /\n`,
    pmset_batt: battery ? "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=0)\t80%; discharging; 3:00 remaining present: true\n" : "Now drawing from 'AC Power'\n",
    pmset_therm: therm || 'Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded\n',
    ioreg_battery: battery ? `+-o AppleSmartBattery  <class AppleSmartBattery>\n    {\n      "BatteryInstalled" = Yes\n      "CycleCount" = 300\n      "DesignCapacity" = 5000\n      "AppleRawMaxCapacity" = ${Math.round(5000 * health / 100)}\n    }\n` : null,
    top,
    ps,
    startup,
  };
  if (du) Object.assign(raw, du);
  return raw;
}

const ids = (d) => d.likely_causes.map((c) => c.kind);
const check = (d, name) => d.checks.find((c) => c.check === name);

test('a healthy Mac gets a calm answer and every check is ok', () => {
  const d = buildDiagnosis(mac(), { now: NOW });
  assert.equal(d.found, 0);
  assert.deepEqual(d.likely_causes, []);
  assert.match(d.summary, /Hittade inget/);
  for (const c of d.checks) assert.equal(c.status, 'ok', c.check);
  const text = summarizeDiagnosis(d);
  assert.match(text, /Hittade inget/);
  assert.doesNotMatch(text, /Troliga orsaker/);
});

test('uptime: over 14 days triggers, 14 days does not', () => {
  const d = buildDiagnosis(mac({ uptimeDays: 81.3 }), { now: NOW });
  assert.deepEqual(ids(d), ['long_uptime']);
  const c = d.likely_causes[0];
  assert.match(c.evidence, /81 dagar/);
  assert.equal(c.numbers.uptime_days, 81.3);
  assert.ok(c.actions[0].includes('Starta om'));
  assert.deepEqual(ids(buildDiagnosis(mac({ uptimeDays: 14 }), { now: NOW })), []);
});

test('uptime boundary: 14,0 days agrees with get_mac_overview (neither flags it), 14,1 days both do', () => {
  const { buildOverview, GRADE } = require('../server/lib/overview');
  const at14 = mac({ uptimeDays: 14 });
  assert.equal(buildOverview(at14, { now: NOW }).uptime.grade, GRADE.OK);
  assert.deepEqual(ids(buildDiagnosis(at14, { now: NOW })), []);
  const at141 = mac({ uptimeDays: 14.1 });
  assert.equal(buildOverview(at141, { now: NOW }).uptime.grade, GRADE.BAD);
  assert.deepEqual(ids(buildDiagnosis(at141, { now: NOW })), ['long_uptime']);
});

test('memory: warning pressure or swap over 2 GB triggers and names the apps using most memory', () => {
  const big = [{ pid: 200, name: '/Applications/Webbläsare.app/Contents/MacOS/Webbläsare', top: 2, ps: 2, mem: '3G' }];
  const warn = buildDiagnosis(mac({ pressure: 2, procs: big }), { now: NOW });
  assert.deepEqual(ids(warn), ['memory_pressure']);
  assert.match(warn.likely_causes[0].evidence, /Minnestryck: varning/);
  assert.equal(warn.likely_causes[0].top_memory_apps[0].name, 'Webbläsare');
  assert.match(warn.likely_causes[0].explanation, /Webbläsare 3 GB/);

  const swap = buildDiagnosis(mac({ swapMB: 4300 }), { now: NOW });
  assert.deepEqual(ids(swap), ['memory_pressure']);
  assert.match(swap.likely_causes[0].evidence, /4,2 GB swap/);

  const critical = buildDiagnosis(mac({ pressure: 4 }), { now: NOW });
  assert.equal(critical.likely_causes[0].severity, 'hög');

  assert.deepEqual(ids(buildDiagnosis(mac({ swapMB: 2048 }), { now: NOW })), [], 'exactly 2 GB is not over the limit');
  assert.equal(check(buildDiagnosis(mac(), { now: NOW }), 'Minne och swap').status, 'ok');
});

test('disk: under 10 % free triggers and lists the largest home folders; 10 % does not', () => {
  const du = {
    du_stdout: '52428800\t/Users/exempel/Library\n10485760\t/Users/exempel/Movies\n1024\t/Users/exempel/Desktop\n62915584\t/Users/exempel\n',
    du_stderr: '', home: '/Users/exempel', du_unfinished: [],
  };
  const d = buildDiagnosis(mac({ diskFreePct: 6, du }), { now: NOW });
  assert.deepEqual(ids(d), ['disk_full']);
  const c = d.likely_causes[0];
  assert.match(c.evidence, /6 %/);
  assert.deepEqual(c.largest_home_folders.map((f) => f.path), ['~/Library', '~/Movies', '~/Desktop']);
  assert.match(c.explanation, /~\/Library 50 GB/);
  assert.doesNotMatch(JSON.stringify(d), /exempel/, 'the home path never leaves');
  // Without du data the cause still shows, just without folders.
  assert.deepEqual(buildDiagnosis(mac({ diskFreePct: 6 }), { now: NOW }).likely_causes[0].largest_home_folders, []);
  assert.deepEqual(ids(buildDiagnosis(mac({ diskFreePct: 10 }), { now: NOW })), []);
});

test('needsDiskFolders only asks for the slow du when the disk is nearly full', () => {
  assert.equal(needsDiskFolders(mac({ diskFreePct: 6 }).df), true);
  assert.equal(needsDiskFolders(mac({ diskFreePct: 25 }).df), false);
  assert.equal(needsDiskFolders(null), false);
});

test('busy process: over 80 % in both measurements triggers, is named and explained', () => {
  const procs = [{ pid: 300, name: '/usr/local/Exempel/bin/StatefulFirewall', top: 162.2, ps: 150.0, mem: '8M' }];
  const d = buildDiagnosis(mac({ procs }), { now: NOW });
  assert.deepEqual(ids(d), ['busy_process']);
  const c = d.likely_causes[0];
  assert.match(c.title, /StatefulFirewall/);
  assert.equal(c.label, 'McAfee antivirus/brandvägg');
  assert.match(c.explanation, /McAfee/);
  assert.match(c.evidence, /162,2 % CPU just nu och 150 % i snitt/);
  assert.doesNotMatch(c.actions.join(' '), /avinstallera/i);
});

test('busy process: high in only one measurement does not trigger', () => {
  const spike = [{ pid: 301, name: '/usr/libexec/exempeld2', top: 120, ps: 10, mem: '8M' }];
  assert.deepEqual(ids(buildDiagnosis(mac({ procs: spike }), { now: NOW })), []);
  const old = [{ pid: 302, name: '/usr/libexec/exempeld3', top: 10, ps: 120, mem: '8M' }];
  assert.deepEqual(ids(buildDiagnosis(mac({ procs: old }), { now: NOW })), []);
});

test('busy process: unknown names still get a cause, at most three, and an app gets "avsluta" advice', () => {
  const procs = [
    { pid: 401, name: '/Applications/Spel.app/Contents/MacOS/Spel', top: 300, ps: 290, mem: '1G' },
    { pid: 402, name: '/opt/x/a1', top: 95, ps: 90, mem: '1M' },
    { pid: 403, name: '/opt/x/a2', top: 90, ps: 90, mem: '1M' },
    { pid: 404, name: '/opt/x/a3', top: 85, ps: 90, mem: '1M' },
  ];
  const d = buildDiagnosis(mac({ procs }), { now: NOW });
  assert.equal(d.likely_causes.length, RULES.max_process_causes);
  assert.match(d.likely_causes[0].title, /^Spel/);
  assert.match(d.likely_causes[0].actions[0], /avsluta/);
  assert.match(d.likely_causes[1].explanation, /Ingen förklaring finns i ordlistan/);
});

test('busy process: without the ps column, one top measurement is used and a note says so', () => {
  const raw = mac({ procs: [{ pid: 500, name: '/opt/x/tung', top: 150, ps: 150, mem: '1M' }] });
  raw.ps = raw.ps.replace(/^(\s*\d+)\s+\d+\.\d+ /gm, '$1 ');
  const d = buildDiagnosis(raw, { now: NOW });
  assert.deepEqual(ids(d), ['busy_process']);
  assert.match(d.likely_causes[0].evidence, /Bara en mätning/);
  assert.ok(d.notes.some((n) => /bara mätas en gång/.test(n)));
});

test('Spotlight: mds_stores + mdworker over 50 % triggers and is not reported again as a busy process', () => {
  const procs = [
    { pid: 600, name: '/System/Library/Frameworks/CoreServices.framework/mds_stores', top: 85, ps: 85, mem: '70M' },
    { pid: 601, name: '/System/Library/Frameworks/CoreServices.framework/mdworker_shared', top: 20, ps: 20, mem: '10M' },
  ];
  const d = buildDiagnosis(mac({ procs }), { now: NOW });
  assert.deepEqual(ids(d), ['spotlight_indexing']);
  assert.match(d.likely_causes[0].evidence, /105 % CPU/);
  assert.match(d.likely_causes[0].explanation, /brukar gå över/);
  const calm = [{ pid: 600, name: '/x/mds_stores', top: 30, ps: 30, mem: '70M' }];
  assert.deepEqual(ids(buildDiagnosis(mac({ procs: calm }), { now: NOW })), []);
});

test('heat: kernel_task high plus a thermal warning triggers; either alone does not', () => {
  const hotTherm = 'Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nCPU Power notify\n\tCPU_Scheduler_Limit \t= 100\n\tCPU_Available_CPUs \t= 8\n\tCPU_Speed_Limit \t= 70\n';
  const make = (cpu, therm) => {
    const raw = mac({ therm });
    raw.top = raw.top.replace(/^0  5\.0  100M$/m, `0  ${cpu.toFixed(1)}  100M`);
    return raw;
  };
  const d = buildDiagnosis(make(140, hotTherm), { now: NOW });
  assert.deepEqual(ids(d), ['thermal'], 'kernel_task is not reported again as a busy process');
  assert.match(d.likely_causes[0].evidence, /kernel_task använder 140 % CPU.*begränsad till 70 %/);
  assert.equal(d.likely_causes[0].severity, 'hög');

  const noWarning = buildDiagnosis(make(140, null), { now: NOW });
  assert.ok(!ids(noWarning).includes('thermal'));
  assert.deepEqual(ids(buildDiagnosis(make(10, hotTherm), { now: NOW })), []);
});

test('battery: under 80 % triggers, 80 % does not, and a desktop Mac is "ej aktuell"', () => {
  const d = buildDiagnosis(mac({ health: 72 }), { now: NOW });
  assert.deepEqual(ids(d), ['worn_battery']);
  assert.match(d.likely_causes[0].evidence, /Batterihälsa 72 %, 300 laddcykler/);
  assert.deepEqual(ids(buildDiagnosis(mac({ health: 80 }), { now: NOW })), []);
  const desk = buildDiagnosis(mac({ battery: false }), { now: NOW });
  assert.equal(check(desk, 'Batterihälsa').status, 'ej aktuell');
  assert.equal(desk.found, 0);
});

test('ranking: most serious first, ranks are 1..n and every cause shows a number', () => {
  const procs = [
    { pid: 300, name: '/usr/local/Exempel/bin/StatefulFirewall', top: 162, ps: 150, mem: '8M' },
    { pid: 600, name: '/x/mds_stores', top: 70, ps: 60, mem: '70M' },
  ];
  const d = buildDiagnosis(mac({ uptimeDays: 81, swapMB: 4300, pressure: 2, diskFreePct: 4, health: 70, procs }), { now: NOW });
  assert.deepEqual(ids(d), ['disk_full', 'memory_pressure', 'busy_process', 'long_uptime', 'spotlight_indexing', 'worn_battery']);
  assert.deepEqual(d.likely_causes.map((c) => c.rank), [1, 2, 3, 4, 5, 6]);
  for (const c of d.likely_causes) {
    assert.match(c.evidence, /\d/, `${c.kind} shows the number behind it`);
    assert.ok(c.title && c.explanation && c.actions.length, c.kind);
  }
  const text = summarizeDiagnosis(d);
  assert.match(text, /Troliga orsaker \(mest trolig först\)/);
  assert.match(text, /^1\. Disken är nästan full/m);
  assert.match(text, /Siffror: Igång i 81 dagar/);
});

test('missing commands give notes and "okänd" checks instead of a crash', () => {
  const raw = mac();
  raw.top = null; raw.pmset_therm = null;
  const d = buildDiagnosis(raw, { now: NOW, failures: { top: 'saknas på den här datorn' } });
  assert.equal(check(d, 'Spotlight').status, 'okänd');
  assert.equal(check(d, 'Enskild process med hög CPU').status, 'okänd');
  assert.ok(d.notes.some((n) => /"top" saknas/.test(n)));
  assert.ok(d.notes.some((n) => /Kunde inte kontrollera/.test(n)));
});

test('dictionary explains the McAfee processes and other common background processes neutrally', () => {
  for (const n of ['StatefulFirewall', 'VShieldScanManager', 'VShieldScanner', 'com.mcafee.CMF.networkextension']) {
    assert.equal(explainProcess(n).label, 'McAfee antivirus/brandvägg', n);
  }
  assert.equal(explainProcess('mobileassetd').label, 'macOS hämtar resurser');
  assert.equal(explainProcess('wdavdaemon').label, 'Microsoft Defender antivirus');
  assert.equal(explainProcess('com.apple.Virtualization.VirtualMachine').label, 'Virtuell maskin');
  assert.equal(explainProcess('Claude Helper (Renderer)', 'Claude').label, 'Claude');
  const { ENTRIES } = require('../server/lib/explain');
  for (const e of ENTRIES) assert.doesNotMatch(e.explain, /avinstallera|ta bort/i, e.label);
});

test('nothing could be checked: does not claim that anything looks fine', () => {
  const d = buildDiagnosis({}, { now: NOW });
  assert.equal(d.found, 0);
  for (const c of d.checks) assert.equal(c.status, 'okänd', c.check);
  assert.match(d.summary, /gick inte att undersöka just nu/);
  assert.doesNotMatch(d.summary + d.advice, /ser bra ut/);
  assert.match(d.advice, /Försök igen/);
  const text = summarizeDiagnosis(d);
  assert.doesNotMatch(text, /ser bra ut/i);
  assert.match(text, /Kunde inte kontrollera: Drifttid/);
});

test('partly unknown (top missing): names what could not be checked and only the rest "ser bra ut"', () => {
  const raw = mac();
  delete raw.top;
  const d = buildDiagnosis(raw, { now: NOW });
  assert.equal(d.found, 0);
  for (const name of ['Enskild process med hög CPU', 'Spotlight', 'Värme (kernel_task)']) assert.equal(check(d, name).status, 'okänd', name);
  assert.match(d.summary, /bland det som gick att kontrollera/);
  assert.match(d.summary, /Drifttid, minne och swap, ledig disk, batterihälsa och startobjekt ser bra ut\./);
  assert.match(d.summary, /Kunde inte kontrollera: Enskild process med hög CPU, Spotlight och värme \(kernel_task\)\./);
  assert.doesNotMatch(d.summary, /processer, värme/);
  assert.match(d.advice, /ofullständigt/);
});

test('causes found while some checks are unknown: the summary says what could not be checked', () => {
  const raw = mac({ uptimeDays: 30 });
  delete raw.top;
  const d = buildDiagnosis(raw, { now: NOW });
  assert.deepEqual(ids(d), ['long_uptime']);
  assert.match(d.summary, /Hittade 1 trolig orsak/);
  assert.match(d.summary, /Kunde inte kontrollera: Enskild process med hög CPU, Spotlight och värme \(kernel_task\)\./);
  const all = buildDiagnosis(mac({ uptimeDays: 30 }), { now: NOW });
  assert.doesNotMatch(all.summary, /Kunde inte kontrollera/);
});

test('a healthy Mac lists every check as fine', () => {
  const d = buildDiagnosis(mac(), { now: NOW });
  assert.match(d.summary, /Drifttid, minne och swap, ledig disk, enskild process med hög CPU, Spotlight, värme \(kernel_task\), batterihälsa och startobjekt ser bra ut\./);
});

// ---------- Startobjekt (eighth check) ----------

test('startup items: 20 from third parties give a cause with the count, at most 3 names and the two tips', () => {
  const d = buildDiagnosis(mac({ startup: startupDirs(20) }), { now: NOW });
  assert.deepEqual(ids(d), ['many_startup_items']);
  const c = d.likely_causes[0];
  assert.equal(c.numbers.third_party, 20);
  assert.equal(c.numbers.apple, 2, 'Apple items are not counted as third party');
  assert.match(c.evidence, /20 startobjekt från tredjepart \(gränsen är 15\)/);
  assert.equal(c.numbers.examples.length, 3);
  assert.match(c.actions.join(' '), /startup_items/);
  assert.match(c.actions.join(' '), /Systeminställningar > Allmänt > Inloggningsobjekt/);
  assert.equal(check(d, 'Startobjekt').status, 'utlöst');
  // Boundary: 15 triggers, 14 does not.
  assert.deepEqual(ids(buildDiagnosis(mac({ startup: startupDirs(15) }), { now: NOW })), ['many_startup_items']);
  assert.deepEqual(ids(buildDiagnosis(mac({ startup: startupDirs(14) }), { now: NOW })), []);
  // Ranked like the other rules: below memory, above a worn battery.
  const many = buildDiagnosis(mac({ startup: startupDirs(20), pressure: 2, health: 70 }), { now: NOW });
  assert.deepEqual(ids(many), ['memory_pressure', 'many_startup_items', 'worn_battery']);
});

test('startup items: 5 from third parties "ser bra ut"', () => {
  const d = buildDiagnosis(mac({ startup: startupDirs(5) }), { now: NOW });
  assert.equal(d.found, 0);
  const c = check(d, 'Startobjekt');
  assert.equal(c.status, 'ok');
  assert.equal(c.value, '5 från tredjepart');
  assert.match(summarizeDiagnosis(d), /Startobjekt \(5 från tredjepart\)/);
});

test('startup items: an unreadable list is "okänd", never "ser bra ut"', () => {
  const denied = { dirs: ['~/Library/LaunchAgents', '/Library/LaunchAgents', '/Library/LaunchDaemons'].map((dir) => ({ dir, files: null, error: 'denied' })) };
  for (const startup of [denied, undefined, null]) {
    const raw = mac();
    raw.startup = startup;
    const d = buildDiagnosis(raw, { now: NOW });
    assert.equal(check(d, 'Startobjekt').status, 'okänd');
    assert.match(d.summary, /Kunde inte kontrollera: Startobjekt\./);
    assert.doesNotMatch(d.summary, /startobjekt ser bra ut/i);
  }
  // One folder unreadable and few items in the rest: cannot say it looks fine either.
  assert.equal(check(buildDiagnosis(mac({ startup: startupDirs(4, { userError: 'denied' }) }), { now: NOW }), 'Startobjekt').status, 'okänd');
  // A folder that simply does not exist is normal, so the check still counts.
  assert.equal(check(buildDiagnosis(mac({ startup: startupDirs(4, { userError: 'missing' }) }), { now: NOW }), 'Startobjekt').status, 'ok');
});

test('startup items privacy: no paths, no user names and at most 3 names in the output', () => {
  const { scrub, scrubString } = require('../server/lib/privacy');
  const ctx = { usernames: ['testuser'], hostnames: [] };
  const files = [
    ...Array.from({ length: 17 }, (_, i) => `com.exampleco.helper${i}.plist`),
    'com.testuser.private.plist', '/Users/testuser/Library/LaunchAgents/DemoSync.plist', 'DemoSync.extra.plist',
  ];
  const raw = mac({ startup: { dirs: [{ dir: '~/Library/LaunchAgents', files, error: null }] } });
  // Same as the server: scrub the data and the text with privacy.js before anything leaves.
  const d = scrub(buildDiagnosis(raw, { now: NOW }), ctx);
  const text = scrubString(summarizeDiagnosis(d), ctx);
  const c = d.likely_causes.find((x) => x.kind === 'many_startup_items');
  assert.ok(c, 'triggers with 20 items');
  assert.ok(c.numbers.examples.length <= 3);
  const out = JSON.stringify(d) + text;
  assert.doesNotMatch(out, /testuser/);
  assert.doesNotMatch(out, /\/Users\//);
  assert.doesNotMatch(out, /LaunchAgents|LaunchDaemons/, 'no folder paths');
  assert.doesNotMatch(out, /\.plist/, 'names only, not file names');
  // At most three distinct startup names anywhere in the output.
  const shown = new Set(out.match(/com\.exampleco\.helper\d+|DemoSync[\w.]*/g) || []);
  assert.ok(shown.size <= 3, [...shown].join(', '));
  // The rule itself (before the server's scrub) never lets a path through either.
  const names = buildDiagnosis(mac({ startup: { dirs: [{ dir: '~/Library/LaunchAgents', files: ['/Users/testuser/x/DemoSync.plist', ...files.slice(0, 16)], error: null }] } }), { now: NOW })
    .likely_causes[0].numbers.examples;
  for (const n of names) assert.doesNotMatch(n, /\//);
});
