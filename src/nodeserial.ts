/** Node transport (package `serialport`) — same semantics as WebSerialTransport. */
import { SerialPort } from 'serialport';
import { BAUD, UNO_BAUD, UNO_RESET_MS, type Transport } from './mmcd.js';

export class NodeSerialTransport implements Transport {
  private buf: number[] = [];
  private waiter: (() => void) | null = null;

  private constructor(private readonly port: SerialPort) {
    port.on('data', (chunk: Buffer) => {
      for (const b of chunk) this.buf.push(b);
      this.waiter?.();
    });
  }

  static async open(path: string, adapter: 'uno' | 'ftdi' = 'uno'): Promise<NodeSerialTransport> {
    const port = new SerialPort({ path, baudRate: adapter === 'uno' ? UNO_BAUD : BAUD, autoOpen: false });
    await new Promise<void>((res, rej) => port.open((e) => (e ? rej(e) : res())));
    const t = new NodeSerialTransport(port);
    if (adapter === 'uno') await new Promise((r) => setTimeout(r, UNO_RESET_MS));
    t.flush();
    return t;
  }

  write(byte: number): Promise<void> {
    return new Promise((res, rej) => this.port.write([byte], (e) => (e ? rej(e) : res())));
  }

  flush() {
    this.buf.length = 0;
  }

  readByte(timeoutMs: number): Promise<number | null> {
    if (this.buf.length) return Promise.resolve(this.buf.shift()!);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      this.waiter = () => {
        if (!this.buf.length) return;
        clearTimeout(timer);
        this.waiter = null;
        resolve(this.buf.shift()!);
      };
    });
  }

  /** Called when the port goes away (unplugged, or closed). */
  onClose(cb: () => void) {
    this.port.once('close', cb);
  }

  close(): Promise<void> {
    if (!this.port.isOpen) return Promise.resolve();
    return new Promise((res) => this.port.close(() => res()));
  }
}
