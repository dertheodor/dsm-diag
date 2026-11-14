/**
 * Live verify tool for the E935: shows candidate addresses in a table while you
 * change something on the car (rev, warm up, flip a switch).
 *
 *   npm run verify -- 06,3A,13 [--port /dev/ttyUSB0] [--log verify.csv]
 *
 * Needs firmware/sniffer on the Uno (npm run fw -- sniffer) and the inverted wiring.
 * The tool sends nothing until the sniffer has announced itself, and the sniffer
 * refuses every address that is not a candidate. Ctrl+C stops it.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { SerialPort } from 'serialport';
import { hex } from './mmcd.js';
import { findAdapterPort } from './ports.js';
import { NoReplyGuard, meaning, parseAddressList, parseVerifyLine, statusOf, usValue } from './verify-format.js';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const list = args.find((a, i) => !a.startsWith('--') && !['--port', '--log'].includes(args[i - 1]));
if (!list) {
  console.error('usage: npm run verify -- 06,3A,13 [--port /dev/ttyUSB0] [--log verify.csv]');
  process.exit(1);
}

let addrs: number[];
try {
  addrs = parseAddressList(list);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const path = opt('--port') ?? (await findAdapterPort());
if (!path) {
  console.error('No adapter found. Plug in the Arduino, or pass --port.');
  process.exit(1);
}
const logFile = opt('--log');
if (logFile) writeFileSync(logFile, 'time,addr,raw\n');

interface Stat { raw: number | null; min: number; max: number; replies: number; missing: number; framing: number }
const stats = new Map<number, Stat>(addrs.map((a) => [a, { raw: null, min: 255, max: 0, replies: 0, missing: 0, framing: 0 }]));
const port = new SerialPort({ path, baudRate: 115200 });
let buf = '';
let started = false;
let stopping = false;
let lastRender = 0;
/** Set when the tool stops the sniffer itself; reported once the sniffer confirms. */
let stopReason: string | undefined;
const guard = new NoReplyGuard(addrs.length);

function render(force = false) {
  const now = Date.now();
  if (!force && now - lastRender < 200) return;
  lastRender = now;
  const rows = addrs.map((a) => {
    const s = stats.get(a)!;
    const raw = s.raw === null ? '--' : `0x${hex(s.raw)}`;
    const value = s.raw === null ? '' : usValue(a, s.raw);
    const range = s.replies ? `0x${hex(s.min)}–0x${hex(s.max)}` : '';
    return `0x${hex(a)}  ${meaning(a).padEnd(22)} ${raw.padEnd(5)} ${value.padEnd(24)} ${range.padEnd(12)} ${String(s.replies).padStart(5)} ${String(s.missing + s.framing).padStart(5)}  ${statusOf(a)}`;
  });
  process.stdout.write('\x1b[2J\x1b[H');
  console.log(`E935 live verify on ${path}. Ctrl+C stops.\n`);
  console.log('Addr  US meaning             Raw   US scaling               Range        Reply  Miss  Status');
  for (const r of rows) console.log(r);
  console.log('\nCompare each value with a real measurement before you add it to the allowlist (docs/e935.md).');
}

function fail(text: string): never {
  console.error(`\n${text}`);
  port.close(() => process.exit(1));
  return undefined as never;
}

/** Stop the sniffer's request loop, then exit with text. */
function stopWith(text: string) {
  if (stopping) return;
  stopping = true;
  stopReason = text;
  port.write('s');
  setTimeout(() => fail(text), 1500);
}

function onLine(line: string) {
  const l = parseVerifyLine(line);
  switch (l.kind) {
    case 'ready':
      if (!started) {
        started = true;
        port.write(Buffer.from([0x76, addrs.length, ...addrs])); // 'v', count, addresses
      }
      return;
    case 'value': {
      const s = stats.get(l.addr);
      if (!s) return;
      if (guard.record(l.raw !== null)) stopWith('No reply from the ECU. Turn the key ON first, then start verify again.');
      if (l.raw === null) {
        if (l.framing) s.framing++; else s.missing++;
      } else {
        s.raw = l.raw;
        s.replies++;
        s.min = Math.min(s.min, l.raw);
        s.max = Math.max(s.max, l.raw);
        if (logFile) appendFileSync(logFile, `${new Date().toISOString()},0x${hex(l.addr)},${l.raw}\n`);
      }
      render();
      return;
    }
    case 'abort':
      return fail(`STOPPED FOR SAFETY: ${l.text}\nSwitch the ignition off, then unplug and replug the Arduino.`);
    case 'refused':
      return fail(`The sniffer refused the list: ${l.text}`);
    case 'locked':
      return fail('The sniffer is locked after a misread. Unplug and replug the Arduino.');
    case 'stop':
      if (stopReason) return fail(stopReason);
      render(true);
      port.close(() => process.exit(0));
      return;
    default:
      return;
  }
}

port.on('data', (chunk: Buffer) => {
  buf += chunk.toString('latin1');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    onLine(buf.slice(0, i));
    buf = buf.slice(i + 1);
  }
});
port.on('error', (e) => fail(`Serial port error: ${e.message}`));

// Opening the port resets the Uno; the sniffer announces itself within about 2 s.
setTimeout(() => {
  if (!started)
    fail('No answer from the sniffer. Upload it first: npm run fw -- sniffer. Nothing was sent to the car.');
}, 4000);

process.on('SIGINT', () => {
  if (stopping || !started) process.exit(0);
  stopping = true;
  port.write('s');
  setTimeout(() => port.close(() => process.exit(0)), 1500);
});
