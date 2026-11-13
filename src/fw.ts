/**
 * Compile and upload a firmware to the Uno in one step.
 *
 *   npm run fw -- sniffer
 *   npm run fw -- bridge --wiring inverted     (or 5v, 12v)
 *   options: --port /dev/ttyUSB0, --baud 57600 (clones with the old bootloader)
 *
 * Uses arduino-cli if installed, otherwise the Arduino IDE 1.8 tools
 * (arduino-builder and avrdude; set ARDUINO_DIR if the IDE is not in /usr/share/arduino).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findAdapterPort } from './ports.js';

const FQBN = 'arduino:avr:uno';
const SKETCHES = { sniffer: 'firmware/sniffer/sniffer.ino', bridge: 'firmware/dsm_bridge/dsm_bridge.ino' } as const;
const WIRINGS = { '5v': 'WIRING_5V', '12v': 'WIRING_12V', inverted: 'WIRING_INVERTED' } as const;

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const name = args[0] as keyof typeof SKETCHES;

function die(text: string): never {
  console.error(text);
  process.exit(1);
}

if (!(name in SKETCHES)) die('usage: npm run fw -- sniffer | bridge --wiring 5v|12v|inverted [--port P] [--baud 57600]');
const wiring = opt('--wiring') as keyof typeof WIRINGS | undefined;
if (name === 'bridge' && !(wiring && wiring in WIRINGS))
  die('The bridge needs --wiring 5v, 12v or inverted. Pick it with step 1 of docs/wiring.md; the E935 needs inverted.');
const define = name === 'bridge' ? WIRINGS[wiring!] : undefined;
const sketch = resolve(SKETCHES[name]);
const port = opt('--port') ?? (await findAdapterPort()) ?? die('No adapter found. Plug in the Arduino, or pass --port.');
const baud = opt('--baud') ?? '115200';
const out = mkdtempSync(join(tmpdir(), `dsm-fw-${name}-`));

function run(cmd: string, cmdArgs: string[]) {
  console.log(`$ ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit' });
  if (r.error) die(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} failed (exit ${r.status}). Is the dashboard or a verify session still holding ${port}?`);
}

const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const flags = define ? `-D${define}` : '';

if (has('arduino-cli')) {
  const props = flags ? ['--build-property', `build.extra_flags=${flags}`] : [];
  run('arduino-cli', ['compile', '--fqbn', FQBN, ...props, '--output-dir', out, sketch.replace(/\/[^/]+$/, '')]);
  run('arduino-cli', ['upload', '-p', port, '--fqbn', FQBN, '--input-dir', out]);
} else {
  const ide = process.env.ARDUINO_DIR ?? '/usr/share/arduino';
  if (!existsSync(join(ide, 'hardware'))) die(`Neither arduino-cli nor the Arduino IDE in ${ide} found. Install arduino-cli.`);
  const prefs = flags ? [`-prefs=build.extra_flags=${flags}`] : [];
  run('arduino-builder', ['-compile', '-hardware', join(ide, 'hardware'), '-tools', join(ide, 'hardware/tools'),
    '-fqbn', FQBN, ...prefs, '-build-path', out, sketch]);
  const hexFile = join(out, `${sketch.split('/').pop()}.hex`);
  run('avrdude', ['-q', '-p', 'm328p', '-c', 'arduino', '-P', port, '-b', baud, '-D', '-U', `flash:w:${hexFile}:i`]);
}
console.log(`\nUploaded ${name}${define ? ` (${define})` : ''} to ${port}.`);
