/**
 * Quick terminal tester.
 *
 *   npx tsx src/cli.ts <port> [--ftdi] [--dump] [--sensors rpm,batt,tps]
 *
 *   <port>      /dev/ttyUSB0, /dev/tty.usbserial-xxxx, COM5 …
 *   --ftdi      FTDI cable wired directly (default: Arduino Uno bridge)
 *   --dump      also dump the RAM window 0x40–0xF0 to ram-<timestamp>.json
 *   --sensors   comma-separated sensor ids to poll (default: all)
 *
 * Bring-up order: version → battery (compare with a multimeter) → faults → live polling.
 */
import { writeFileSync } from 'node:fs';
import { Ecu, SENSORS, hex } from './mmcd.js';
import { NodeSerialTransport } from './nodeserial.js';

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--'));
if (!path) {
  console.error('usage: npx tsx src/cli.ts <port> [--ftdi] [--dump] [--sensors rpm,batt]');
  process.exit(1);
}
const adapter = args.includes('--ftdi') ? 'ftdi' : 'uno';
const sensorArg = args[args.indexOf('--sensors') + 1];
const sensors = args.includes('--sensors')
  ? SENSORS.filter((s) => sensorArg.split(',').includes(s.id))
  : SENSORS;

const t = await NodeSerialTransport.open(path, adapter);
const ecu = new Ecu(t);
process.on('SIGINT', async () => {
  await t.close();
  process.exit(0);
});

const v = await ecu.version();
console.log(`ECU version byte 0x${hex(v.raw)} (${v.cpu})  ← write this down for E935`);

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
      parts.push(`${s.id} ERR`);
      console.error(`\n${(e as Error).message}`);
    }
  }
  const hz = (sensors.length * 1000) / (performance.now() - start);
  process.stdout.write(`\r${parts.join(' | ')}  [${hz.toFixed(0)} req/s]   `);
}
