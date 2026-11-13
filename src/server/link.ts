/**
 * Owns the adapter: finds it, opens it, probes the ECU, and runs one serialized
 * request queue. Live polling and user actions share that queue, so they never
 * interleave on the single-wire line.
 */
import { EventEmitter } from 'node:events';
import { E935_ALLOWED, Ecu, FLAGS, ProtocolError, SENSORS, decodeFaults, isBridgeAbort, type Fault, type Sensor, type Transport } from '../mmcd.js';
import { NodeSerialTransport } from '../nodeserial.js';
import { findAdapterPort } from '../ports.js';
import { SimTransport, simAdapterPresent } from './sim.js';

export type LinkState =
  | { phase: 'searching' }
  | { phase: 'opening'; path: string }
  | { phase: 'no-line'; path: string; detail: string }
  | { phase: 'no-ecu'; path: string }
  /** version is null in the E935 profile: it never sends the 0xFD version request. */
  | { phase: 'online'; path: string; version: { raw: number; cpu: string } | null }
  /** The ECU misread a request. Nothing is sent until the adapter is plugged in again. */
  | { phase: 'halted'; path: string; detail: string };

export interface Sample {
  t: number;
  values: Record<string, { raw: number; value: number }>;
  reqPerSec: number;
}

export interface Faults { active: Fault[]; stored: Fault[]; activeRaw: number; storedRaw: number; t: number }
export interface Flags { t: number; bytes: Record<string, number>; on: string[] }

type ClosableTransport = Transport & { onClose(cb: () => void): void; close(): Promise<void> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Link extends EventEmitter {
  state: LinkState = { phase: 'searching' };
  /** Sensors this profile may poll. */
  readonly sensors: readonly Sensor[];
  /** Switch flag bytes this profile may poll. */
  readonly flags: Partial<typeof FLAGS>;
  pollIds: Set<string>;

  private t: ClosableTransport | null = null;
  private ecu: Ecu | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private gen = 0; // bumps whenever the transport changes; stale loops exit
  private rawMapOn = false;

  /**
   * e935: the inverted-line profile. Only E935_ALLOWED addresses are sent, and
   * Explore, Clear codes and the version request are off.
   */
  constructor(private readonly opts: { sim: boolean; port?: string; e935: boolean }) {
    super();
    this.sensors = opts.e935 ? SENSORS.filter((s) => E935_ALLOWED.has(s.addr)) : SENSORS;
    this.flags = opts.e935 ? {} : FLAGS;
    const defaults = ['rpm', 'tps', 'timing', 'ect', 'iat', 'batt', 'o2', 'injpw'];
    this.pollIds = new Set(defaults.filter((id) => this.sensors.some((s) => s.id === id)));
  }

  get e935() {
    return this.opts.e935;
  }

  get rawMap() {
    return this.rawMapOn;
  }

  set rawMap(on: boolean) {
    if (on && this.opts.e935) throw new Error('Explore is off in the E935 profile.');
    this.rawMapOn = on;
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
    return findAdapterPort();
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
    this.ecu = new Ecu(t, this.opts.e935
      ? { echo: true, timeoutMs: 150, retries: 1, allow: E935_ALLOWED }
      : { echo: true, timeoutMs: 150 });
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

  /** The E935 profile probes with the battery voltage: 0xFD is not on its allowlist. */
  private async probe(): Promise<{ raw: number; cpu: string } | null> {
    if (!this.opts.e935) return this.ecu!.version();
    await this.ecu!.request(0x14);
    return null;
  }

  private async sessionLoop(gen: number, path: string) {
    while (this.alive(gen)) {
      // Probe until the ECU answers.
      try {
        const version = await this.exclusive(() => this.probe());
        this.setState({ phase: 'online', path, version });
        this.emit('log', version ? `ECU answered, version byte 0x${version.raw.toString(16).toUpperCase()}` : 'ECU answered (E935 profile)');
      } catch (e) {
        if (!this.alive(gen)) return;
        this.reportFailure(e, path);
        if (!this.alive(gen)) return;
        await sleep(1500);
        continue;
      }
      await this.pollLoop(gen, path);
    }
  }

  /**
   * In the E935 profile, an inverted echo means the bridge aborted a misread
   * request and locked itself. Stop everything until the adapter is replugged.
   */
  private reportFailure(e: unknown, path: string) {
    if (this.opts.e935 && isBridgeAbort(e)) {
      this.ecu = null;
      this.emit('log', `Stopped for safety: ${e.message}`);
      this.setState({ phase: 'halted', path, detail: e.message });
    } else if (e instanceof ProtocolError && e.kind === 'no-reply') {
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
        for (const s of this.sensors) {
          if (!this.pollIds.has(s.id)) continue;
          const raw = await this.exclusive(() => this.ecu!.request(s.addr));
          requests++;
          values[s.id] = { raw, value: s.convert(raw) };
        }
        const now = Date.now();

        if (now - lastFlags > 500 && Object.keys(this.flags).length) {
          const bytes: Flags['bytes'] = {};
          const on: string[] = [];
          for (const [addr, bits] of Object.entries(this.flags)) {
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

        if (this.rawMapOn) {
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
        if (this.opts.e935 && isBridgeAbort(e)) {
          this.reportFailure(e, path);
          return;
        }
        if (++misses >= 3) {
          this.emit('log', `Lost the ECU: ${(e as Error).message}`);
          this.reportFailure(e, path);
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

  private requireExplore() {
    if (this.opts.e935) throw new Error('This is off in the E935 profile. Only verified addresses are read.');
  }

  async readFaults(): Promise<Faults> {
    const ecu = this.requireOnline();
    const r = (a: number) => this.exclusive(() => ecu.request(a));
    const activeRaw = (await r(0x38)) | ((await r(0x39)) << 8);
    const storedRaw = (await r(0x3b)) | ((await r(0x3c)) << 8);
    return { active: decodeFaults(activeRaw), stored: decodeFaults(storedRaw), activeRaw, storedRaw, t: Date.now() };
  }

  async clearFaults(): Promise<{ cleared: boolean; faults: Faults }> {
    this.requireExplore();
    const ecu = this.requireOnline();
    const cleared = (await this.exclusive(() => ecu.request(0xca))) === 0;
    const faults = await this.readFaults();
    this.emit('faults', faults);
    this.emit('log', cleared ? 'Fault codes cleared' : 'ECU refused to clear codes (engine running?)');
    return { cleared, faults };
  }

  async readAddress(addr: number): Promise<number> {
    this.requireExplore();
    if (!Number.isInteger(addr) || addr < 0 || addr > 0xff) throw new Error('Address must be 0x00–0xFF.');
    if (addr === 0xca) throw new Error('0xCA clears fault codes. Use "Clear codes" instead.');
    if (addr >= 0xf1 && addr <= 0xfc) throw new Error('0xF1–0xFC run actuator tests and are blocked here.');
    if (addr === 0xfe || addr === 0xff) throw new Error('0xFE/0xFF change ECU strapping and are blocked here.');
    const ecu = this.requireOnline();
    return this.exclusive(() => ecu.request(addr));
  }

  async dumpRam(): Promise<Record<string, number>> {
    this.requireExplore();
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
