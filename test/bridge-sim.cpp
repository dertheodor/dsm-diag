// Host simulation of dsm_bridge.ino: virtual clock, single wire, fake ECU.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <vector>
#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define LED_BUILTIN 13
static uint64_t now = 0;
static int jitterMax = 8;
uint32_t micros() { now += 1 + rand() % jitterMax; return (uint32_t)now; }
static int mode[20], out[20];
static void txHook();
void pinMode(int p, int m) { mode[p] = m; txHook(); }
void digitalWrite(int p, int v) { out[p] = v; txHook(); }
// fake ECU transmitter: UART level, 1 = mark (idle)
static int64_t ecuStart = -1; static uint8_t ecuByte;
static std::deque<std::pair<uint64_t,uint8_t>> ecuQueue;
static int ecuLevel(uint64_t t) {
  if (ecuStart < 0 && !ecuQueue.empty() && t >= ecuQueue.front().first) {
    ecuStart = ecuQueue.front().first; ecuByte = ecuQueue.front().second; ecuQueue.pop_front(); }
  if (ecuStart < 0) return 1;
  int64_t bit = ((int64_t)t - ecuStart) / 512;   // ECU uses exact 512 µs bits
  if (bit >= 10) { ecuStart = -1; return 1; }
  if (bit == 0) return 0;
  if (bit == 9) return 1;
  return (ecuByte >> (bit - 1)) & 1;
}
#if defined(WIRING_INVERTED)
// Line idles low; the ECU drives it high for a space, D4 drives it high or low.
static bool ecuEarly = false;      // ECU starts talking during our request
static int pendingReply = -1;      // queued once the bridge really transmits
static int unoDrivesHigh() { return mode[4] == OUTPUT && out[4] == HIGH; }
static void txHook() {
  if (pendingReply < 0 || !unoDrivesHigh()) return;
  uint64_t at = ecuEarly ? now + 3 * 512 : now + 10 * 512 + 1500;
  ecuQueue.push_back({at, (uint8_t)pendingReply});
  pendingReply = -1;
}
int digitalRead(int) { now += 1; return (unoDrivesHigh() || !ecuLevel(now)) ? HIGH : LOW; }
#else
static void txHook() {}
#ifndef INV
static int unoPullsLow() { return mode[2] == OUTPUT && out[2] == LOW; }
#else
static int unoPullsLow() { return out[2] == HIGH; } // NPN stage
#endif
int digitalRead(int) { now += 1; return (!unoPullsLow() && ecuLevel(now)) ? HIGH : LOW; }
#endif
struct S {
  std::deque<uint8_t> in; std::vector<uint8_t> outb;
  void begin(long) {} int available() { return !in.empty(); }
  int read() { uint8_t b = in.front(); in.pop_front();
#if defined(WIRING_INVERTED)
    pendingReply = b ^ 0x5A;
#else
    // ECU replies 1.5 ms after our 10-bit frame ends
    ecuQueue.push_back({now + 10 * 512 + 1500, (uint8_t)(b ^ 0x5A)});
#endif
    return b; }
  void write(uint8_t b) { outb.push_back(b); }
} Serial;
#include "../firmware/dsm_bridge/dsm_bridge.ino"

static size_t request(uint8_t a) {
  size_t before = Serial.outb.size();
  Serial.in.push_back(a);
  uint64_t until = now + 15000;
  while (now < until) loop();
  return Serial.outb.size() - before;
}

int main() {
  srand(42);
  int failures = 0;
  for (int jm : {2, 8, 30}) {
    jitterMax = jm; Serial.outb.clear(); setup();
    int ok = 0, N = 256;
    for (int a = 0; a < N; a++) {
      size_t got = request(a);
      size_t n = Serial.outb.size();
#if defined(WIRING_INVERTED)
      if (!allowed(a)) { if (got == 0) ok++; else failures++; continue; }
#endif
      if (got == 2 && Serial.outb[n-2] == a && Serial.outb[n-1] == (a ^ 0x5A)) ok++;
      else failures++;
    }
    printf("jitter<=%2dus/call: %d/%d correct (allowed: echo+reply, blocked: silent), %zu bytes out\n",
           jm, ok, N, Serial.outb.size());
  }
#if defined(WIRING_INVERTED)
  // The ECU talks during our request: the bridge must abort, then stay silent.
  jitterMax = 8; Serial.outb.clear(); setup();
  ecuEarly = true;
  size_t got = request(0x14);
  bool aborted = got >= 1 && Serial.outb[0] == (0x14 ^ 0xFF);
  ecuEarly = false;
  bool silent = request(0x14) == 0;
  printf("misread: %s, afterwards: %s\n", aborted ? "aborted" : "NOT ABORTED", silent ? "locked" : "NOT LOCKED");
  if (!aborted || !silent) failures++;
#endif
  if (failures) printf("FAILED: %d\n", failures);
  return failures ? 1 : 0;
}
