/*
 * Line sniffer: shows what the ECU does on diagnostic pin 1, in both polarities.
 *
 * Use it when dsm_bridge gets clean echoes but no reply. dsm_bridge drops every
 * frame that is not a valid 1953-baud byte; this sketch logs every edge instead.
 *
 * Wiring: the ULN2003 adapter from docs/wiring.md, with two changes:
 *   R4 1k  c10 to c15, and e15 -> D4 (instead of Arduino 5V)
 *   10k    d10 to d18, and a18 -> - rail (pull-down on the line)
 *   D2 -> module IN1   (D2 HIGH pulls the line low)
 *   line -> 20k -> D3  (reads the line)
 *
 * Mode A, normal line: D4 HIGH pulls the line up through 1k (about 4.5 V).
 *   The ULN2003 sends; the sketch listens for the ECU pulling the line low.
 * Mode B, inverted line: D4 lets go, so the 10k holds the line low.
 *   D4 sends inverted bytes (start bit HIGH, 1 bits LOW), then lets go again;
 *   the sketch listens for the ECU driving the line high.
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

const uint8_t ULN_PIN = 2;   // HIGH = module pulls the line low
const uint8_t RX_PIN = 3;
const uint8_t DRV_PIN = 4;   // drives the line through 1k
const uint32_t BIT_US = 512;
const uint16_t MAXE = 160;
uint32_t edges[MAXE];

static inline bool lineHigh() { return PIND & _BV(RX_PIN); }  // faster than digitalRead
static inline void waitUntil(uint32_t t) { while ((int32_t)(micros() - t) < 0) {} }

static void drvHigh() { digitalWrite(DRV_PIN, HIGH); pinMode(DRV_PIN, OUTPUT); }
static void drvLow() { digitalWrite(DRV_PIN, LOW); pinMode(DRV_PIN, OUTPUT); }
static void drvRelease() { pinMode(DRV_PIN, INPUT); }  // INPUT also clears the pull-up

/* Mode A: send one byte, 8N1, through the inverting ULN2003 stage. */
static void sendNormal(uint8_t b) {
  uint32_t t0 = micros();
  digitalWrite(ULN_PIN, HIGH);                   // start bit: line low
  for (uint8_t i = 0; i < 8; i++) {
    waitUntil(t0 + (i + 1) * BIT_US);
    digitalWrite(ULN_PIN, (b >> i) & 1 ? LOW : HIGH);
  }
  waitUntil(t0 + 9 * BIT_US);
  digitalWrite(ULN_PIN, LOW);                    // stop bit: line high
  waitUntil(t0 + 10 * BIT_US);
}

/* Mode B: send one byte, 8N1 with inverted levels, through D4. */
static void sendInverted(uint8_t b) {
  uint32_t t0 = micros();
  drvHigh();                                     // start bit: line high
  for (uint8_t i = 0; i < 8; i++) {
    waitUntil(t0 + (i + 1) * BIT_US);
    if ((b >> i) & 1) drvLow(); else drvHigh();
  }
  waitUntil(t0 + 9 * BIT_US);
  drvLow();                                      // stop bit: line low
  waitUntil(t0 + 10 * BIT_US);
  drvRelease();
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

static const uint8_t ADDRS[] = { 0xFD, 0x14, 0x21 };

static void requests(char mode, void (*send)(uint8_t)) {
  char label[16];
  for (uint8_t a = 0; a < sizeof ADDRS; a++) {
    for (uint8_t r = 0; r < 3; r++) {
      send(ADDRS[a]);
      snprintf(label, sizeof label, "%c-req-%02X-%u", mode, ADDRS[a], r);
      capture(label, 500000UL);
      delay(100);
    }
  }
}

void setup() {
  digitalWrite(ULN_PIN, LOW);                    // module off before D2 becomes an output
  pinMode(ULN_PIN, OUTPUT);
  pinMode(RX_PIN, INPUT);
  drvRelease();
  Serial.begin(115200);
  delay(200);
  Serial.println(F("SNIFFER START"));

  drvHigh();                                     // mode A: pull-up on
  delay(50);
  capture("A-passive", 3000000UL);
  requests('A', sendNormal);

  drvRelease();                                  // mode B: line held low by 10k
  delay(50);
  capture("B-passive-1", 3000000UL);
  requests('B', sendInverted);
  capture("B-passive-2", 3000000UL);

  Serial.println(F("SNIFFER DONE"));
}

void loop() {}
