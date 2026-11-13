# Mac Health MCP

MCP server that lets Claude check your Mac's health and explain in plain English why it might be slow. Local, read-only, zero dependencies.

**Status: milestone 1 (v0.1.0, not released).** One tool so far; more are planned (top processes, memory, disk, battery, thermal, startup items and `diagnose_slowness`).

## Tool

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
- Read-only: never deletes, closes or changes anything. No admin password.
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
