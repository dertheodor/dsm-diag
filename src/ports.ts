/** Finds the USB serial adapter (Arduino Uno, clone, or FTDI cable). */
import { SerialPort } from 'serialport';

const USB_VENDORS = new Set(['1a86', '2341', '2a03', '0403', '10c4']); // CH340, Arduino, Arduino.org, FTDI, CP210x
const PATH_HINT = /ttyUSB|ttyACM|usbserial|wchusbserial|usbmodem/i;

/** Path of the first likely adapter, or null if none is plugged in. */
export async function findAdapterPort(): Promise<string | null> {
  const ports = await SerialPort.list();
  const hit =
    ports.find((p) => p.vendorId && USB_VENDORS.has(p.vendorId.toLowerCase())) ??
    ports.find((p) => PATH_HINT.test(p.path));
  return hit?.path ?? null;
}
