/** Offline self-test against a simulated ECU (echo + 1-byte reply). Run: npx tsx src/selftest.ts */
import { Ecu, SENSORS, type Transport } from './mmcd.js';

class FakeEcu implements Transport {
  private q: number[] = [];
  private ram: Record<number, number> = { 0x21: 28, 0x17: 26, 0x06: 25, 0x14: 190, 0x38: 0b1, 0x39: 0, 0x3b: 0x41, 0x3c: 0x00, 0xfd: 0xb5 };
  async write(b: number) { this.q.push(b, this.ram[b] ?? 0x80); }
  async readByte() { return this.q.shift() ?? null; }
  flush() { this.q.length = 0; }
}

const ecu = new Ecu(new FakeEcu());
console.log('version', await ecu.version());
for (const s of SENSORS.slice(0, 4)) console.log(s.name, (await ecu.readSensor(s)).toFixed(1), s.unit);
console.log('faults', JSON.stringify(await ecu.readFaults()));
console.log('ram bytes', (await ecu.dumpRam()).size);
