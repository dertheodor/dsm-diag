/**
 * Owns the adapter: finds it, opens it, probes the ECU, and runs one serialized
 * request queue. Live polling and user actions share that queue, so they never
 * interleave on the single-wire line.
 */
import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import { Ecu, FLAGS, ProtocolError, SENSORS, decodeFaults, type Fault, type Transport } from '../mmcd.js';
import { NodeSerialTransport } from '../nodeserial.js';
import { SimTransport, simAdapterPresent } from './sim.js';

export type LinkState =
  | { phase: 'searching' }
  | { phase: 'opening'; path: string }
  | { phase: 'no-line'; path: string; detail: string }
  | { phase: 'no-ecu'; path: string }
  | { phase: 'online'; path: string; version: { raw: number; cpu: string } };

export interface Sample {
  t: number;
  values: Record<string, { raw: number; value: number }>;
  reqPerSec: number;
}

export interface Faults { active: Fault[]; stored: Fault[]; activeRaw: number; storedRaw: number; t: number }
export interface Flags { t: number; bytes: Record<string, number>; on: string[] }

type ClosableTransport = Transport & { onClose(cb: () => void): void; close(): Promise<void> };

const USB_VENDORS = new Set(['1a86', '2341', '2a03', '0403', '10c4']); // CH340, Arduino, Arduino.org, FTDI, CP210x
const PATH_HINT = /ttyUSB|ttyACM|usbserial|wchusbserial|usbmodem/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Link extends EventEmitter {
  state: LinkState = { phase: 'searching' };
  pollIds = new Set(['rpm', 'tps', 'timing', 'ect', 'iat', 'batt', 'o2', 'injpw']);
  rawMap = false;

  private t: ClosableTransport | null = null;
  private ecu: Ecu | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private gen = 0; // bumps whenever the transport changes; stale loops exit

  constructor(private readonly opts: { sim: boolean; port?: string }) {
    super();
  }

  start() {
    void this.discoverLoop();
  }

  private setState(s: LinkState) {
    this.state = s;
    this.emit('state', s);
  }

  /* ----------------------------------------------------------- discovery */

  private async findPort(): Promise<string | null> {
    if (this.opts.sim) return simAdapterPresent() ? 'simulated adapter' : null;
    if (this.opts.port) return this.opts.port;
    const ports = await SerialPort.list();
    const hit =
      ports.find((p) => p.vendorId && USB_VENDORS.has(p.vendorId.toLowerCase())) ??
      ports.find((p) => PATH_HINT.test(p.path));
    return hit?.path ?? null;
  }

  private async discoverLoop() {
    for (;;) {
      if (!this.t) {
        try {
          const path = await this.findPort();
          if (path) await this.connect(path);
        } catch (e) {
          this.emit('log', `Could not open adapter: ${(e as Error).message}`);
          this.setState({ phase: 'searching' });
        }
      }
      await sleep(1000);
    }
  }

  private async connect(path: string) {
    this.setState({ phase: 'opening', path });
    const t: ClosableTransport = this.opts.sim ? new SimTransport() : await NodeSerialTransport.open(path, 'uno');
    const gen = ++this.gen;
    this.t = t;
    this.ecu = new Ecu(t);
    t.onClose(() => {
      if (this.gen !== gen) return;
      this.emit('log', 'Adapter unplugged');
      this.t = null;
      this.ecu = null;
      this.gen++;
      this.setState({ phase: 'searching' });
    });
    this.emit('log', `Adapter found at ${path}`);
    void this.sessionLoop(gen, path);
  }

  /* ------------------------------------------------------------ session */

  private alive(gen: number) {
    return this.gen === gen && this.ecu !== null;
  }

  private async sessionLoop(gen: number, path: string) {
    while (this.alive(gen)) {
      // Probe until the ECU answers.
      try {
        const version = await this.exclusive(() => this.ecu!.version());
        this.setState({ phase: 'online', path, version });
        this.emit('log', `ECU answered, version byte 0x${version.raw.toString(16).toUpperCase()}`);
      } catch (e) {
        if (!this.alive(gen)) return;
        this.reportProbeFailure(e, path);
        await sleep(1500);
        continue;
      }
      await this.pollLoop(gen, path);
    }
  }

  private reportProbeFailure(e: unknown, path: string) {
    if (e instanceof ProtocolError && e.kind === 'no-reply') {
      if (this.state.phase !== 'no-ecu') this.setState({ phase: 'no-ecu', path });
    } else {
      const detail = e instanceof Error ? e.message : String(e);
      this.setState({ phase: 'no-line', path, detail });
    }
  }

  private async pollLoop(gen: number, path: string) {
    let misses = 0;
    let lastFaults = 0;
    let lastFlags = 0;
    let rawCursor = 0;
    const rawSnapshot: number[] = new Array(0x40).fill(-1);

    while (this.alive(gen)) {
      const started = performance.now();
      let requests = 0;
      try {
        const values: Sample['values'] = {};
        for (const s of SENSORS) {
          if (!this.pollIds.has(s.id)) continue;
          const raw = await this.exclusive(() => this.ecu!.request(s.addr));
          requests++;
          values[s.id] = { raw, value: s.convert(raw) };
        }
        const now = Date.now();

        if (now - lastFlags > 500) {
          const bytes: Flags['bytes'] = {};
          const on: string[] = [];
          for (const [addr, bits] of Object.entries(FLAGS)) {
            const b = await this.exclusive(() => this.ecu!.request(Number(addr)));
            requests++;
            bytes[`0x${Number(addr).toString(16).padStart(2, '0').toUpperCase()}`] = b;
            for (const [mask, name] of Object.entries(bits)) if (b & Number(mask)) on.push(name);
          }
          this.emit('flags', { t: now, bytes, on } satisfies Flags);
          lastFlags = now;
        }

        if (now - lastFaults > 5000) {
          this.emit('faults', await this.readFaults());
          requests += 4;
          lastFaults = now;
        }

        if (this.rawMap) {
          // 8 addresses per cycle so live data stays fluid.
          for (let i = 0; i < 8; i++) {
            rawSnapshot[rawCursor] = await this.exclusive(() => this.ecu!.request(rawCursor));
            requests++;
            rawCursor = (rawCursor + 1) % 0x40;
          }
          this.emit('rawmap', { t: now, bytes: rawSnapshot.slice() });
        }

        const secs = (performance.now() - started) / 1000;
        this.emit('sample', { t: now, values, reqPerSec: secs > 0 ? requests / secs : 0 } satisfies Sample);
        misses = 0;
        if (requests === 0) await sleep(100);
      } catch (e) {
        if (!this.alive(gen)) return;
        if (++misses >= 3) {
          this.emit('log', `Lost the ECU: ${(e as Error).message}`);
          this.reportProbeFailure(e, path);
          return; // back to probing
        }
      }
    }
  }

  /* ------------------------------------------------------------ actions */

  /** Run fn with the line to itself. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => {});
    return run;
  }

  private requireOnline() {
    if (this.state.phase !== 'online' || !this.ecu) throw new Error('The ECU is not connected.');
    return this.ecu;
  }

  async readFaults(): Promise<Faults> {
    const ecu = this.requireOnline();
    const r = (a: number) => this.exclusive(() => ecu.request(a));
    const activeRaw = (await r(0x38)) | ((await r(0x39)) << 8);
    const storedRaw = (await r(0x3b)) | ((await r(0x3c)) << 8);
    return { active: decodeFaults(activeRaw), stored: decodeFaults(storedRaw), activeRaw, storedRaw, t: Date.now() };
  }

  async clearFaults(): Promise<{ cleared: boolean; faults: Faults }> {
    const ecu = this.requireOnline();
    const cleared = (await this.exclusive(() => ecu.request(0xca))) === 0;
    const faults = await this.readFaults();
    this.emit('faults', faults);
    this.emit('log', cleared ? 'Fault codes cleared' : 'ECU refused to clear codes (engine running?)');
    return { cleared, faults };
  }

  async readAddress(addr: number): Promise<number> {
    if (!Number.isInteger(addr) || addr < 0 || addr > 0xff) throw new Error('Address must be 0x00–0xFF.');
    if (addr === 0xca) throw new Error('0xCA clears fault codes. Use "Clear codes" instead.');
    if (addr >= 0xf1 && addr <= 0xfc) throw new Error('0xF1–0xFC run actuator tests and are blocked here.');
    if (addr === 0xfe || addr === 0xff) throw new Error('0xFE/0xFF change ECU strapping and are blocked here.');
    const ecu = this.requireOnline();
    return this.exclusive(() => ecu.request(addr));
  }

  async dumpRam(): Promise<Record<string, number>> {
    const ecu = this.requireOnline();
    const out: Record<string, number> = {};
    for (let a = 0x40; a <= 0xf0; a++) {
      if (a === 0xca) continue;
      out[a.toString(16).toUpperCase()] = await this.exclusive(() => ecu.request(a));
      if (a % 16 === 0) this.emit('progress', { task: 'ram', done: a - 0x40, total: 0xf0 - 0x40 });
    }
    this.emit('progress', { task: 'ram', done: 1, total: 1 });
    this.emit('log', 'RAM window 0x40–0xF0 read');
    return out;
  }
}
