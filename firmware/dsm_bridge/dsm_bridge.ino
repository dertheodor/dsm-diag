/*
 * 1G DSM diagnostic bridge for Arduino Uno (or clone).
 *
 * PC <-USB 115200-> Uno <-single wire, 1953.125 baud 8N1-> ECU diag pin 1
 *
 * Transparent: every byte from the PC is sent to the ECU; every byte seen on the
 * line (the echo of our own byte, then the ECU's reply) is forwarded to the PC.
 * So the TypeScript Ecu class works unchanged with { echo: true }.
 *
 * Timing is bit-banged with micros(): 1 bit = 512 µs exactly (16 MHz / 1953.125).
 * Interrupts stay enabled so USB bytes are never lost; jitter is a few µs.
 *
 * Pick the wiring that matches docs/wiring.md step 1.
 * ---------------------------------------------------------------------------
 * WIRING_5V (line measured ~5 V or ~0 V idle with voltcheck):
 *
 *   diag pin 1 ──[330R]── D2
 *   (only if line idled at ~0 V: diag pin 1 ──[4.7k]── Uno 5V)
 *   diag pin 10 ── diag pin 12 ── Uno GND
 *
 *   D2 is used open-drain: driven LOW for a 0 bit, released (input) for a 1 bit.
 *   It never drives HIGH, so the Uno and ECU can't fight.
 *
 * WIRING_12V (line measured ~12 V idle):
 *
 *   TX:  D2 ──[1k]── NPN base (PN2222/S8050), emitter ── GND,
 *        collector ──[100R]── diag pin 1
 *   RX:  diag pin 1 ──[10k]──[10k]──┬── D3
 *                                   └──[10k]── GND
 *   diag pin 10 ── diag pin 12 ── Uno GND
 *
 *   The transistor inverts: D2 HIGH pulls the line low. Handled below.
 *
 * WIRING_INVERTED (E935: line floats at 0 V in diagnostic mode, ECU drives it to 12 V):
 *
 *   TX:  diag pin 1 ──[1k]── D4     drives the line to 0 V or 5 V
 *   PD:  diag pin 1 ──[2k]── D5     pull-down: D5 LOW while idle and listening
 *   RX:  diag pin 1 ──[10k]──[10k]── D3
 *   diag pin 10 ── diag pin 12 ── Uno GND
 *
 *   The line idles low. A start bit and every 0 bit are HIGH, every 1 bit LOW.
 *   Only resistors touch the line: the ECU never sources more than 18 mA.
 *   Safety: only allowed() addresses are sent. If the line is high while we drive
 *   it low, the ECU misread the request: the bridge lets go of the line, answers
 *   with an inverted echo, and sends nothing more until the port is reopened.
 * ---------------------------------------------------------------------------
 */

// Pick ONE. Change to WIRING_12V or WIRING_INVERTED to match your adapter.
#if !defined(WIRING_5V) && !defined(WIRING_12V) && !defined(WIRING_INVERTED)
#define WIRING_5V
#endif

const uint32_t PC_BAUD = 115200;
const uint32_t BIT_US = 512;       // 1 / 1953.125 baud
const uint32_t HALF_US = BIT_US / 2;

static inline void waitUntil(uint32_t t) {
  while ((int32_t)(micros() - t) < 0) {}
}

#if defined(WIRING_INVERTED)

const uint8_t RX_PIN = 3;
const uint8_t TX_PIN = 4;
const uint8_t PD_PIN = 5;

/*
 * The only addresses this wiring sends. All are reads, verified on the E935
 * (docs/e935.md). E935_ALLOWED in src/mmcd.ts mirrors this list.
 */
static bool allowed(uint8_t a) {
  switch (a) {
    case 0x07: case 0x14: case 0x17: case 0x21:   // coolant, battery, throttle, rpm
    case 0x38: case 0x39: case 0x3B: case 0x3C:   // fault code words
      return true;
    default:
      return false;
  }
}

static bool locked = false;        // set after a misread; cleared only by a reset

static void txHigh() { digitalWrite(TX_PIN, HIGH); pinMode(TX_PIN, OUTPUT); }
static void txLow() { digitalWrite(TX_PIN, LOW); pinMode(TX_PIN, OUTPUT); }
static void txRelease() { pinMode(TX_PIN, INPUT); digitalWrite(TX_PIN, LOW); }
static void pdOn() { digitalWrite(PD_PIN, LOW); pinMode(PD_PIN, OUTPUT); }
static void pdOff() { pinMode(PD_PIN, INPUT); digitalWrite(PD_PIN, LOW); }

/* Hand the line to the pull-down: the idle and listening state. */
static void idleLine() { pdOn(); txRelease(); }

static inline bool lineIsHigh() { return digitalRead(RX_PIN) == HIGH; }

/* The ECU drove the line during our request: let go and stop for good. */
static void abortRequest(uint8_t b) {
  idleLine();
  locked = true;
  Serial.write((uint8_t)(b ^ 0xFF));           // a sure echo mismatch for the PC
  digitalWrite(LED_BUILTIN, LOW);
}

/* Send one byte with inverted levels, sampling mid-bit to capture the echo. */
static void sendByte(uint8_t b) {
  if (locked || !allowed(b)) return;           // no echo: the PC reports it
  uint8_t echo = 0;
  digitalWrite(LED_BUILTIN, HIGH);

  pdOff();
  uint32_t t0 = micros();
  txHigh();                                    // start bit
  for (uint8_t i = 0; i < 8; i++) {
    uint32_t edge = t0 + (i + 1) * BIT_US;
    waitUntil(edge);
    bool one = b & (1 << i);
    if (one) txLow(); else txHigh();
    waitUntil(edge + HALF_US);
    bool high = lineIsHigh();
    if (!high) echo |= (1 << i);
    if (one && high) return abortRequest(b);   // we drive low, the ECU drives high
  }
  waitUntil(t0 + 9 * BIT_US);
  txLow();                                     // stop bit
  waitUntil(t0 + 9 * BIT_US + HALF_US);
  if (lineIsHigh()) return abortRequest(b);
  waitUntil(t0 + 10 * BIT_US);
  idleLine();

  Serial.write(echo);
  digitalWrite(LED_BUILTIN, LOW);
}

/* Receive one inverted byte whose start bit began at tEdge. Returns false on framing error. */
static bool receiveByte(uint32_t tEdge, uint8_t &out) {
  waitUntil(tEdge + HALF_US);
  if (!lineIsHigh()) return false;             // glitch, not a start bit
  uint8_t v = 0;
  for (uint8_t i = 0; i < 8; i++) {
    waitUntil(tEdge + HALF_US + (i + 1) * BIT_US);
    if (!lineIsHigh()) v |= (1 << i);
  }
  waitUntil(tEdge + HALF_US + 9 * BIT_US);
  if (lineIsHigh()) return false;              // stop bit must be low
  out = v;
  return true;
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(RX_PIN, INPUT);
  idleLine();
  locked = false;
  Serial.begin(PC_BAUD);
  // Deliberately silent at boot: any byte we sent would look like ECU data.
}

void loop() {
  static bool armed = false;                   // only react to a LOW->HIGH edge

  if (Serial.available()) {
    sendByte((uint8_t)Serial.read());
    armed = false;                             // wait for idle-low before listening
    return;
  }

  if (!lineIsHigh()) {
    armed = true;
  } else if (armed) {
    uint32_t tEdge = micros();
    armed = false;
    uint8_t b;
    digitalWrite(LED_BUILTIN, HIGH);
    if (receiveByte(tEdge, b)) Serial.write(b);
    digitalWrite(LED_BUILTIN, LOW);
  }
}

#else  // WIRING_5V or WIRING_12V

#if defined(WIRING_5V)
const uint8_t TX_PIN = 2;
const uint8_t RX_PIN = 2;          // same pin: we read the line we drive
const bool TX_INVERTED = false;
#elif defined(WIRING_12V)
const uint8_t TX_PIN = 2;
const uint8_t RX_PIN = 3;
const bool TX_INVERTED = true;
#endif

static inline void lineLow() {
  if (TX_INVERTED) {
    digitalWrite(TX_PIN, HIGH);
  } else {
    digitalWrite(TX_PIN, LOW);     // clear PORT bit first: no HIGH glitch
    pinMode(TX_PIN, OUTPUT);
  }
}

static inline void lineRelease() {
  if (TX_INVERTED) digitalWrite(TX_PIN, LOW);
  else pinMode(TX_PIN, INPUT);     // high-Z; the line's pull-up makes it a 1
}

static inline bool lineIsHigh() { return digitalRead(RX_PIN) == HIGH; }

/* Send one byte, sampling the line mid-bit to capture the echo. */
static void sendByte(uint8_t b) {
  uint8_t echo = 0;
  digitalWrite(LED_BUILTIN, HIGH);

  uint32_t t0 = micros();
  lineLow();                                   // start bit
  for (uint8_t i = 0; i < 8; i++) {
    uint32_t edge = t0 + (i + 1) * BIT_US;
    waitUntil(edge);
    if (b & (1 << i)) lineRelease(); else lineLow();
    waitUntil(edge + HALF_US);
    if (lineIsHigh()) echo |= (1 << i);
  }
  waitUntil(t0 + 9 * BIT_US);
  lineRelease();                               // stop bit
  waitUntil(t0 + 10 * BIT_US);

  Serial.write(echo);
  digitalWrite(LED_BUILTIN, LOW);
}

/* Receive one byte whose start bit began at tEdge. Returns false on framing error. */
static bool receiveByte(uint32_t tEdge, uint8_t &out) {
  waitUntil(tEdge + HALF_US);
  if (lineIsHigh()) return false;              // glitch, not a start bit
  uint8_t v = 0;
  for (uint8_t i = 0; i < 8; i++) {
    waitUntil(tEdge + HALF_US + (i + 1) * BIT_US);
    if (lineIsHigh()) v |= (1 << i);
  }
  waitUntil(tEdge + HALF_US + 9 * BIT_US);
  if (!lineIsHigh()) return false;             // stop bit must be high
  out = v;
  return true;
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  if (TX_INVERTED) pinMode(TX_PIN, OUTPUT);
  if (RX_PIN != TX_PIN) pinMode(RX_PIN, INPUT);
  lineRelease();
  Serial.begin(PC_BAUD);
  // Deliberately silent at boot: any byte we sent would look like ECU data.
}

void loop() {
  static bool armed = false;                   // only react to a HIGH->LOW edge

  if (Serial.available()) {
    sendByte((uint8_t)Serial.read());
    armed = false;                             // wait for idle-high before listening
    return;
  }

  if (lineIsHigh()) {
    armed = true;
  } else if (armed) {
    uint32_t tEdge = micros();
    armed = false;
    uint8_t b;
    digitalWrite(LED_BUILTIN, HIGH);
    if (receiveByte(tEdge, b)) Serial.write(b);
    digitalWrite(LED_BUILTIN, LOW);
  }
}

#endif
