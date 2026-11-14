/** Parsing and labels for the live verify tool (src/verify.ts). Pure, so the self-test covers it. */
import { E935_ALLOWED, E935_CANDIDATES, E935_STATUS, FLAGS, SENSORS, decodeFaults, hex } from './mmcd.js';

export type VerifyLine =
  | { kind: 'value'; addr: number; raw: number | null; framing: boolean }
  | { kind: 'abort'; addr: number; text: string }
  | { kind: 'refused'; addr: number; text: string }
  | { kind: 'locked' | 'start' | 'stop' | 'ready' | 'other'; text: string };

/** One output line of the sniffer's live mode. */
export function parseVerifyLine(line: string): VerifyLine {
  const text = line.trim();
  let m = /^V ([0-9A-F]{2}) ([0-9A-F]{2}|--|\?\?|BUSY)$/.exec(text);
  if (m) {
    const raw = /^[0-9A-F]{2}$/.test(m[2]) ? parseInt(m[2], 16) : null;
    return { kind: 'value', addr: parseInt(m[1], 16), raw, framing: m[2] === '??' };
  }
  if ((m = /^ABORT ([0-9A-F]{2})/.exec(text))) return { kind: 'abort', addr: parseInt(m[1], 16), text };
  if ((m = /^REFUSED ([0-9A-F]{2})/.exec(text))) return { kind: 'refused', addr: parseInt(m[1], 16), text };
  if (text.startsWith('LOCKED')) return { kind: 'locked', text };
  if (text === 'VERIFY START') return { kind: 'start', text };
  if (text === 'VERIFY STOP') return { kind: 'stop', text };
  if (text.startsWith('READY')) return { kind: 'ready', text };
  return { kind: 'other', text };
}

/** "0x06,3a, 13" → [0x06, 0x3A, 0x13]. Throws on anything that is not a candidate. */
export function parseAddressList(arg: string): number[] {
  const addrs = arg.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    if (!/^(0x)?[0-9a-f]{1,2}$/i.test(s)) throw new Error(`"${s}" is not a hex address`);
    return parseInt(s.replace(/^0x/i, ''), 16);
  });
  if (addrs.length < 1 || addrs.length > 16) throw new Error('Give 1 to 16 addresses.');
  for (const a of addrs) {
    if (!E935_CANDIDATES.has(a))
      throw new Error(`0x${hex(a)} is not a candidate. Candidates: ${[...E935_CANDIDATES].map(hex).join(' ')}`);
  }
  return [...new Set(addrs)];
}

/** US meaning of a candidate address. */
export function meaning(addr: number): string {
  const s = SENSORS.find((x) => x.addr === addr);
  if (s) return s.name;
  if (addr in FLAGS) return 'Switch flags';
  if (addr === 0x38 || addr === 0x39) return 'Active fault codes';
  if (addr === 0x3b || addr === 0x3c) return 'Stored fault codes';
  return 'unknown';
}

/** A reply in US scaling, for comparison with a real measurement. */
export function usValue(addr: number, raw: number): string {
  const s = SENSORS.find((x) => x.addr === addr);
  if (s) {
    const v = s.convert(raw);
    return `${Number.isInteger(v) ? v : v.toFixed(2)} ${s.unit}`;
  }
  const bits = FLAGS[addr as keyof typeof FLAGS] as Record<number, string> | undefined;
  if (bits) {
    const on = Object.entries(bits).filter(([mask]) => raw & Number(mask)).map(([, n]) => n);
    return on.length ? on.join(', ') : 'none set';
  }
  if (addr === 0x38 || addr === 0x3b) return decodeFaults(raw).map((f) => f.code).join(' ') || 'none (low byte)';
  if (addr === 0x39 || addr === 0x3c) return decodeFaults(raw << 8).map((f) => f.code).join(' ') || 'none (high byte)';
  return '';
}

/** Verification state of an address in the E935 profile. */
export function statusOf(addr: number): string {
  if (!E935_ALLOWED.has(addr)) return 'candidate';
  return E935_STATUS.get(addr) ?? 'allowed';
}

/**
 * Stops a verify run when the ECU stops replying, for example when the key is off.
 * A request during the ECU's power-up collides with its power-on pulse on pin 1.
 */
export class NoReplyGuard {
  private misses = 0;
  /** rounds: full passes over the address list without a single reply. */
  constructor(private readonly addresses: number, private readonly rounds = 3) {}

  /** Record one result. Returns true when the run must stop. */
  record(reply: boolean): boolean {
    this.misses = reply ? 0 : this.misses + 1;
    return this.misses >= this.addresses * this.rounds;
  }
}
