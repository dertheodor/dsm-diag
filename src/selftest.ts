/** Offline self-test against a simulated ECU (echo + 1-byte reply). Run: npx tsx src/selftest.ts */
import { E935_ALLOWED, Ecu, ProtocolError, SENSORS, isBridgeAbort, type Transport } from './mmcd.js';

class FakeEcu implements Transport {
  private q: number[] = [];
  readonly sent: number[] = [];
  /** Requests the ECU ignores before it answers (echo only, no reply). */
  silent = 0;
  private ram: Record<number, number> = { 0x21: 28, 0x17: 26, 0x06: 25, 0x14: 190, 0x38: 0b1, 0x39: 0, 0x3b: 0x41, 0x3c: 0x00, 0xfd: 0xb5 };
  async write(b: number) {
    this.sent.push(b);
    this.q.push(b);
    if (this.silent > 0) this.silent--;
    else this.q.push(this.ram[b] ?? 0x80);
  }
  async readByte() { return this.q.shift() ?? null; }
  flush() { this.q.length = 0; }
}

function check(ok: boolean, what: string) {
  if (!ok) {
    console.error(`FAIL: ${what}`);
    process.exit(1);
  }
  console.log(`ok   ${what}`);
}

const ecu = new Ecu(new FakeEcu());
console.log('version', await ecu.version());
for (const s of SENSORS.slice(0, 4)) console.log(s.name, (await ecu.readSensor(s)).toFixed(1), s.unit);
console.log('faults', JSON.stringify(await ecu.readFaults()));
console.log('ram bytes', (await ecu.dumpRam()).size);

/* E935 profile: allowlist and retries. */
const fake = new FakeEcu();
const e935 = new Ecu(fake, { echo: true, timeoutMs: 10, retries: 1, allow: E935_ALLOWED });
check((await e935.request(0x14)) === 190, 'E935: allowed address answers');
for (const addr of [0xfd, 0xca, 0xf1, 0xfc, 0xfe, 0xff, 0x00, 0x40]) {
  const before = fake.sent.length;
  const refused = await e935.request(addr).then(() => false, (e) => e instanceof RangeError);
  check(refused && fake.sent.length === before, `E935: 0x${addr.toString(16).toUpperCase()} refused before sending`);
}
fake.silent = 1;
check((await e935.request(0x21)) === 28, 'E935: one missed reply is retried');
fake.silent = 2;
const gaveUp = await e935.request(0x21).then(() => false, (e) => e instanceof ProtocolError && e.kind === 'no-reply');
check(gaveUp, 'E935: gives up after one retry');

/* Only an inverted echo is the bridge's misread signature; a wiring fault is not. */
const mismatch = (sent: number, got: number) => new ProtocolError('echo mismatch', 'echo-mismatch', { sent, got });
check(isBridgeAbort(mismatch(0x14, 0xeb)), 'E935: inverted echo is a bridge abort');
check(!isBridgeAbort(mismatch(0x14, 0xff)), 'E935: echo 0xFF is a wiring fault, not an abort');
check(!isBridgeAbort(mismatch(0x14, 0x00)), 'E935: echo 0x00 is a wiring fault, not an abort');
