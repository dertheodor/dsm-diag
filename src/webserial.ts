/**
 * Web Serial transport (Chrome/Edge desktop). Works with the Arduino Uno bridge
 * (firmware/dsm_bridge) or an FTDI cable wired directly to the ECU line.
 *
 *   const port = await navigator.serial.requestPort();   // inside a click handler
 *   const t = await WebSerialTransport.open(port, 'uno');
 *   const ecu = new Ecu(t);
 */
import { BAUD, UNO_BAUD, UNO_RESET_MS, type Transport } from './mmcd.js';

// Minimal typings so we don't need @types/w3c-web-serial.
interface SerialPortLike {
  open(o: { baudRate: number; dataBits?: number; stopBits?: number; parity?: 'none'; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

export class WebSerialTransport implements Transport {
  private buf: number[] = [];
  private waiter: (() => void) | null = null;
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;

  private constructor(private readonly port: SerialPortLike) {}

  /**
   * adapter 'uno':  Arduino bridge sketch (115200 to the Uno, which does 1953 baud itself).
   * adapter 'ftdi': FTDI cable wired straight to the ECU line at 1953 baud.
   */
  static async open(port: SerialPortLike, adapter: 'uno' | 'ftdi' = 'uno'): Promise<WebSerialTransport> {
    const baudRate = adapter === 'uno' ? UNO_BAUD : BAUD;
    await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none' });
    const t = new WebSerialTransport(port);
    t.reader = port.readable!.getReader();
    t.writer = port.writable!.getWriter();
    void t.pump();
    // Opening the port resets the Uno (DTR); give the bootloader time to hand over.
    if (adapter === 'uno') await new Promise((r) => setTimeout(r, UNO_RESET_MS));
    t.flush();
    return t;
  }

  private async pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) for (const b of value) this.buf.push(b);
        this.waiter?.();
      }
    } catch {
      /* port closed */
    }
  }

  async write(byte: number) {
    await this.writer.write(Uint8Array.of(byte));
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

  async close() {
    await this.reader.cancel().catch(() => {});
    this.writer.releaseLock();
    await this.port.close();
  }
}
