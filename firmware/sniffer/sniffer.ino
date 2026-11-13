/*
 * Line sniffer and verify tool for ECUs with an inverted diagnostic line (E935).
 *
 * The E935 leaves pin 1 low while idle and replies by driving it to 12 V:
 * start bit HIGH, 1 bits LOW, 1953 baud.
 *
 * Wiring: the inverted wiring from docs/wiring.md, the same as dsm_bridge
 * with WIRING_INVERTED:
 *   line -> 1k (R4) -> D4     transmits: drives the line to 0 V or 5 V
 *   line -> 2k      -> D5     pull-down: D5 LOW while idle and listening
 *   line -> 20k     -> D3     reads the line
 *   ULN2003 OUT1 must NOT be connected to the line.
 *
 * Commands at 115200 baud (opening the port resets the Uno and sends nothing):
 *   g            one edge-capture run over EDGE_ADDRS, 5 requests each
 *                output: "<addr>-<run> lvl0=<0|1> n=<edges> : t1 t2 ..." (µs after our start bit)
 *   v n a1..an   live verify: request n candidate addresses (1-16) in a loop
 *                output: "V <addr> <reply>" per request; reply "--" = none, "??" = framing error
 *   s            stop live verify
 *   npm run verify (src/verify.ts) drives the live mode.
 *
 * Safety:
 *   - Only CANDIDATES are sent, and each must also be MIN_BIT_ERRORS bit errors
 *     away from a blocked address (0xCA, 0xF1-0xFC, 0xFE, 0xFF), checked at runtime.
 *     E935_CANDIDATES in src/mmcd.ts must list the same addresses.
 *   - If the line is high while we drive it low, the ECU misread the request.
 *     The sketch lets go of the line and sends nothing more until it is reset.
 *   - D2 (ULN2003 input) stays LOW.
 */

const uint8_t ULN_PIN = 2;
const uint8_t RX_PIN = 3;
const uint8_t TX_PIN = 4;
const uint8_t PD_PIN = 5;
const uint32_t BIT_US = 512;
const uint32_t HALF_US = BIT_US / 2;
const uint32_t SETTLE_US = 150;  // after our own edge, through 1k and the line capacitance
const uint32_t REPLY_WAIT_US = 25000;
const uint8_t MIN_BIT_ERRORS = 2;
const uint16_t MAXE = 160;
uint32_t edges[MAXE];
bool locked = false;              // set after a misread; cleared only by a reset

static const uint8_t CANDIDATES[] = {
  0x00, 0x02, 0x06, 0x07, 0x0C, 0x0D, 0x0E, 0x0F, 0x13, 0x14, 0x15, 0x16,
  0x17, 0x1A, 0x1D, 0x21, 0x26, 0x29, 0x38, 0x39, 0x3A, 0x3B, 0x3C,
};
static const uint8_t EDGE_ADDRS[] = { 0x14, 0x07, 0x00, 0x21, 0x17 };
const uint8_t RUNS = 5;

#ifdef SNIFFER_SIM
static inline bool lineHigh() { return digitalRead(RX_PIN) == HIGH; }
#else
static inline bool lineHigh() { return PIND & _BV(RX_PIN); }  // faster than digitalRead
#endif
static inline void waitUntil(uint32_t t) { while ((int32_t)(micros() - t) < 0) {} }

static void txHigh() { digitalWrite(TX_PIN, HIGH); pinMode(TX_PIN, OUTPUT); }
static void txLow() { digitalWrite(TX_PIN, LOW); pinMode(TX_PIN, OUTPUT); }
static void txRelease() { pinMode(TX_PIN, INPUT); digitalWrite(TX_PIN, LOW); }
static void pdOn() { digitalWrite(PD_PIN, LOW); pinMode(PD_PIN, OUTPUT); }
static void pdOff() { pinMode(PD_PIN, INPUT); digitalWrite(PD_PIN, LOW); }

/* Hand the line to the pull-down: the idle and listening state. */
static void idleLine() { pdOn(); txRelease(); }

static bool isBlocked(uint8_t a) { return a == 0xCA || (a >= 0xF1 && a <= 0xFC) || a >= 0xFE; }

static uint8_t bitErrorsToBlocked(uint8_t a) {
  uint8_t min = 8;
  for (uint16_t b = 0; b <= 0xFF; b++) {
    if (!isBlocked(b)) continue;
    uint8_t x = a ^ b, n = 0;
    for (; x; x &= x - 1) n++;
    if (n < min) min = n;
  }
  return min;
}

/* Both gates: on the list, and far enough from every blocked address. */
static bool isCandidate(uint8_t a) {
  bool listed = false;
  for (uint8_t i = 0; i < sizeof CANDIDATES; i++) if (CANDIDATES[i] == a) listed = true;
  return listed && bitErrorsToBlocked(a) >= MIN_BIT_ERRORS;
}

static void printHex2(uint8_t v) {
  if (v < 0x10) Serial.print('0');
  Serial.print(v, HEX);
}

static void printEdges(const char *label, bool lvl0, uint16_t n) {
  Serial.print(label);
  Serial.print(F(" lvl0="));
  Serial.print(lvl0);
  Serial.print(F(" n="));
  Serial.print(n);
  Serial.print(F(" :"));
  for (uint16_t i = 0; i < n; i++) { Serial.print(' '); Serial.print(edges[i]); }
  Serial.println();
}

static void reportAbort(uint8_t b) {
  idleLine();
  locked = true;
  Serial.print(F("ABORT "));
  printHex2(b);
  Serial.println(F(": line high during our request. The ECU misread it. No more requests until reset."));
}

/* Log every level change for windowUs, without sending. */
static void passive(const char *label, uint32_t windowUs) {
  uint16_t n = 0;
  bool last = lineHigh();
  bool lvl0 = last;
  uint32_t start = micros();
  while (micros() - start < windowUs && n < MAXE) {
    bool l = lineHigh();
    if (l != last) { edges[n++] = micros() - start; last = l; }
  }
  printEdges(label, lvl0, n);
}

/*
 * Edge capture: send one inverted byte and log edges from its start bit on.
 * Returns false and releases the line if the ECU drives it during our request.
 */
static bool request(uint8_t b, const char *label, uint32_t windowUs) {
  if (locked || !isCandidate(b)) return false;
  uint16_t n = 0;
  bool last = lineHigh();
  bool lvl0 = last;
  bool drivenLow = false;
  uint32_t lastEdge = 0;
  uint8_t next = 0;                              // 0 start, 1-8 data, 9 stop, 10 release
  uint32_t t0 = micros();
  for (;;) {
    uint32_t dt = micros() - t0;
    if (dt >= windowUs || n >= MAXE) break;
    if (next <= 10 && dt >= next * BIT_US) {
      if (next == 0) { pdOff(); txHigh(); drivenLow = false; }
      else if (next <= 8) {
        drivenLow = (b >> (next - 1)) & 1;
        if (drivenLow) txLow(); else txHigh();
      }
      else if (next == 9) { txLow(); drivenLow = true; }
      else { idleLine(); drivenLow = false; }
      lastEdge = dt;
      next++;
    }
    bool l = lineHigh();
    if (drivenLow && l && dt - lastEdge > SETTLE_US) {
      printEdges(label, lvl0, n);
      reportAbort(b);
      return false;
    }
    if (l != last) { edges[n++] = micros() - t0; last = l; }
  }
  idleLine();
  printEdges(label, lvl0, n);
  return true;
}

// requestDecode() results. Plain constants: the Arduino IDE puts prototypes above any enum.
const uint8_t R_OK = 0, R_NONE = 1, R_FRAMING = 2, R_ABORTED = 3, R_BUSY = 4;

/* Send one inverted byte. Returns false after a misread (line high while we drive it low). */
static bool sendChecked(uint8_t b) {
  pdOff();
  uint32_t t0 = micros();
  txHigh();                                      // start bit
  for (uint8_t i = 0; i < 8; i++) {
    uint32_t edge = t0 + (i + 1) * BIT_US;
    waitUntil(edge);
    bool one = b & (1 << i);
    if (one) txLow(); else txHigh();
    waitUntil(edge + HALF_US);
    if (one && lineHigh()) return false;
  }
  waitUntil(t0 + 9 * BIT_US);
  txLow();                                       // stop bit
  waitUntil(t0 + 9 * BIT_US + HALF_US);
  if (lineHigh()) return false;
  waitUntil(t0 + 10 * BIT_US);
  idleLine();
  return true;
}

/* Live verify: send one candidate and decode the reply on the device. */
static uint8_t requestDecode(uint8_t b, uint8_t &out) {
  uint32_t w = micros();
  while (lineHigh()) if (micros() - w > REPLY_WAIT_US) return R_BUSY;  // the ECU still talks
  if (!sendChecked(b)) { reportAbort(b); return R_ABORTED; }
  uint32_t t0 = micros();
  while (!lineHigh()) if (micros() - t0 > REPLY_WAIT_US) return R_NONE;
  uint32_t tEdge = micros();
  waitUntil(tEdge + HALF_US);
  if (!lineHigh()) return R_FRAMING;             // glitch, not a start bit
  uint8_t v = 0;
  for (uint8_t i = 0; i < 8; i++) {
    waitUntil(tEdge + HALF_US + (i + 1) * BIT_US);
    if (!lineHigh()) v |= (1 << i);              // LOW = 1 bit
  }
  waitUntil(tEdge + HALF_US + 9 * BIT_US);
  if (lineHigh()) return R_FRAMING;              // stop bit must be low
  out = v;
  return R_OK;
}

/* Next command byte, or -1 after timeoutMs. */
static int readByteWithin(uint32_t timeoutMs) {
  uint32_t t0 = millis();
  while (!Serial.available()) if (millis() - t0 > timeoutMs) return -1;
  return Serial.read();
}

static void verifyLoop() {
  int n = readByteWithin(500);
  if (n < 1 || n > 16) { Serial.println(F("ERROR: send v, a count of 1-16, then the addresses")); return; }
  uint8_t addrs[16];
  for (int i = 0; i < n; i++) {
    int a = readByteWithin(500);
    if (a < 0) { Serial.println(F("ERROR: incomplete address list")); return; }
    addrs[i] = (uint8_t)a;
  }
  for (int i = 0; i < n; i++) {
    if (!isCandidate(addrs[i])) {
      Serial.print(F("REFUSED "));
      printHex2(addrs[i]);
      Serial.println(F(": not a candidate. Nothing was sent."));
      return;
    }
  }
  Serial.println(F("VERIFY START"));
  idleLine();
  for (;;) {
    for (int i = 0; i < n; i++) {
      if (Serial.available() && Serial.read() == 's') { idleLine(); Serial.println(F("VERIFY STOP")); return; }
      uint8_t v = 0;
      uint8_t r = requestDecode(addrs[i], v);
      if (r == R_ABORTED) return;
      Serial.print(F("V "));
      printHex2(addrs[i]);
      Serial.print(' ');
      if (r == R_OK) printHex2(v);
      else if (r == R_NONE) Serial.print(F("--"));
      else if (r == R_FRAMING) Serial.print(F("??"));
      else Serial.print(F("BUSY"));
      Serial.println();
      delay(5);
    }
  }
}

static void edgeRun() {
  Serial.println(F("RUN START"));
  idleLine();
  delay(50);
  passive("passive-1", 2000000UL);
  char label[12];
  for (uint8_t a = 0; a < sizeof EDGE_ADDRS && !locked; a++) {
    for (uint8_t r = 0; r < RUNS && !locked; r++) {
      snprintf(label, sizeof label, "%02X-%u", EDGE_ADDRS[a], r);
      request(EDGE_ADDRS[a], label, 40000UL);
      delay(200);
    }
  }
  if (!locked) passive("passive-2", 2000000UL);
  idleLine();
  Serial.println(locked ? F("RUN ABORTED") : F("RUN DONE"));
}

void setup() {
  digitalWrite(ULN_PIN, LOW);
  pinMode(ULN_PIN, OUTPUT);
  pinMode(RX_PIN, INPUT);
  txRelease();
  pdOff();
  locked = false;
  Serial.begin(115200);
  Serial.println(F("READY: g = edge run, v = live verify"));
}

void loop() {
  if (!Serial.available()) return;
  int c = Serial.read();
  if (c != 'g' && c != 'v') return;
  if (locked) { Serial.println(F("LOCKED: a request was misread. Reset the Arduino.")); return; }
  if (c == 'g') edgeRun(); else verifyLoop();
  txRelease();
  pdOff();
  Serial.println(F("READY: g = edge run, v = live verify"));
}
