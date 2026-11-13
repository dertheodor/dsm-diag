/**
 * Quick terminal tester.
 *
 *   npx tsx src/cli.ts <port> [--ftdi] [--e935] [--dump] [--sensors rpm,batt,tps]
 *
 *   <port>      /dev/ttyUSB0, /dev/tty.usbserial-xxxx, COM5 …
 *   --ftdi      FTDI cable wired directly (default: Arduino Uno bridge)
 *   --e935      E935 profile: inverted wiring, only verified addresses, no version byte, no --dump
 *   --dump      also dump the RAM window 0x40–0xF0 to ram-<timestamp>.json
 *   --sensors   comma-separated sensor ids to poll (default: all)
 *
 * Bring-up order: version → battery (compare with a multimeter) → faults → live polling.
 */
import { writeFileSync } from 'node:fs';
import { E935_ALLOWED, Ecu, ProtocolError, SENSORS, hex } from './mmcd.js';
import { NodeSerialTransport } from './nodeserial.js';

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--'));
if (!path) {
  console.error('usage: npx tsx src/cli.ts <port> [--ftdi] [--e935] [--dump] [--sensors rpm,batt]');
  process.exit(1);
}
const adapter = args.includes('--ftdi') ? 'ftdi' : 'uno';
const e935 = args.includes('--e935');
if (e935 && args.includes('--dump')) {
  console.error('--dump is off in the E935 profile: it reads unverified addresses.');
  process.exit(1);
}
const available = e935 ? SENSORS.filter((s) => E935_ALLOWED.has(s.addr)) : SENSORS;
const sensorArg = args[args.indexOf('--sensors') + 1];
const sensors = args.includes('--sensors')
  ? available.filter((s) => sensorArg.split(',').includes(s.id))
  : available;

const t = await NodeSerialTransport.open(path, adapter);
const ecu = new Ecu(t, e935
  ? { echo: true, timeoutMs: 150, retries: 1, allow: E935_ALLOWED }
  : { echo: true, timeoutMs: 150 });
process.on('SIGINT', async () => {
  await t.close();
  process.exit(0);
});

if (!e935) {
  const v = await ecu.version();
  console.log(`ECU version byte 0x${hex(v.raw)} (${v.cpu})`);
}

const batt = SENSORS.find((s) => s.id === 'batt')!;
console.log(`Battery ${(await ecu.readSensor(batt)).toFixed(2)} V  ← compare with a multimeter`);

const f = await ecu.readFaults();
const fmt = (l: typeof f.active) => (l.length ? l.map((x) => `${x.code} ${x.name}`).join(', ') : 'none');
console.log(`Active faults: ${fmt(f.active)}\nStored faults: ${fmt(f.stored)}`);

if (args.includes('--dump')) {
  const ram = await ecu.dumpRam((a) => process.stdout.write(`\rRAM 0x${hex(a)}`));
  const file = `ram-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(Object.fromEntries([...ram].map(([a, b]) => [`0x${hex(a)}`, b])), null, 1));
  console.log(`\nwrote ${file}`);
}

console.log('\nLive data (Ctrl+C to stop)');
for (;;) {
  const start = performance.now();
  const parts: string[] = [];
  for (const s of sensors) {
    try {
      parts.push(`${s.id} ${(await ecu.readSensor(s)).toFixed(1)}${s.unit}`);
    } catch (e) {
      if (e935 && e instanceof ProtocolError && e.kind === 'echo-mismatch') {
        console.error(`\nStopped for safety, the ECU may have misread a request: ${e.message}`);
        await t.close();
        process.exit(1);
      }
      parts.push(`${s.id} ERR`);
      console.error(`\n${(e as Error).message}`);
    }
  }
  const hz = (sensors.length * 1000) / (performance.now() - start);
  process.stdout.write(`\r${parts.join(' | ')}  [${hz.toFixed(0)} req/s]   `);
}
