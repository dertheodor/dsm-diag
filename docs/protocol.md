# Protocol

The 1G ECU speaks a very simple request/reply protocol on diagnostic pin 1,
often called the MMCd or ALDL protocol after the tools that used it.

## Link layer

- 1953.125 baud (16 MHz / 8192), 8 data bits, no parity, 1 stop bit
- Single wire, half duplex. The tester and the ECU share pin 1.
- Diagnostic mode is enabled by bridging pin 10 to pin 12 (ground).
- No initialisation sequence is needed.
- The European E935 uses the same protocol with inverted levels: see [e935.md](e935.md).

## Request / reply

The tester sends one byte, the address. Because TX and RX share the wire, the
tester first hears its own byte (the echo), then the ECU's one-byte reply.

```
tester:  [addr]
line:    [addr echo] [data]
```

A round trip takes about 10 ms, so roughly 90–100 requests per second.

## Address map

From the commented E931/E932 disassembly. Verified on US ECUs; see
[e935.md](e935.md) for what is known about the European E935.

| Range | Meaning |
|---|---|
| 0x00–0x3D | Processed sensor values (table in `src/mmcd.ts`) |
| 0x38/0x39 | Active fault codes, 16-bit bitmask |
| 0x3B/0x3C | Stored fault codes, 16-bit bitmask |
| 0x40–0xF0 | Raw RAM byte at that address |
| 0xCA | Clear stored fault codes (replies 0x00 if accepted, engine must be off) |
| 0xF1–0xFC | Actuator tests, ~6 s each, engine off. Blocked in this project. |
| 0xFD | CPU / version byte (E931 = 0xB5, E932 = 0xB7) |
| 0xFE/0xFF | Strapping words, untested. Blocked in this project. |

The EPROM (program and calibration maps) is **not** reachable over this protocol.
Read it with an EPROM programmer after removing the chip.

## Adapters

- **Arduino bridge** (`firmware/dsm_bridge`): the PC talks to the Uno at 115200 baud;
  the Uno bit-bangs 1953 baud on the line and forwards every byte both ways.
  With `WIRING_INVERTED`, it also handles the E935 polarity and sends only allowlisted addresses.
- **Direct USB-serial** (planned cable): an FTDI chip hits 1953.125 baud exactly
  (3 MHz / 1536) and needs no firmware. Use `adapter: 'ftdi'` in the transports.
  This is also what existing tools like TunerPro RT and EvoScan expect.

## Sources

- [illja96/mmcdlogger](https://github.com/illja96/mmcdlogger) and
  [ngx-mmcdlogger](https://github.com/illja96/ngx-mmcdlogger): address table, commands
- [E931 commented source (EvoEcu mirror)](https://evoecu.logic.net/mirror/cpudocs/E931/standard_E931.txt)
- [ECMTuning wiki: 12-pin diagnostic port](https://www.dsmlink.com/wiki/diagport-12pin)
- [kevin-buckham/MMCd-Go](https://github.com/kevin-buckham/MMCd-Go)
