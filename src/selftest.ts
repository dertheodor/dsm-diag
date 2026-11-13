/** Offline self-test against a simulated ECU (echo + 1-byte reply). Run: npx tsx src/selftest.ts */
import { readFileSync } from 'node:fs';
import {
  E935_ALLOWED, E935_CANDIDATES, E935_STATUS, Ecu, MIN_BIT_ERRORS, ProtocolError, SENSORS,
  bitErrorsToBlocked, isBridgeAbort, type Transport,
} from './mmcd.js';
import { parseAddressList, parseVerifyLine, usValue } from './verify-format.js';

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

/* Gate consistency: the firmware lists must match the TypeScript lists. */
const hexList = (src: string) => new Set([...src.matchAll(/0x([0-9A-Fa-f]{2})/g)].map((m) => parseInt(m[1], 16)));
const sameSet = (a: ReadonlySet<number>, b: ReadonlySet<number>) => a.size === b.size && [...a].every((x) => b.has(x));
const sniffer = readFileSync('firmware/sniffer/sniffer.ino', 'utf8');
const snifferList = /CANDIDATES\[\] = \{([^}]*)\}/.exec(sniffer)?.[1] ?? '';
check(sameSet(hexList(snifferList), E935_CANDIDATES), 'sniffer CANDIDATES match E935_CANDIDATES');
const bridge = readFileSync('firmware/dsm_bridge/dsm_bridge.ino', 'utf8');
const bridgeList = /static bool allowed\(uint8_t a\) \{([\s\S]*?)return true;/.exec(bridge)?.[1] ?? '';
check(sameSet(hexList(bridgeList), E935_ALLOWED), 'bridge allowed() matches E935_ALLOWED');

/* The safety rule holds for every list. */
check(bitErrorsToBlocked(0xfd) === 1 && bitErrorsToBlocked(0x3a) === 2 && bitErrorsToBlocked(0xca) === 0, 'bit distance to blocked addresses');
check([...E935_CANDIDATES].every((a) => bitErrorsToBlocked(a) >= MIN_BIT_ERRORS), 'every candidate meets the bit-error rule');
check([...E935_ALLOWED].every((a) => E935_CANDIDATES.has(a)), 'every allowed address is a candidate');
check([...E935_STATUS.keys()].every((a) => E935_ALLOWED.has(a)), 'every status belongs to an allowed address');

/* Verify tool parsing. */
const v = parseVerifyLine('V 14 A8');
check(v.kind === 'value' && v.addr === 0x14 && v.raw === 0xa8, 'verify: parses a value line');
const none = parseVerifyLine('V 26 --');
check(none.kind === 'value' && none.raw === null && !none.framing, 'verify: parses a missing reply');
check(parseVerifyLine('ABORT 14: line high').kind === 'abort', 'verify: parses an abort');
check(usValue(0x14, 0xa8) === '12.31 V', 'verify: US scaling for battery');
check(usValue(0x02, 0x80) === 'Idle switch', 'verify: flag names');
check(JSON.stringify(parseAddressList('06, 0x3a,13')) === JSON.stringify([0x06, 0x3a, 0x13]), 'verify: address list');
for (const bad of ['fd', 'ca', '40', 'zz'])
  check(!!(() => { try { parseAddressList(bad); return false; } catch { return true; } })(), `verify: refuses "${bad}"`);
