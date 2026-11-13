# Hardware roadmap

The Arduino + breadboard setup in [docs/wiring.md](../docs/wiring.md) is the
prototype. The goal is a simple cable: USB on one end, the 12-pin diagnostic
plug on the other, like the 1G USB datalogger cables that used to be sold
(the best-known one has been out of stock since 2018).

## Target design: direct USB-serial cable

```
USB ── FTDI FT231X/FT232R ──┬── TX → NPN/open-collector driver → pin 1
                            └── RX ← resistor divider ← pin 1
                         GND ───────────────────────────── pin 12
                         pin 10 ── pin 12 (bridged in the plug)
```

- No microcontroller and no firmware. An FTDI chip hits 1953.125 baud exactly.
- Transparent 1953 baud serial, so it also works with TunerPro RT, EvoScan and
  MMCd-style tools, not just dsm-diag (`adapter: 'ftdi'`).
- Needs testing: echo behaviour and level thresholds with the divider values
  used on the breadboard.

## Open questions

- [ ] 12-pin mating plug: source a used harness plug, find the Mitsubishi part
      number, or 3D-print a housing for crimp terminals
- [ ] Enclosure inside or behind the plug
- [ ] PCB (KiCad) vs. a small perfboard
- [ ] Optional: ESP32 version that serves the dashboard over Wi-Fi, no laptop needed
