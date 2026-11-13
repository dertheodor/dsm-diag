# CLAUDE.md

dsm-diag reads live data and fault codes from 1G DSM ECUs over the 12-pin diagnostic port. [README.md](README.md) owns the user-facing overview and the repository layout.

## Commands

| Command | Purpose |
|---|---|
| `npm run sim` | Dashboard with a simulated car on http://localhost:1991 |
| `npm run dashboard` | Dashboard with a real adapter. Add `-- --port /dev/ttyUSB0` to skip auto-detection. |
| `npm run cli -- /dev/ttyUSB0` | Terminal tester |
| `npm test` | Type-check and protocol self-test |
| `npm run test:bridge` | Compile `test/bridge-sim.cpp` with g++ and run it for 5 V and 12 V wiring |

CI runs `typecheck`, `selftest` and `test:bridge`. Run all three before a PR. Set `PORT` to change the HTTP port.

## Architecture

- `src/mmcd.ts` owns the protocol: the `Transport` interface, the `Ecu` class, `SENSORS`, `FLAGS` and the fault-bit table.
- Every request is one address byte. The reply is the echo of that byte, then one data byte.
- `src/server/link.ts` owns the adapter lifecycle: discovery, connect, ECU probe and state events.
- `Link.exclusive()` serializes all line access. Live polling and user actions share this one queue. Never call `Ecu.request()` outside it.
- `src/server/server.ts` serves `web/` and bundles `web/app.ts` with esbuild on each request. It pushes data over SSE (`/events`) and takes actions on `POST /api/*`.
- `src/server/sim.ts` supplies the simulated adapter and ECU for `--sim`.
- `firmware/dsm_bridge/dsm_bridge.ino` bit-bangs 1953.125 baud. It forwards bytes transparently, so the TypeScript side keeps `echo: true`.
- `test/bridge-sim.cpp` includes the `.ino` directly and runs it against a virtual clock and fake ECU. Keep the firmware compilable as plain C++.

## Safety rules

The tool is read-only by design. Keep these guards in place:

- `Link.readAddress()` blocks 0xCA, 0xF1–0xFC and 0xFE/0xFF. Do not remove or bypass this check.
- Only `clearFaults()` writes, and only on an explicit user action.
- Do not add actuator tests or other commands that change ECU state.

## ECU data

- Sensor scaling and addresses come from US E931/E932 ECUs. The author's car has a European E935 ECU.
- Record E935 findings in [docs/e935.md](docs/e935.md). Do not change `SENSORS` scaling without a verified source.
- [docs/protocol.md](docs/protocol.md) owns the address map and sources.
