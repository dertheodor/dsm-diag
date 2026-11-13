# Wiring

Everything here uses parts from a typical Arduino Uno starter kit.

## The diagnostic connector

12-pin connector next to the fuse box, driver's footwell. Seen from the front
(pins pointing at you), the 1G layout is two rows of six. On cars where the
connector is mounted on its side, the rows run vertically:

```
 1  2  3  4  5  6        or, mounted sideways:   [1 ]   [7 ]
 7  8  9 10 11 12                                [2 ]   [8 ]
                                                 [3 ]   [9 ]
                                                 [4 ]   [10]
                                                 [5 ]   [11]
                                                 [6 ]   [12]
```

| Pin | Function | Notes |
|---|---|---|
| 1 | ECU data | Bidirectional, idles at battery voltage on the cars tested so far |
| 5 | Cruise control data | Not used |
| 6 | Automatic transmission data | Not used |
| 10 | Diagnostic mode | Bridge to pin 12 to enable |
| 11 | Vehicle speed sensor | Reed switch to ground; can look like a second ground when parked |
| 12 | Ground | |

Confirm before wiring: pin 12 has continuity to chassis, pin 1 does not.

## Step 1: measure the line voltage

Measure pin 1 against chassis with a multimeter (ignition on, engine off, pin 10
bridged to pin 12), or use `firmware/voltcheck` with a 3×10k divider into A0.

- About 12 V: use the 12 V wiring below (most cars).
- About 5 V: the 5 V wiring at the end of this page also works.

## 12 V wiring with the ULN2003 motor driver module

![Breadboard wiring](images/wiring-12v-uln2003.svg)

| From | To |
|---|---|
| R1 10k | b7 to b10 |
| R2 10k | c4 to c7 |
| R3 10k | a4 to − rail |
| Arduino GND | − rail |
| Arduino pin 3 (D3) | e4 |
| Arduino pin 2 (D2) | module IN1 |
| Module − | Arduino GND (any GND pin) |
| Module OUT1 (top pin of the white socket, next to LED A) | e10 |
| Module + | **nothing** |
| Car pin 1 | a10 |
| Car pin 12 | − rail |
| Car pin 10 | bridged to pin 12 |

- **Module "+" must stay empty**, and the jumper cap next to it should be removed.
  The chip has diodes from every output to "+"; if "+" were powered, the car's 12 V
  would flow into the Arduino.
- **Find OUT1 with a continuity test** from the chip's top-right leg (pin 16,
  notch facing up) to the pins in the white socket.
- A single NPN transistor (PN2222, 2N3904, BC547, S8050) works instead of the module:
  D2 → 1k → base, emitter → GND, collector → 100–220 Ω → line.

In `firmware/dsm_bridge/dsm_bridge.ino`, set `#define WIRING_12V` and upload.

## Bench test without the car

1. Add a 1k resistor from c10 to the + rail and a wire from the + rail to Arduino 5V.
2. Move the D3 wire from e4 to d10.
3. Run `npm run cli -- /dev/ttyUSB0`. The expected result is `no reply for 0xFD`:
   the echo worked, only the ECU is missing.
4. **Undo steps 1 and 2 before connecting the car.**

| Message | Meaning |
|---|---|
| `no echo` | Sketch not uploaded, wrong port, or D3 not connected |
| `echo mismatch … got 0x00` | Line stuck low: missing pull-up (bench) or ignition off (car) |
| `echo mismatch … got 0xFF` | Line never pulled low: check D2 → IN1 and OUT1 → e10 |
| `no reply` | Wiring works; ECU not answering (ignition, pin 10 bridge) |

## 5 V wiring (only if the line measures ~5 V)

```
car pin 1 ──[330 Ω]── D2
car pin 10 ── car pin 12 ── Arduino GND
```

Keep `#define WIRING_5V`. D2 is used open-drain: it pulls the line low and
otherwise lets go, so the Arduino and ECU never fight.

## Linux notes

- The Uno clone shows up as `/dev/ttyUSB0` (CH340).
- If the port appears and vanishes, remove `brltty`: `sudo apt remove brltty`.
- Add yourself to `dialout` for permission: `sudo usermod -aG dialout $USER`, then log in again.
