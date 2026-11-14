/**
 * Local dashboard server.
 *
 *   npm run dashboard            # real adapter, auto-detected
 *   npm run dashboard -- --sim   # simulated car, no hardware
 *   npm run dashboard -- --port /dev/ttyUSB0
 *   npm run dashboard:e935       # E935 profile: inverted line, verified addresses only
 *
 * Then open http://localhost:1991
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { E935_STATUS } from '../mmcd.js';
import { Link } from './link.js';

const args = process.argv.slice(2);
const sim = args.includes('--sim');
const e935 = args.includes('--e935');
const portArg = args.includes('--port') ? args[args.indexOf('--port') + 1] : undefined;
const HTTP_PORT = Number(process.env.PORT ?? 1991);
const webDir = join(dirname(fileURLToPath(import.meta.url)), '../../web');

const link = new Link({ sim, port: portArg, e935 });

/* ---------------------------------------------------------------- assets */

async function bundle(): Promise<string> {
  const out = await build({
    entryPoints: [join(webDir, 'app.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    minify: false,
  });
  return out.outputFiles[0].text;
}

const assets: Record<string, { type: string; body: () => Promise<string | Buffer> }> = {
  '/': { type: 'text/html; charset=utf-8', body: () => readFile(join(webDir, 'index.html')) },
  '/style.css': { type: 'text/css; charset=utf-8', body: () => readFile(join(webDir, 'style.css')) },
  '/app.js': { type: 'text/javascript; charset=utf-8', body: bundle },
};

/* ------------------------------------------------------------------- SSE */

const clients = new Set<ServerResponse>();
const lastEvent = new Map<string, unknown>();

function broadcast(event: string, data: unknown) {
  lastEvent.set(event, data);
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

for (const ev of ['state', 'sample', 'flags', 'faults', 'rawmap', 'log', 'progress']) {
  link.on(ev, (d) => broadcast(ev, ev === 'log' ? { t: Date.now(), text: d } : d));
}

function openEvents(res: ServerResponse) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const meta = {
    sim,
    e935,
    sensors: link.sensors.map(({ id, name, addr, unit }) => ({ id, name, addr, unit, status: e935 ? E935_STATUS.get(addr) : undefined })),
    flags: link.flags,
    poll: [...link.pollIds],
    rawMap: link.rawMap,
  };
  res.write(`event: meta\ndata: ${JSON.stringify(meta)}\n\n`);
  res.write(`event: state\ndata: ${JSON.stringify(link.state)}\n\n`);
  for (const ev of ['faults', 'flags', 'rawmap'])
    if (lastEvent.has(ev)) res.write(`event: ${ev}\ndata: ${JSON.stringify(lastEvent.get(ev))}\n\n`);
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

/* ------------------------------------------------------------------- API */

async function readJson(req: IncomingMessage): Promise<any> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

const api: Record<string, (body: any) => Promise<unknown>> = {
  '/api/poll': async (b: { sensors?: string[]; rawMap?: boolean }) => {
    if (Array.isArray(b.sensors)) link.pollIds = new Set(b.sensors.filter((id) => link.sensors.some((s) => s.id === id)));
    if (typeof b.rawMap === 'boolean') link.rawMap = b.rawMap;
    return { poll: [...link.pollIds], rawMap: link.rawMap };
  },
  '/api/connect': async () => link.connectEcu(),
  '/api/faults': async () => link.readFaults(),
  '/api/clear-faults': async () => link.clearFaults(),
  '/api/read': async (b: { addr: number }) => ({ addr: b.addr, value: await link.readAddress(Number(b.addr)) }),
  '/api/ram': async () => link.dumpRam(),
};

/* ---------------------------------------------------------------- server */

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/events') return openEvents(res);
    if (req.method === 'POST' && api[url.pathname]) return send(res, 200, await api[url.pathname](await readJson(req)));
    const asset = assets[url.pathname];
    if (asset) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      return res.end(await asset.body());
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 400, { error: (e as Error).message });
  }
}).listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`DSM 1G dashboard: http://localhost:${HTTP_PORT}${sim ? '  (simulated car)' : ''}${e935 ? '  (E935 profile)' : ''}`);
  console.log(sim ? 'Simulation: adapter appears after 2 s, ECU after 6 s.' : 'Waiting for the Arduino… plug it in any time.');
  link.start();
});

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${HTTP_PORT} is already in use. Is the dashboard already running in another terminal?`);
    console.error(`Close it, or start on another port: PORT=1992 npm run dashboard`);
    process.exit(1);
  }
  throw e;
});
