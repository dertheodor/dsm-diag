/**
 * Simulated adapter + ECU so the dashboard can be tried without the car.
 * Timeline: adapter "plugged in" after 2 s, ECU answers after 6 s (ignition on).
 */
import type { Transport } from '../mmcd.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const start = Date.now();
const since = () => (Date.now() - start) / 1000;

export const simAdapterPresent = () => since() > 2;
const ecuOn = () => since() > 6;

let storedFaults = 0b0000_0000_0100_0000; // bit 6 = code 22 (crank angle sensor) stored

function ecuByte(addr: number): number {
  const t = since();
  const rev = 850 + 40 * Math.sin(t * 1.7) + (Math.sin(t / 7) > 0.92 ? 2600 : 0);
  const warm = Math.min(1, t / 240);
  switch (addr) {
    case 0x21: return Math.round(rev / 31.25);
    case 0x17: return rev > 1500 ? 90 : 13;
    case 0x06: return Math.round(10 + 12 + 3 * Math.sin(t));
    case 0x07: return Math.round(170 - 75 * warm);      // ~20 °C → ~88 °C
    case 0x3a: return Math.round(150);
    case 0x13: return Math.round(25 + 20 * (Math.sin(t * 3) > 0 ? 1 : 0));
    case 0x14: return Math.round(14.1 / 0.0733);
    case 0x15: return Math.round(0.96 / 0.00486);
    case 0x1a: return Math.round(rev / 60);
    case 0x29: return Math.round(2.6 / 0.256 + (rev > 1500 ? 6 : 0));
    case 0x16: return 32;
    case 0x26: return Math.sin(t / 3) > 0.97 ? 3 : 0;
    case 0x0c: case 0x0d: case 0x0e: return 128 + ((addr * 7) % 9) - 4;
    case 0x0f: return Math.round(128 + 6 * Math.sin(t * 2));
    case 0x1d: return rev > 1500 ? 40 : 0;
    case 0x02: return 0x80 | 0x20 | (Math.sin(t * 0.5) > 0.6 ? 0x10 : 0);
    case 0x00: return Math.sin(t * 0.5) > 0.6 ? 0x20 : 0;
    case 0x38: case 0x39: return 0;
    case 0x3b: return storedFaults & 0xff;
    case 0x3c: return storedFaults >> 8;
    case 0xca: storedFaults = 0; return 0;
    case 0xfd: return 0xb9;
    default: return (addr * 37 + Math.floor(t * (addr % 5))) & 0xff;
  }
}

export class SimTransport implements Transport {
  private q: number[] = [];
  async write(addr: number) {
    await sleep(10); // ~2 bytes at 1953 baud
    this.q.push(addr);
    if (ecuOn()) this.q.push(ecuByte(addr));
  }
  async readByte(timeoutMs: number) {
    if (this.q.length) return this.q.shift()!;
    await sleep(timeoutMs);
    return null;
  }
  flush() { this.q.length = 0; }
  onClose(_cb: () => void) {}
  async close() {}
}
