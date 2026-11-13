/*
 * Step 1: measure the 1G DSM diagnostic line (pin 1) BEFORE wiring the bridge.
 *
 * Wiring (divide by 3, safe up to ~15 V):
 *
 *   diag pin 1 ──[10k]──[10k]──┬── A0
 *                              └──[10k]── GND
 *   diag pin 12 (GND) ─────────────────── Uno GND
 *
 * Open Serial Monitor at 115200. Measure with ignition ON:
 *   a) without the pin 10–12 jumper
 *   b) with pin 10 bridged to pin 12 (diagnostic mode)
 *
 * Interpreting the "idle" value in diagnostic mode:
 *   ~4.5–5.5 V  -> 5 V TTL line, ECU has its own pull-up. Use WIRING_5V, no external pull-up.
 *   ~0 V        -> no pull-up on the line. Use WIRING_5V and add a 4.7k pull-up to Uno 5V.
 *   ~11–14.5 V  -> 12 V line. Use WIRING_12V (transistor stage). Do NOT wire pin 1 straight to the Uno.
 *
 * "min" dropping well below "idle" means something is toggling the line
 * (e.g. flash codes when not in diagnostic mode).
 */

const float VREF = 5.0;      // Uno supply; USB 5V is typically ±5 %
const float DIVIDER = 3.0;   // (10k + 10k + 10k) / 10k

void setup() {
  Serial.begin(115200);
  Serial.println(F("DSM diag line voltage check"));
}

void loop() {
  float vMin = 99, vMax = 0, vSum = 0;
  const int N = 500;
  for (int i = 0; i < N; i++) {          // ~0.5 s window
    float v = analogRead(A0) * VREF / 1023.0 * DIVIDER;
    vMin = min(vMin, v);
    vMax = max(vMax, v);
    vSum += v;
    delayMicroseconds(800);
  }
  Serial.print(F("idle(avg) "));
  Serial.print(vSum / N, 2);
  Serial.print(F(" V   min "));
  Serial.print(vMin, 2);
  Serial.print(F(" V   max "));
  Serial.print(vMax, 2);
  Serial.println(F(" V"));
}
