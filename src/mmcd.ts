/**
 * 1G DSM (1990–94 Eclipse/Talon/Laser) ECU diagnostic protocol ("MMCd"/ALDL).
 *
 * Link layer: UART 1953.125 baud, 8N1, single-wire half-duplex on pin 1 of the
 * 12-pin diagnostic connector (pin 10 bridged to pin 12 = diag mode, pin 12 = GND).
 * Request = 1 byte, reply = 1 byte. Because TX and RX share one wire, every request
 * byte comes back as an echo first, then the ECU's data byte.
 *
 * Address map (from the E931/E932 disassembly, community-verified on US ECUs —
 * a Swiss/Euro calibration may differ, so verify every value against reality):
 *   0x00–0x3D  "OBD" table: processed sensor values
 *   0x40–0xF0  raw RAM byte at that address (0xCA excluded)
 *   0xCA       clear fault codes
 *   0xF1–0xFC  actuator tests (engine OFF only, ~6 s)
 *   0xFD       ECU/CPU version (0xB5 = E931, 0xB7 = E932)
 *
 * The European E935 speaks the same protocol on an inverted line (docs/e935.md).
 * The bridge firmware handles the polarity, so this module does not change.
 */

export interface Transport {
  write(byte: number): Promise<void>;
  /** Resolve with next received byte, or null after timeoutMs. */
  readByte(timeoutMs: number): Promise<number | null>;
  /** Drop anything already buffered. */
  flush(): void;
}

export const BAUD = 1953; // ECU line rate. FTDI: 3 MHz / 1536 = 1953.125 exactly
export const UNO_BAUD = 115200; // PC <-> Uno bridge link
export const UNO_RESET_MS = 2000; // Uno auto-resets when the port opens

export type ProtocolErrorKind = 'no-echo' | 'echo-mismatch' | 'no-reply';

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly kind: ProtocolErrorKind,
    /** Set for 'echo-mismatch'. */
    readonly echo?: { sent: number; got: number },
  ) {
    super(message);
  }
}

/**
 * True if the bridge aborted a request because the ECU drove the line during it.
 * WIRING_INVERTED in firmware/dsm_bridge answers that case with an inverted echo.
 */
export const isBridgeAbort = (e: unknown): e is ProtocolError =>
  e instanceof ProtocolError && e.echo !== undefined && e.echo.got === (e.echo.sent ^ 0xff);

/**
 * The only addresses the E935 profile sends: reads verified on the E935 (docs/e935.md).
 * The hard gate is allowed() in firmware/dsm_bridge/dsm_bridge.ino (WIRING_INVERTED);
 * this copy keeps the software from asking for anything else.
 */
export const E935_ALLOWED: ReadonlySet<number> = new Set([0x02, 0x07, 0x0f, 0x13, 0x14, 0x17, 0x21, 0x38, 0x39, 0x3b, 0x3c]);

/** Switch bits verified on the E935. The other US bits of 0x02 do not apply to this car (docs/e935.md). */
export const E935_FLAGS: Readonly<Record<number, Readonly<Record<number, string>>>> = {
  0x02: { 0x08: 'Power steering', 0x80: 'Idle switch' },
};

/** Allowed addresses whose US scaling is wrong on the E935. The profile shows their raw byte. */
export const E935_RAW: ReadonlySet<number> = new Set([0x07]);

/** Addresses that change ECU state on US ECUs: clear codes, actuator tests, strapping. */
export const isBlocked = (addr: number) => addr === 0xca || (addr >= 0xf1 && addr <= 0xfc) || addr >= 0xfe;

/** Smallest number of bit errors that turns addr into a blocked address. */
export function bitErrorsToBlocked(addr: number): number {
  let min = 8;
  for (let b = 0; b <= 0xff; b++) {
    if (!isBlocked(b)) continue;
    let x = addr ^ b, n = 0;
    for (; x; x &= x - 1) n++;
    min = Math.min(min, n);
  }
  return min;
}

/** The safety rule for every E935 request: at least this many bit errors from a blocked address. */
export const MIN_BIT_ERRORS = 2;

export interface EcuOptions {
  echo: boolean;
  timeoutMs: number;
  /** Extra attempts after 'no-reply'. Echo errors are never retried. */
  retries?: number;
  /** If set, request() refuses every other address before anything is sent. */
  allow?: ReadonlySet<number>;
}

export class Ecu {
  constructor(
    private readonly t: Transport,
    private readonly opts: EcuOptions = { echo: true, timeoutMs: 150 },
  ) {}

  /** Send one request byte and return the ECU's one-byte reply. */
  async request(addr: number): Promise<number> {
    if (addr < 0 || addr > 0xff) throw new RangeError(`bad address ${addr}`);
    if (this.opts.allow && !this.opts.allow.has(addr))
      throw new RangeError(`address 0x${hex(addr)} is not allowed for this ECU`);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(addr);
      } catch (e) {
        const retry = e instanceof ProtocolError && e.kind === 'no-reply' && attempt < (this.opts.retries ?? 0);
        if (!retry) throw e;
      }
    }
  }

  private async requestOnce(addr: number): Promise<number> {
    this.t.flush();
    await this.t.write(addr);
    if (this.opts.echo) {
      const echo = await this.t.readByte(this.opts.timeoutMs);
      if (echo === null) throw new ProtocolError(`no echo for 0x${hex(addr)} — check wiring`, 'no-echo');
      if (echo !== addr)
        throw new ProtocolError(
          `echo mismatch: sent 0x${hex(addr)} got 0x${hex(echo)} (baud/polarity?)`,
          'echo-mismatch',
          { sent: addr, got: echo },
        );
    }
    const data = await this.t.readByte(this.opts.timeoutMs);
    if (data === null)
      throw new ProtocolError(`no reply for 0x${hex(addr)} — diag mode (pin 10→12)? ignition on?`, 'no-reply');
    return data;
  }

  /** CPU version byte. */
  async version(): Promise<{ raw: number; cpu: string }> {
    const raw = await this.request(0xfd);
    const cpu = raw === 0xb5 ? 'E931' : raw === 0xb7 ? 'E932' : 'unknown';
    return { raw, cpu };
  }

  async readSensor(s: Sensor): Promise<number> {
    return s.convert(await this.request(s.addr));
  }

  async readFaults(): Promise<{ active: Fault[]; stored: Fault[] }> {
    const word = async (lo: number, hi: number) =>
      (await this.request(lo)) | ((await this.request(hi)) << 8);
    return {
      active: decodeFaults(await word(0x38, 0x39)),
      stored: decodeFaults(await word(0x3b, 0x3c)),
    };
  }

  /** Clears stored codes. Returns false if the ECU refused (engine running). */
  async clearFaults(): Promise<boolean> {
    return (await this.request(0xca)) === 0x00;
  }

  /**
   * Dump the readable RAM window 0x40–0xF0 (skipping command bytes).
   * NOTE: this is RAM, not the EPROM. The calibration/ROM ID lives in the EPROM,
   * which you read by pulling the chip and using an EPROM programmer.
   */
  async dumpRam(onProgress?: (addr: number) => void): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    for (let a = 0x40; a <= 0xf0; a++) {
      if (a === 0xca) continue;
      onProgress?.(a);
      out.set(a, await this.request(a));
    }
    return out;
  }
}

/* ---------------------------------------------------------------- sensors */

export interface Sensor {
  id: string;
  name: string;
  addr: number;
  unit: string;
  convert(x: number): number;
}

const s = (id: string, name: string, addr: number, unit: string, convert: (x: number) => number): Sensor =>
  ({ id, name, addr, unit, convert });

const fToC = (f: number) => (f - 32) / 1.8;

export const SENSORS: readonly Sensor[] = [
  s('rpm', 'Engine speed', 0x21, 'rpm', (x) => x * 31.25),
  s('tps', 'Throttle position', 0x17, '%', (x) => (x * 100) / 255),
  s('timing', 'Timing advance', 0x06, '°BTDC', (x) => x - 10),
  s('ect', 'Coolant temp', 0x07, '°C', (x) => fToC(-1.45 * x + 308)), // approx curve
  s('iat', 'Intake air temp', 0x3a, '°C', (x) => fToC(-1.69 * x + 358)), // approx curve
  s('o2', 'O2 sensor', 0x13, 'V', (x) => x * 0.0195),
  s('batt', 'Battery', 0x14, 'V', (x) => x * 0.0733),
  s('baro', 'Barometer', 0x15, 'bar', (x) => x * 0.00486),
  s('maf', 'MAF frequency', 0x1a, 'Hz', (x) => x * 6.29),
  s('injpw', 'Injector pulse width', 0x29, 'ms', (x) => x * 0.256),
  s('iscsteps', 'ISC steps', 0x16, 'steps', (x) => x),
  s('knock', 'Knock sum', 0x26, 'count', (x) => x),
  s('o2fb', 'O2 feedback trim', 0x0f, '%', (x) => x * 0.78),
  s('ftLo', 'Fuel trim low', 0x0c, '%', (x) => x * 0.78),
  s('ftMid', 'Fuel trim mid', 0x0d, '%', (x) => x * 0.78),
  s('ftHi', 'Fuel trim high', 0x0e, '%', (x) => x * 0.78),
  s('accenr', 'Accel enrichment', 0x1d, '%', (x) => (x * 100) / 255),
];

/**
 * The sensors of the E935 profile: allowed addresses only, and the raw byte where
 * the US scaling is wrong (E935_RAW).
 */
export const E935_SENSORS: readonly Sensor[] = SENSORS.filter((s) => E935_ALLOWED.has(s.addr)).map((s) =>
  E935_RAW.has(s.addr) ? { ...s, unit: 'raw', convert: (x: number) => x } : s);

/** Switch flags are bits of a single byte. */
export const FLAGS = {
  0x02: { 0x04: 'TDC', 0x08: 'Power steering', 0x10: 'A/C switch', 0x20: 'Park/Neutral', 0x80: 'Idle switch' },
  0x00: { 0x20: 'A/C clutch' },
} as const;

/* ------------------------------------------------------------------ faults */

export interface Fault { code: number; name: string }

/** Bit n (0-based) of the 16-bit fault word → Mitsubishi 2-digit flash code. */
const FAULT_BITS: readonly Fault[] = [
  { code: 11, name: 'Oxygen sensor' },
  { code: 12, name: 'Air flow sensor' },
  { code: 13, name: 'Intake air temp sensor' },
  { code: 14, name: 'Throttle position sensor' },
  { code: 15, name: 'ISC motor position sensor' },
  { code: 21, name: 'Coolant temp sensor' },
  { code: 22, name: 'Crank angle (rpm) sensor' },
  { code: 23, name: 'TDC sensor' },
  { code: 24, name: 'Vehicle speed sensor' },
  { code: 25, name: 'Barometric pressure sensor' },
  { code: 31, name: 'Knock sensor' },
  { code: 41, name: 'Injector circuit' },
  { code: 42, name: 'Fuel pump relay' },
  { code: 43, name: 'EGR' },
  { code: 44, name: 'Ignition coil' },
  { code: 36, name: 'Ignition circuit' },
];

export function decodeFaults(word: number): Fault[] {
  return FAULT_BITS.filter((_, bit) => word & (1 << bit));
}

export const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();

/* ------------------------------------------------------------- E935 */

/**
 * Addresses that may be verified on the E935 with firmware/sniffer: every US sensor,
 * flag and fault address that meets MIN_BIT_ERRORS. CANDIDATES in the sniffer
 * firmware must list the same addresses; the self-test checks this.
 */
export const E935_CANDIDATES: ReadonlySet<number> = new Set(
  [...SENSORS.map((s) => s.addr), ...Object.keys(FLAGS).map(Number), 0x38, 0x39, 0x3b, 0x3c]
    .filter((a) => bitErrorsToBlocked(a) >= MIN_BIT_ERRORS)
    .sort((a, b) => a - b),
);

export type VerifyStatus = 'confirmed' | 'plausible';

/**
 * How far each allowed E935 address is verified. docs/e935.md holds the evidence.
 *   confirmed  matches an independent measurement
 *   plausible  live and sensible, but the scaling is not checked yet
 */
export const E935_STATUS: ReadonlyMap<number, VerifyStatus> = new Map([
  [0x02, 'confirmed'],
  [0x0f, 'confirmed'],
  [0x13, 'confirmed'],
  [0x14, 'confirmed'],
  [0x17, 'confirmed'],
  [0x21, 'confirmed'],
  [0x07, 'plausible'],
  [0x38, 'plausible'],
  [0x39, 'plausible'],
  [0x3b, 'plausible'],
  [0x3c, 'plausible'],
]);
