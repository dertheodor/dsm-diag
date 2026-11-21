"""Perfboard layout for the Nano E935 adapter: checks the netlist, then writes the SVG.

The board is a PY 5 cm x 7 cm perfboard: 18 columns (01-18) x 24 rows (A-X), every pad isolated.
Copper-side solder trails make all connections.
"""
import sys

COLS = 18
ROWS = "ABCDEFGHIJKLMNOPQRSTUVWX"
# Nano headers on columns 2 and 8, rows A-O, USB at row A.
NANO_LEFT_COL, NANO_RIGHT_COL = 2, 8
NANO_RIGHT = ["D12", "D11", "D10", "D9", "D8", "D7", "D6", "D5", "D4", "D3", "D2", "GND", "RST", "RX0", "TX1"]
NANO_LEFT = ["D13", "3V3", "REF", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "5V", "RST", "GND", "VIN"]


def holes(spec):
    """Turns "H8 H9 H10" into [("H", 8), ("H", 9), ("H", 10)]."""
    return [(h[0], int(h[1:])) for h in spec.split()]


# (name, value, hole, hole)
RES = [
    ("R5", "2k", ("G", 10), ("G", 14)),
    ("R4", "1k", ("I", 10), ("I", 14)),
    ("R2", "10k", ("J", 10), ("N", 10)),
    ("R1", "10k", ("P", 10), ("P", 14)),
]
# Copper-side solder trails. Each one bridges neighbouring pads in order.
TRAILS = [holes(t) for t in (
    "H8 H9 H10 G10",
    "I8 I9 I10",
    "J8 J9 J10",
    "N10 O10 P10",
    "G14 H14 I14 J14 K14 L14 M14 N14 O14 P14",
    "L8 L9 L10 L11 L12",
)]
WIRES = [("car pin 1", ("K", 14)), ("car pin 12", ("L", 12))]

# ---------- Netlist check ----------
nano = {}
for i, r in enumerate(ROWS[:15]):
    nano[(r, NANO_RIGHT_COL)] = f"nano.{NANO_RIGHT[i]}"
    nano[(r, NANO_LEFT_COL)] = f"nano.L{NANO_LEFT[i]}"

legs = {}
for name, _, a, b in RES:
    legs[a], legs[b] = f"{name}.a", f"{name}.b"
for name, h in WIRES:
    legs[h] = name
for h in legs:
    assert h not in nano, f"{h} is a Nano pin"
assert len(legs) == 2 * len(RES) + len(WIRES), "two legs share a hole"

parent = {}
def find(x):
    parent.setdefault(x, x)
    while parent[x] != x:
        x = parent[x]
    return x

for t in TRAILS:
    for (r1, c1), (r2, c2) in zip(t, t[1:]):
        assert abs(ROWS.index(r1) - ROWS.index(r2)) + abs(c1 - c2) == 1, f"{r1}{c1}-{r2}{c2} not neighbours"
        parent[find((r1, c1))] = find((r2, c2))

for (r, c) in [h for t in TRAILS for h in t] + list(legs) + list(nano):
    assert r in ROWS and 1 <= c <= COLS, f"{r}{c} off the board"

where = {v: k for k, v in {**nano, **legs}.items()}
net = lambda n: find(where[n])

# Expected circuit (docs/wiring.md, inverted wiring; one 2k replaces R5 + R6):
#   D4 -R4 1k- line;  D5 -R5 2k- line;  line -R1 10k- y -R2 10k- D3;  GND = car pin 12.
expect_same = [
    ["nano.D4", "R4.a"], ["R4.b", "R5.b", "R1.b", "car pin 1"],
    ["nano.D5", "R5.a"],
    ["nano.D3", "R2.a"], ["R2.b", "R1.a"],
    ["nano.GND", "car pin 12"],
]
for group in expect_same:
    assert len({net(n) for n in group}) == 1, f"not connected: {group}"
reps = [net(g[0]) for g in expect_same]
assert len(set(reps)) == len(reps), "two nets are shorted"
for h, n in nano.items():
    if n not in ("nano.D3", "nano.D4", "nano.D5", "nano.GND"):
        assert find(h) not in reps, f"{n} shorted to a used net"

# Clearance: pads of different nets must not be neighbours, so a solder blob cannot bridge them.
# The only exception is the fan-out from D5, D4 and D3 (rows H-J, columns 8-10), at header pitch.
used = set(nano) | set(legs) | {h for t in TRAILS for h in t}
for (r, c) in used:
    for nb in ((r, c + 1), (ROWS[ROWS.index(r) + 1] if r != ROWS[-1] else None, c)):
        if nb not in used or find((r, c)) == find(nb):
            continue
        if (r, c) in nano and nb in nano:
            continue
        fan_out = all(h[0] in "HIJ" and h[1] <= 10 for h in ((r, c), nb))
        assert fan_out, f"{r}{c} and {nb[0]}{nb[1]} are neighbours on different nets"
print("netlist OK", file=sys.stderr)

# ---------- SVG ----------
P = 22             # hole pitch in px
X0, Y0 = 50, 110   # first hole of a panel, relative to the panel origin
PANEL_W = (COLS - 1) * P + X0 + 140
GAP = 20
W = 2 * PANEL_W + GAP
H = Y0 + (len(ROWS) - 1) * P + 90

out = []
add = out.append
add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img">')
add('<title>dsm-diag Nano adapter, perfboard layout, inverted line (E935)</title>')
add('''<style>
  text { font-family: -apple-system, "Segoe UI", "DejaVu Sans", Helvetica, Arial, sans-serif; }
  .ts { font-size: 11px; fill: #444441; }
  .th { font-size: 14px; font-weight: 600; fill: #2c2c2a; }
  .lb { font-size: 10px; fill: #2c2c2a; }
</style>''')
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')


def panel(ox, mirrored, title):
    def xy(row, col):
        c = COLS + 1 - col if mirrored else col
        return ox + X0 + (c - 1) * P, Y0 + ROWS.index(row) * P
    add(f'<text class="th" x="{ox + X0 - 10}" y="22">{title}</text>')
    add(f'<rect x="{ox + X0 - 16}" y="{Y0 - 16}" width="{(COLS - 1) * P + 32}" height="{(len(ROWS) - 1) * P + 32}" rx="4" fill="#3f7f5a" stroke="#2a5a3e"/>')
    for col in range(1, COLS + 1):
        x, _ = xy("A", col)
        for ty in (Y0 - 22, Y0 + (len(ROWS) - 1) * P + 32):
            add(f'<text class="ts" x="{x}" y="{ty}" text-anchor="middle">{col:02d}</text>')
    for r in ROWS:
        x, y = xy(r, 1)
        lx = x + 26 if mirrored else x - 26
        add(f'<text class="ts" x="{lx}" y="{y + 4}" text-anchor="middle">{r}</text>')
    for r in ROWS:
        for col in range(1, COLS + 1):
            x, y = xy(r, col)
            add(f'<circle cx="{x}" cy="{y}" r="6" fill="#d9a066"/><circle cx="{x}" cy="{y}" r="2.4" fill="#ffffff"/>')
    if not mirrored:
        draw_parts(xy)
        return
    for t in TRAILS:
        pts = " ".join(f"{x},{y}" for x, y in (xy(*h) for h in t))
        add(f'<polyline points="{pts}" fill="none" stroke="#9a9a96" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>')
    for h in sorted(used - set(nano)) + [(r, NANO_RIGHT_COL) for r in "HIJL"]:
        x, y = xy(*h)
        add(f'<circle cx="{x}" cy="{y}" r="4.5" fill="#5f5e5a"/>')


def draw_parts(xy):
    xa, ya = xy("A", NANO_LEFT_COL)
    xb, yb = xy("O", NANO_RIGHT_COL)
    add(f'<rect x="{xa - 15}" y="{ya - 34}" width="{xb - xa + 30}" height="{yb - ya + 46}" rx="3" fill="#dbe6f3" fill-opacity="0.92" stroke="#185fa5"/>')
    add(f'<rect x="{xa + 34}" y="{ya - 48}" width="{xb - xa - 68}" height="26" rx="2" fill="#b4b2a9" stroke="#5f5e5a"/>')
    add(f'<text class="lb" x="{(xa + xb) / 2}" y="{ya - 31}" text-anchor="middle">USB</text>')
    add(f'<text class="th" x="{(xa + xb) / 2}" y="{(ya + yb) / 2}" text-anchor="middle" fill="#0c447c">Nano</text>')
    for i, r in enumerate(ROWS[:15]):
        for col, names, anchor, dx in ((NANO_LEFT_COL, NANO_LEFT, "start", 8), (NANO_RIGHT_COL, NANO_RIGHT, "end", -8)):
            x, y = xy(r, col)
            add(f'<rect x="{x - 4}" y="{y - 4}" width="8" height="8" fill="#5f5e5a"/>')
            used_pin = names[i] in ("D3", "D4", "D5", "GND") and col == NANO_RIGHT_COL
            weight = ' font-weight="700"' if used_pin else ''
            add(f'<text class="lb" x="{x + dx}" y="{y + 3.5}" text-anchor="{anchor}"{weight}>{names[i]}</text>')
    for name, val, a, b in RES:
        x1, y1 = xy(*a)
        x2, y2 = xy(*b)
        add(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#ba7517" stroke-width="2"/>')
        if y1 == y2:
            add(f'<rect x="{x1 + 16}" y="{y1 - 7}" width="{x2 - x1 - 32}" height="14" rx="4" fill="#ef9f27" stroke="#854f0b" stroke-width="0.5"/>')
            add(f'<text class="lb" x="{(x1 + x2) / 2}" y="{y1 + 3.5}" text-anchor="middle">{name} {val}</text>')
        else:
            add(f'<rect x="{x1 - 7}" y="{y1 + 16}" width="14" height="{y2 - y1 - 32}" rx="4" fill="#ef9f27" stroke="#854f0b" stroke-width="0.5"/>')
            add(f'<text class="lb" x="{x1 + 3.5}" y="{(y1 + y2) / 2}" text-anchor="middle" transform="rotate(-90 {x1 + 3.5} {(y1 + y2) / 2})">{name} {val}</text>')
        for xx, yy in ((x1, y1), (x2, y2)):
            add(f'<circle cx="{xx}" cy="{yy}" r="3" fill="#ba7517"/>')
    colors = {"car pin 1": "#d85a30", "car pin 12": "#2c2c2a"}
    for name, h in WIRES:
        x, y = xy(*h)
        c = colors[name]
        x_end, _ = xy(h[0], COLS)
        add(f'<circle cx="{x}" cy="{y}" r="4" fill="{c}"/>')
        add(f'<line x1="{x}" y1="{y}" x2="{x_end + 30}" y2="{y}" stroke="{c}" stroke-width="2.5"/>')
        add(f'<text class="ts" x="{x_end + 34}" y="{y + 4}">{name}</text>')


panel(0, False, "Component side")
panel(PANEL_W + GAP, True, "Copper side (board flipped left to right)")
ly = H - 26
add(f'<line x1="{X0}" y1="{ly}" x2="{X0 + 30}" y2="{ly}" stroke="#9a9a96" stroke-width="7" stroke-linecap="round"/>')
add(f'<text class="ts" x="{X0 + 42}" y="{ly + 4}">solder trail: bridge the neighbouring pads, or solder a bare wire across them</text>')
add(f'<circle cx="{X0 + 500}" cy="{ly}" r="4.5" fill="#5f5e5a"/>')
add(f'<text class="ts" x="{X0 + 510}" y="{ly + 4}">solder joint</text>')
add('</svg>')
print("\n".join(out))
