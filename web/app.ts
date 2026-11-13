/* Dashboard client. Talks to the local server over SSE (/events) + JSON POSTs (/api/*). */

type LinkState =
  | { phase: 'searching' }
  | { phase: 'opening'; path: string }
  | { phase: 'no-line'; path: string; detail: string }
  | { phase: 'no-ecu'; path: string }
  | { phase: 'online'; path: string; version: { raw: number; cpu: string } };

interface SensorMeta { id: string; name: string; addr: number; unit: string }
interface Meta { sim: boolean; sensors: SensorMeta[]; flags: Record<string, Record<string, string>>; poll: string[]; rawMap: boolean }
interface Sample { t: number; values: Record<string, { raw: number; value: number }>; reqPerSec: number }
interface Fault { code: number; name: string }
interface Faults { active: Fault[]; stored: Fault[]; t: number }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const HISTORY_MS = 30_000;

let meta: Meta | null = null;
let online = false;
const history = new Map<string, { t: number; v: number }[]>();
type Rec = { t: number; values: Sample['values'] };
let recording: Rec[] | null = null;
let recorded: Rec[] | null = null;

/* ------------------------------------------------------------- helpers */

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

function fmt(unit: string, v: number): string {
  const digits: Record<string, number> = { rpm: 0, '°C': 0, '°BTDC': 0, V: 2, bar: 3, Hz: 0, ms: 2, '%': 1, steps: 0, count: 0 };
  return v.toFixed(digits[unit] ?? 1);
}

function log(text: string, t = Date.now()) {
  const li = document.createElement('li');
  li.innerHTML = `<time>${new Date(t).toLocaleTimeString()}</time><span></span>`;
  li.querySelector('span')!.textContent = text;
  const ol = $('log');
  ol.prepend(li);
  while (ol.children.length > 100) ol.lastChild!.remove();
}

/* --------------------------------------------------------- connection */

function renderState(s: LinkState) {
  online = s.phase === 'online';
  const steps = ['laptop', 'adapter', 'line', 'ecu'] as const;
  const status: Record<(typeof steps)[number], '' | 'ok' | 'wait' | 'bad'> = { laptop: 'ok', adapter: '', line: '', ecu: '' };
  let hint = '';

  switch (s.phase) {
    case 'searching':
      status.adapter = 'wait';
      hint = 'Plug the Arduino into this laptop. The dashboard connects on its own.';
      break;
    case 'opening':
      status.adapter = 'wait';
      hint = `Found the Arduino at ${s.path}. Connecting…`;
      break;
    case 'no-line': {
      status.adapter = 'ok';
      status.line = 'bad';
      if (/no echo/.test(s.detail)) hint = "The Arduino doesn't hear its own signal. Check that the bridge sketch is uploaded with WIRING_12V and D3 goes to e4.";
      else if (/got 0x00/.test(s.detail)) hint = 'The diagnostic line reads as permanently low. Turn the ignition on, and check that car pin 1 goes to a10.';
      else if (/got 0xFF/.test(s.detail)) hint = 'The line never goes low when the Arduino sends. Check D2 → IN1 and module OUT1 → e10.';
      else hint = `The signal comes back garbled (${s.detail}). Check for loose wires.`;
      break;
    }
    case 'no-ecu':
      status.adapter = 'ok';
      status.line = 'ok';
      status.ecu = 'wait';
      hint = "The line works, but the ECU doesn't answer. Turn the ignition on (engine can stay off) and bridge pin 10 to pin 12.";
      break;
    case 'online':
      for (const k of steps) status[k] = 'ok';
      hint = 'Connected. Reading live data.';
      break;
  }

  for (const li of $('chain').querySelectorAll<HTMLLIElement>('li')) {
    li.className = status[li.dataset.step as (typeof steps)[number]];
  }
  $('port').textContent = 'path' in s ? s.path : '';
  $('ver').textContent = s.phase === 'online' ? `version byte 0x${hex2(s.version.raw)}${s.version.cpu === 'unknown' ? '' : ` (${s.version.cpu})`}` : '';
  $('hint').textContent = hint;
  $('lcd').classList.toggle('off', !online);
  if (!online) {
    for (const v of $('lcd').querySelectorAll('.v')) v.textContent = '–';
    $('rate').textContent = '';
  }
  for (const id of ['readFaults', 'clearFaults', 'ramBtn']) $<HTMLButtonElement>(id).disabled = !online;
}

/* ------------------------------------------------------------ sensors */

function buildSensorRows(m: Meta) {
  const tbody = $('sensorRows');
  tbody.innerHTML = '';
  for (const s of m.sensors) {
    const tr = document.createElement('tr');
    tr.dataset.id = s.id;
    tr.className = m.poll.includes(s.id) ? '' : 'idle';
    tr.innerHTML = `
      <td><input type="checkbox" aria-label="Poll ${s.name}" ${m.poll.includes(s.id) ? 'checked' : ''}></td>
      <td><span class="name"></span></td>
      <td class="val num"><span class="n">–</span><span class="unit"></span></td>
      <td class="raw num" title="Address 0x${hex2(s.addr)}">–</td>
      <td><svg viewBox="0 0 120 22" preserveAspectRatio="none" aria-hidden="true"><polyline points=""/></svg></td>`;
    tr.querySelector('.name')!.textContent = s.name;
    tr.querySelector('.unit')!.textContent = s.unit;
    tr.querySelector('input')!.addEventListener('change', sendPollSelection);
    tbody.append(tr);
  }
}

async function sendPollSelection() {
  const ids = [...$('sensorRows').querySelectorAll<HTMLTableRowElement>('tr')]
    .filter((tr) => tr.querySelector('input')!.checked)
    .map((tr) => tr.dataset.id!);
  for (const tr of $('sensorRows').querySelectorAll<HTMLTableRowElement>('tr')) tr.classList.toggle('idle', !ids.includes(tr.dataset.id!));
  await post('/api/poll', { sensors: ids });
}

function sparkline(points: { t: number; v: number }[], now: number): string {
  if (points.length < 2) return '';
  let lo = Infinity, hi = -Infinity;
  for (const p of points) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
  const span = hi - lo || 1;
  return points
    .map((p) => `${(120 * (1 - (now - p.t) / HISTORY_MS)).toFixed(1)},${(20 - (18 * (p.v - lo)) / span).toFixed(1)}`)
    .join(' ');
}

function onSample(s: Sample) {
  if (!meta) return;
  for (const [id, { raw, value }] of Object.entries(s.values)) {
    const sm = meta.sensors.find((x) => x.id === id)!;
    const tr = $('sensorRows').querySelector<HTMLTableRowElement>(`tr[data-id="${id}"]`);
    if (tr) {
      tr.querySelector('.n')!.textContent = fmt(sm.unit, value);
      tr.querySelector('.raw')!.textContent = hex2(raw);
    }
    const h = history.get(id) ?? [];
    h.push({ t: s.t, v: value });
    while (h.length && s.t - h[0].t > HISTORY_MS) h.shift();
    history.set(id, h);
    tr?.querySelector('polyline')!.setAttribute('points', sparkline(h, s.t));

    const big = $('lcd').querySelector(`.big[data-id="${id}"] .v`);
    if (big) big.textContent = fmt(sm.unit, value);
  }
  for (const big of $('lcd').querySelectorAll<HTMLElement>('.big')) {
    if (!(big.dataset.id! in s.values)) big.querySelector('.v')!.textContent = 'off';
  }
  $('rate').textContent = `${s.reqPerSec.toFixed(0)} requests per second`;
  if (recording) {
    recording.push({ t: s.t, values: s.values });
    $('rec').textContent = `Stop (${recording.length})`;
  }
}

$('rec').addEventListener('click', () => {
  const btn = $('rec');
  if (recording) {
    recorded = recording;
    recording = null;
    btn.textContent = 'Record';
    btn.classList.remove('on');
    $<HTMLButtonElement>('csv').disabled = recorded.length === 0;
    log(`Recording stopped, ${recorded.length} samples`);
  } else {
    recording = [];
    btn.classList.add('on');
    btn.textContent = 'Stop (0)';
    log('Recording started');
  }
});

$('csv').addEventListener('click', () => {
  const rows = recorded;
  if (!rows || !meta) return;
  const ids = meta.sensors.map((s) => s.id).filter((id) => rows.some((r) => id in r.values));
  const lines = [['time', ...ids.flatMap((id) => [id, `${id}_raw`])].join(',')];
  for (const r of rows) {
    lines.push([new Date(r.t).toISOString(), ...ids.flatMap((id) => [r.values[id]?.value ?? '', r.values[id]?.raw ?? ''])].join(','));
  }
  download(`eclipse-log-${stamp()}.csv`, lines.join('\n'), 'text/csv');
});

/* -------------------------------------------------------------- flags */

function renderFlags(on: string[]) {
  if (!meta) return;
  const ul = $('flags');
  const names = Object.values(meta.flags).flatMap((bits) => Object.values(bits));
  ul.innerHTML = '';
  for (const n of names) {
    const li = document.createElement('li');
    li.textContent = n;
    if (on.includes(n)) li.className = 'lit';
    ul.append(li);
  }
}

/* ------------------------------------------------------------- faults */

function renderFaults(f: Faults) {
  const fill = (ul: HTMLElement, list: Fault[]) => {
    ul.innerHTML = '';
    if (!list.length) {
      ul.innerHTML = '<li class="empty">None</li>';
      return;
    }
    for (const x of list) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="c">${x.code}</span><span></span>`;
      li.lastElementChild!.textContent = x.name;
      ul.append(li);
    }
  };
  fill($('faultsActive'), f.active);
  fill($('faultsStored'), f.stored);
}

$('readFaults').addEventListener('click', async () => {
  try { renderFaults(await post<Faults>('/api/faults')); log('Fault codes read'); }
  catch (e) { log((e as Error).message); }
});

$('clearFaults').addEventListener('click', async () => {
  if (!confirm('Clear all stored fault codes? The engine must be off.')) return;
  try {
    const r = await post<{ cleared: boolean; faults: Faults }>('/api/clear-faults');
    renderFaults(r.faults);
  } catch (e) { log((e as Error).message); }
});

/* ------------------------------------------------------------ hex views */

function renderHex(el: HTMLElement, from: number, to: number, bytes: Map<number, number>, prev?: Map<number, number>) {
  const known = new Map(meta?.sensors.map((s) => [s.addr, s.name]) ?? []);
  el.innerHTML = '';
  for (let row = from & 0xf0; row <= to; row += 16) {
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = hex2(row);
    el.append(lbl);
    for (let col = 0; col < 16; col++) {
      const a = row + col;
      const cell = document.createElement('span');
      cell.className = 'b';
      const v = bytes.get(a);
      if (a < from || a > to || v === undefined || v < 0) {
        cell.classList.add('blank');
        cell.textContent = '··';
      } else {
        cell.textContent = hex2(v);
        if (prev && prev.has(a) && prev.get(a) !== v) cell.classList.add('chg');
      }
      if (known.has(a)) {
        cell.classList.add('known');
        cell.title = `0x${hex2(a)}: ${known.get(a)}`;
      } else cell.title = `0x${hex2(a)}`;
      el.append(cell);
    }
  }
}

let rawPrev: Map<number, number> | undefined;
function onRawMap(d: { bytes: number[] }) {
  const now = new Map(d.bytes.map((v, i) => [i, v] as [number, number]));
  renderHex($('rawGrid'), 0x00, 0x3f, now, rawPrev);
  rawPrev = now;
}

$<HTMLInputElement>('rawToggle').addEventListener('change', async (e) => {
  const on = (e.target as HTMLInputElement).checked;
  await post('/api/poll', { rawMap: on });
  log(on ? 'Scanning 0x00–0x3F' : 'Stopped scanning 0x00–0x3F');
});

let ramLast: Map<number, number> | undefined;
let ramJson = '';
$('ramBtn').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('ramBtn');
  btn.disabled = true;
  btn.textContent = 'Reading…';
  try {
    const data = await post<Record<string, number>>('/api/ram');
    const now = new Map(Object.entries(data).map(([k, v]) => [parseInt(k, 16), v] as [number, number]));
    const changed = ramLast ? [...now].filter(([a, v]) => ramLast!.get(a) !== v).length : 0;
    renderHex($('ramGrid'), 0x40, 0xf0, now, ramLast);
    $('ramNote').textContent = ramLast
      ? `${changed} byte${changed === 1 ? '' : 's'} changed since the previous read.`
      : 'Read it again to see what changed in between.';
    ramLast = now;
    ramJson = JSON.stringify({ t: new Date().toISOString(), rom: 'E935', ram: data }, null, 1);
    $<HTMLButtonElement>('ramSave').disabled = false;
  } catch (e) {
    log((e as Error).message);
  } finally {
    btn.textContent = 'Read RAM';
    btn.disabled = !online;
  }
});
$('ramSave').addEventListener('click', () => download(`e935-ram-${stamp()}.json`, ramJson, 'application/json'));

$('readForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('addr');
  const out = $<HTMLOutputElement>('readOut');
  const addr = parseInt(input.value, 16);
  out.className = '';
  if (!/^[0-9a-f]{1,2}$/i.test(input.value)) {
    out.className = 'err';
    out.textContent = 'Enter a hex address from 00 to FF.';
    return;
  }
  try {
    const r = await post<{ value: number }>('/api/read', { addr });
    out.textContent = `0x${hex2(addr)} → 0x${hex2(r.value)} (${r.value})`;
    log(`Read 0x${hex2(addr)} = 0x${hex2(r.value)}`);
  } catch (err) {
    out.className = 'err';
    out.textContent = (err as Error).message;
  }
});

/* ------------------------------------------------------------- misc */

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}
function download(name: string, body: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* -------------------------------------------------------------- events */

function connect() {
  const es = new EventSource('/events');
  const on = <T>(ev: string, fn: (d: T) => void) => es.addEventListener(ev, (e) => fn(JSON.parse((e as MessageEvent).data)));
  on<Meta>('meta', (m) => {
    meta = m;
    $('sim').hidden = !m.sim;
    $<HTMLInputElement>('rawToggle').checked = m.rawMap;
    buildSensorRows(m);
    renderFlags([]);
    renderHex($('rawGrid'), 0x00, 0x3f, new Map());
    renderHex($('ramGrid'), 0x40, 0xf0, new Map());
  });
  on<LinkState>('state', renderState);
  on<Sample>('sample', onSample);
  on<{ on: string[] }>('flags', (f) => renderFlags(f.on));
  on<Faults>('faults', renderFaults);
  on<{ bytes: number[] }>('rawmap', onRawMap);
  on<{ t: number; text: string }>('log', (l) => log(l.text, l.t));
  es.onerror = () => {
    renderState({ phase: 'searching' });
    $('hint').textContent = 'Lost the dashboard server. Is "npm run dashboard" still running?';
    $('chain').querySelector('li')!.className = 'bad';
  };
}

connect();
