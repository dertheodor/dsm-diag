// Host simulation of dsm_bridge.ino: virtual clock, open-drain wire, fake ECU.
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
void pinMode(int p, int m) { mode[p] = m; }
void digitalWrite(int p, int v) { out[p] = v; }
// fake ECU transmitter
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
#ifndef INV
static int unoPullsLow() { return mode[2] == OUTPUT && out[2] == LOW; }
#else
static int unoPullsLow() { return out[2] == HIGH; } // NPN stage
#endif
int digitalRead(int p) { now += 1; return (!unoPullsLow() && ecuLevel(now)) ? HIGH : LOW; }
struct S {
  std::deque<uint8_t> in; std::vector<uint8_t> outb;
  void begin(long) {} int available() { return !in.empty(); }
  int read() { uint8_t b = in.front(); in.pop_front();
    // ECU replies 1.5 ms after our 10-bit frame ends
    ecuQueue.push_back({now + 10 * 512 + 1500, (uint8_t)(b ^ 0x5A)}); return b; }
  void write(uint8_t b) { outb.push_back(b); }
} Serial;
#include "../firmware/dsm_bridge/dsm_bridge.ino"
int main() {
  srand(42);
  for (int jm : {2, 8, 30}) {
    jitterMax = jm; Serial.outb.clear(); setup();
    int ok = 0, N = 256;
    for (int a = 0; a < N; a++) {
      Serial.in.push_back(a);
      uint64_t until = now + 15000;
      while (now < until) loop();
      size_t n = Serial.outb.size();
      if (n >= 2 && Serial.outb[n-2] == a && Serial.outb[n-1] == (a ^ 0x5A)) ok++;
    }
    printf("jitter<=%2dus/call: %d/%d echo+reply correct, %zu bytes out\n", jm, ok, N, Serial.outb.size());
  }
}
