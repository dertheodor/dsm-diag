// Host simulation of firmware/sniffer: virtual clock, inverted line, fake E935.
// The fake ECU decodes what the sketch really drives onto the wire and replies addr ^ 0x5A.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <string>
#include <vector>
#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define HEX 16
#define DEC 10
#define F(s) (s)
#define SNIFFER_SIM
static uint64_t now = 0;
uint32_t micros() { now += 1 + rand() % 8; return (uint32_t)now; }
uint32_t millis() { return (uint32_t)(micros() / 1000); }
void delay(unsigned long ms) { now += ms * 1000; }
static int mode[20], out[20];
static void txHook();
void pinMode(int p, int m) { mode[p] = m; txHook(); }
void digitalWrite(int p, int v) { out[p] = v; txHook(); }

/* Fake ECU: UART level 1 = mark (idle); on the inverted line a space is HIGH. */
static int64_t ecuStart = -1; static uint8_t ecuByte;
static std::deque<std::pair<uint64_t, uint8_t>> ecuQueue;
static int ecuLevel(uint64_t t) {
  if (ecuStart < 0 && !ecuQueue.empty() && t >= ecuQueue.front().first) {
    ecuStart = ecuQueue.front().first; ecuByte = ecuQueue.front().second; ecuQueue.pop_front(); }
  if (ecuStart < 0) return 1;
  int64_t bit = ((int64_t)t - ecuStart) / 512;
  if (bit >= 10) { ecuStart = -1; return 1; }
  if (bit == 0) return 0;
  if (bit == 9) return 1;
  return (ecuByte >> (bit - 1)) & 1;
}
static int unoHigh() { return mode[4] == OUTPUT && out[4] == HIGH; }

/* The ECU's receiver: records the sketch's drive level and decodes each frame. */
static std::vector<std::pair<uint64_t, int>> trs;
static bool rxActive = false; static uint64_t rxStart; static int lastHigh = 0;
static std::vector<uint8_t> sent;        // every byte the ECU received
static bool ecuEarly = false;            // ECU starts talking during the next request
static int silentAddr = -1;              // ECU ignores this address
static void txHook() {
  int h = unoHigh();
  if (h == lastHigh) return;
  lastHigh = h;
  if (h && !rxActive) {
    rxActive = true; rxStart = now; trs.clear();
    if (ecuEarly) { ecuQueue.push_back({now + 3 * 512, 0x00}); ecuEarly = false; }
  }
  if (rxActive) trs.push_back({now, h});
}
static int driveAt(uint64_t t) { int h = 0; for (auto &x : trs) if (x.first <= t) h = x.second; return h; }
static void ecuReceive() {
  if (!rxActive || now < rxStart + 10 * 512 + 20) return;
  rxActive = false;
  uint8_t v = 0;
  for (int i = 0; i < 8; i++) if (!driveAt(rxStart + 512 * (i + 1) + 256)) v |= 1 << i;
  bool startOk = driveAt(rxStart + 256), stopOk = !driveAt(rxStart + 9 * 512 + 256);
  if (!startOk || !stopOk) return;
  sent.push_back(v);
  if (v != silentAddr) ecuQueue.push_back({now + 1500, (uint8_t)(v ^ 0x5A)});
}
int digitalRead(int) { now += 1; ecuReceive(); return (unoHigh() || !ecuLevel(now)) ? HIGH : LOW; }

struct S {
  std::deque<std::pair<uint64_t, uint8_t>> in; std::string outs;
  void begin(long) {}
  int available() { return !in.empty() && in.front().first <= now; }
  int read() { uint8_t b = in.front().second; in.pop_front(); return b; }
  void write(uint8_t b) { outs += (char)b; }
  void print(const char *s) { outs += s; }
  void print(char c) { outs += c; }
  void print(unsigned long v, int base = DEC) { char b[24]; snprintf(b, sizeof b, base == HEX ? "%lX" : "%lu", v); outs += b; }
  void print(int v, int base = DEC) { print((unsigned long)v, base); }
  void print(unsigned v, int base = DEC) { print((unsigned long)v, base); }
  void print(uint8_t v, int base = DEC) { print((unsigned long)v, base); }
  void print(bool v) { print((unsigned long)v); }
  template <class T> void println(T v) { print(v); outs += "\n"; }
  void println() { outs += "\n"; }
} Serial;
#define _BV(b) (1 << (b))
#include "../firmware/sniffer/sniffer.ino"

static int failures = 0;
static void check(bool ok, const char *what) {
  printf("%s %s\n", ok ? "ok  " : "FAIL", what);
  if (!ok) failures++;
}
static void send(std::vector<uint8_t> bytes, uint64_t at = 0) {
  for (auto b : bytes) Serial.in.push_back({at ? at : now, b});
}
static void runFor(uint64_t us) { uint64_t until = now + us; while (now < until) { loop(); now += 10; } }
static bool has(const char *s) { return Serial.outs.find(s) != std::string::npos; }

int main() {
  srand(42);
  setup();

  // Live verify: three candidates, stop after about 0.3 s.
  Serial.outs.clear(); sent.clear(); silentAddr = 0x26;
  send({'v', 4, 0x14, 0x06, 0x3A, 0x26});
  send({'s'}, now + 300000);
  runFor(400000);
  check(has("VERIFY START") && has("VERIFY STOP"), "verify starts and stops on s");
  check(has("V 14 4E") && has("V 06 5C") && has("V 3A 60"), "verify decodes inverted replies (addr ^ 0x5A)");
  check(has("V 26 --"), "verify reports a missing reply as --");
  bool onlyAsked = true;
  for (auto b : sent) if (b != 0x14 && b != 0x06 && b != 0x3A && b != 0x26) onlyAsked = false;
  check(!sent.empty() && onlyAsked, "the ECU received only the requested addresses");

  // Refusals: nothing may reach the line.
  for (uint8_t a : {0xFD, 0xCA, 0xF1, 0xFC, 0xFE, 0xFF, 0x40}) {
    Serial.outs.clear(); sent.clear();
    send({'v', 2, 0x14, a});
    runFor(50000);
    char want[32]; snprintf(want, sizeof want, "REFUSED %02X", a);
    char what[64]; snprintf(what, sizeof what, "0x%02X refused, nothing sent", a);
    check(has(want) && sent.empty(), what);
  }

  // Misread: the ECU talks during our request.
  Serial.outs.clear(); sent.clear(); ecuEarly = true;
  send({'v', 1, 0x14});
  send({'s'}, now + 200000);
  runFor(250000);
  check(has("ABORT 14"), "a reply during the request aborts");
  Serial.outs.clear(); sent.clear();
  send({'v', 1, 0x14});
  runFor(50000);
  check(has("LOCKED") && sent.empty(), "after an abort, nothing is sent until reset");

  if (failures) printf("FAILED: %d\n", failures);
  return failures ? 1 : 0;
}
