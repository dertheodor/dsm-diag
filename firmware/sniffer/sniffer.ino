/*
 * Line sniffer: shows what the ECU does on diagnostic pin 1, at any speed.
 *
 * Use it when dsm_bridge gets clean echoes but no reply. dsm_bridge drops every
 * frame that is not a valid 1953-baud byte; this sketch logs every edge instead.
 *
 * Wiring: the 12 V adapter with the ULN2003 (docs/wiring.md).
 *   D2 -> module IN1     (D2 HIGH pulls the line low)
 *   line -> 20k -> D3    (reads the line)
 *
 * It sends only the read-only requests 0xFD, 0x14 and 0x21 at 1953 baud.
 * It never sends at other speeds: an ECU at 1953 baud would decode such a byte
 * as a different address, possibly an actuator test (0xF1-0xFC).
 *
 * Open the port at 115200 baud; opening it resets the Uno and starts one run.
 * Output per window: "<label> lvl0=<0|1> n=<edges> : t1 t2 ..."
 *   lvl0  line level at the window start (1 = high)
 *   t     microseconds after the window start, one per level change
 * At 1953 baud one bit is 512 us. Upload dsm_bridge again afterwards.
 */

const uint8_t TX_PIN = 2;
const uint32_t BIT_US = 512;
const uint16_t MAXE = 160;
uint32_t edges[MAXE];

static inline bool lineHigh() { return PIND & _BV(3); }  // D3, faster than digitalRead
static inline void waitUntil(uint32_t t) { while ((int32_t)(micros() - t) < 0) {} }

/* Send one byte, 8N1, through the inverting ULN2003 stage. */
static void sendByte(uint8_t b) {
  uint32_t t0 = micros();
  digitalWrite(TX_PIN, HIGH);                    // start bit
  for (uint8_t i = 0; i < 8; i++) {
    waitUntil(t0 + (i + 1) * BIT_US);
    digitalWrite(TX_PIN, (b >> i) & 1 ? LOW : HIGH);
  }
  waitUntil(t0 + 9 * BIT_US);
  digitalWrite(TX_PIN, LOW);                     // stop bit
  waitUntil(t0 + 10 * BIT_US);
}

/* Log every level change on the line for windowUs, then print it. */
static void capture(const char *label, uint32_t windowUs) {
  uint16_t n = 0;
  bool last = lineHigh();
  bool lvl0 = last;
  uint32_t start = micros();
  while (micros() - start < windowUs && n < MAXE) {
    bool l = lineHigh();
    if (l != last) { edges[n++] = micros() - start; last = l; }
  }
  Serial.print(label);
  Serial.print(F(" lvl0="));
  Serial.print(lvl0);
  Serial.print(F(" n="));
  Serial.print(n);
  Serial.print(F(" :"));
  for (uint16_t i = 0; i < n; i++) { Serial.print(' '); Serial.print(edges[i]); }
  Serial.println();
}

void setup() {
  digitalWrite(TX_PIN, LOW);                     // release the line before D2 becomes an output
  pinMode(TX_PIN, OUTPUT);
  pinMode(3, INPUT);
  Serial.begin(115200);
  delay(200);
  Serial.println(F("SNIFFER START"));

  capture("passive-1", 3000000UL);
  capture("passive-2", 3000000UL);

  const uint8_t addrs[] = { 0xFD, 0x14, 0x21 };
  char label[16];
  for (uint8_t a = 0; a < sizeof addrs; a++) {
    for (uint8_t r = 0; r < 3; r++) {
      sendByte(addrs[a]);
      snprintf(label, sizeof label, "req-%02X-%u", addrs[a], r);
      capture(label, 500000UL);
      delay(100);
    }
  }
  capture("passive-3", 3000000UL);
  Serial.println(F("SNIFFER DONE"));
}

void loop() {}
