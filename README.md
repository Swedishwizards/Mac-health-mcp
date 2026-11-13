# Mac Health MCP

MCP server that lets Claude check your Mac's health and explain in plain English why it might be slow. Local, read-only, zero dependencies.

**Status: milestone 3 (v0.3.0, not released).** Eight tools, including `diagnose_slowness`. No `.mcpb` is built yet (milestone 4).

## Tools

All tools are read-only and local.

| Tool | What it does |
|---|---|
| `diagnose_slowness` | Why is my Mac slow? Likely causes ranked, each with the number behind it and what you can do (details below). |
| `get_mac_overview` | Health check of the whole Mac, each part graded (details below). |
| `top_processes` | Which apps and processes use the most CPU and memory right now, grouped per app, with cryptic macOS names explained (optional `limit`, 1-25). |
| `memory_report` | Memory pressure, swap, compressed memory and file cache in plain language, with a grade. |
| `disk_report` | Free space on the startup disk with a grade, plus the largest folders in your home folder. Can take up to about 20 seconds. |
| `battery_report` | Battery health, cycles, charge state, temperature and tips, with a grade. Desktop Macs get a "no battery" answer. |
| `thermal_status` | Whether macOS is slowing the processor down because of heat, with advice. |
| `startup_items` | What starts automatically (launch agents and daemons), marked as Apple or third party. Only lists, never changes. |

### `diagnose_slowness`
Answers "why is my Mac slow?" with a ranked list of likely causes, each with the number behind it, a plain explanation and what you can do. It checks seven things:

| Check | Triggers when |
|---|---|
| Uptime | More than 14 days since the last restart |
| Memory and swap | High memory pressure or more than 2 GB swap |
| Free disk | Under 10 % free on the startup disk |
| Single process | One process over 80 % CPU in both measurements (`top` over about 1 s and `ps` averaged over about 1 min) |
| Spotlight | `mds_stores` and `mdworker` together over 50 % CPU |
| Heat | `kernel_task` over 50 % CPU or thermal throttling |
| Battery health | Under 80 % of new capacity |

Every command runs once and is shared between the checks. It only says a check "looks good" if the check could actually be made; checks that could not run are listed as unknown. Causes are likely, not certain, and nothing is ever changed.

Example: ask Claude "Why is my Mac so slow?" and get something like "Found 2 likely causes. The most likely: low free disk space. 1. Disk almost full (7 % free) ... 2. Long time since restart (21 days) ...".

### `get_mac_overview`
A health check of the whole Mac, each part graded **Bra** (good), **Okej** (ok) or **Behöver åtgärd** (needs attention), with advice when something is off:

| Part | What it shows | Source |
|---|---|---|
| Model | Model identifier, chip, cores, memory | `sysctl` |
| macOS | Version and build | `sw_vers` |
| Uptime | Time since last restart (restart advice after 14 days) | `sysctl kern.boottime`, fallback `uptime` |
| CPU | Load average per core | `sysctl vm.loadavg`, fallback `uptime` |
| Memory | Free %, memory pressure level, swap, breakdown | `memory_pressure -Q`, `vm_stat`, `sysctl` |
| Disk | Free / total on the startup disk | `df -k /` |
| Battery | Charge, state, health (capacity vs new), cycles (skipped on desktops) | `pmset -g batt`, `ioreg` |
| Thermal | Thermal warnings and CPU speed limit | `pmset -g therm` |

If a command is missing or fails, that part is reported as **Okänd** (unknown) instead of the whole tool failing.

## Privacy

- Everything runs locally with built-in macOS tools. No network requests, no telemetry.
- Read-only: never deletes, closes or changes anything. No admin password. Process names are explained with a built-in dictionary; only names are returned, never user names or full paths.
- Commands run without a shell, with absolute paths and a timeout.
- Only whitelisted values are parsed. Serial numbers, UUIDs, hardware IDs, MAC addresses, user names and home folder paths are filtered out before anything is sent to Claude.

## Requirements

macOS and Node.js 18 or newer. No `npm install` needed.

## Development

```sh
node --test          # runs on any OS, uses saved command output in test/fixtures
node server/index.js # MCP server over stdio
```

## License

MIT
