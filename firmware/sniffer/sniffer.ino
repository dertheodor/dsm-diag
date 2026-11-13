/*
 * Line sniffer for ECUs with an inverted diagnostic line, such as the E935.
 *
 * The E935 leaves pin 1 low while idle and replies by driving it to 12 V:
 * start bit HIGH, 1 bits LOW, 1953 baud. This sketch sends whitelisted read
 * requests in that polarity and logs every edge of the reply.
 *
 * Wiring (docs/wiring.md, inverted variant):
 *   line -> 1k (R4) -> D4     transmits: drives the line to 0 V or 5 V
 *   line -> 2k      -> D5     pull-down: D5 LOW while idle and listening
 *   line -> 20k     -> D3     reads the line
 *   ULN2003 OUT1 must NOT be connected to the line.
 *
 * Safety:
 *   - Nothing is sent until the PC sends 'g'. Reset, upload and port open send nothing.
 *   - Only whitelisted read addresses. 0xFD is left out: one bit error turns it
 *     into 0xFC (actuator test) or 0xFF.
 *   - If the line goes high while we drive it low, the ECU misread the request.
 *     The sketch then releases the line and sends nothing more in that run.
 *   - D2 (ULN2003 input) stays LOW.
 *
 * Output per request: "<addr>-<run> lvl0=<0|1> n=<edges> : t1 t2 ..."
 *   t  microseconds after our start bit, one per level change.
 *   Our request occupies 0-5120 us; the reply follows.
 */

const uint8_t ULN_PIN = 2;
const uint8_t RX_PIN = 3;
const uint8_t TX_PIN = 4;
const uint8_t PD_PIN = 5;
const uint32_t BIT_US = 512;
const uint32_t SETTLE_US = 150;  // after our own edge, through 1k and the line capacitance
const uint16_t MAXE = 160;
uint32_t edges[MAXE];
bool aborted = false;

static const uint8_t WHITELIST[] = { 0x14, 0x07, 0x00, 0x21, 0x17 };
const uint8_t RUNS = 5;

static inline bool lineHigh() { return PIND & _BV(RX_PIN); }  // faster than digitalRead

static void txHigh() { digitalWrite(TX_PIN, HIGH); pinMode(TX_PIN, OUTPUT); }
static void txLow() { digitalWrite(TX_PIN, LOW); pinMode(TX_PIN, OUTPUT); }
static void txRelease() { pinMode(TX_PIN, INPUT); }   // INPUT also clears the pull-up
static void pdOn() { digitalWrite(PD_PIN, LOW); pinMode(PD_PIN, OUTPUT); }
static void pdOff() { pinMode(PD_PIN, INPUT); }

/* Hand the line to the pull-down: the idle and listening state. */
static void idleLine() { pdOn(); txRelease(); }

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
 * Send one inverted byte and log edges from its start bit on.
 * Returns false and releases the line if the ECU drives it during our request.
 */
static bool request(uint8_t b, const char *label, uint32_t windowUs) {
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
      idleLine();
      printEdges(label, lvl0, n);
      Serial.print(F("ABORT: line high during our request at "));
      Serial.print(dt);
      Serial.println(F(" us. The ECU misread it. No more requests."));
      return false;
    }
    if (l != last) { edges[n++] = micros() - t0; last = l; }
  }
  idleLine();
  printEdges(label, lvl0, n);
  return true;
}

static void run() {
  Serial.println(F("RUN START"));
  idleLine();
  delay(50);
  passive("passive-1", 2000000UL);
  char label[12];
  for (uint8_t a = 0; a < sizeof WHITELIST && !aborted; a++) {
    for (uint8_t r = 0; r < RUNS && !aborted; r++) {
      snprintf(label, sizeof label, "%02X-%u", WHITELIST[a], r);
      if (!request(WHITELIST[a], label, 40000UL)) aborted = true;
      delay(200);
    }
  }
  if (!aborted) passive("passive-2", 2000000UL);
  idleLine();
  Serial.println(aborted ? F("RUN ABORTED") : F("RUN DONE"));
}

void setup() {
  digitalWrite(ULN_PIN, LOW);
  pinMode(ULN_PIN, OUTPUT);
  pinMode(RX_PIN, INPUT);
  txRelease();
  pdOff();
  Serial.begin(115200);
  Serial.println(F("READY: send g to start one run"));
}

void loop() {
  if (Serial.available() && Serial.read() == 'g') {
    aborted = false;
    run();
    txRelease();
    pdOff();
    Serial.println(F("READY: send g to start one run"));
  }
}
