"""Perfboard layout for the Nano E935 adapter: checks the netlist, then writes the SVG.

The board is a PY 5 cm x 7 cm perfboard, every pad isolated. Seen from the component side:
24 columns A-X from left to right, 18 rows 01-18 from top to bottom. A hole is "H11": column H, row 11.
Copper-side solder trails make all connections.
"""
import sys

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWX"   # columns, left to right
ROWS = 18                              # rows 01-18, top to bottom
# Nano lying flat, USB to the left past column A. Headers on rows 11 and 17, columns A-O.
NANO_D_ROW, NANO_A_ROW = 11, 17
NANO_D = ["D12", "D11", "D10", "D9", "D8", "D7", "D6", "D5", "D4", "D3", "D2", "GND", "RST", "RX0", "TX1"]
NANO_A = ["D13", "3V3", "REF", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "5V", "RST", "GND", "VIN"]


def holes(spec):
    """Turns "H11 H10" into [("H", 11), ("H", 10)]."""
    return [(h[0], int(h[1:])) for h in spec.split()]


# (name, value, hole, hole)
RES = [
    ("R5", "2k", ("G", 9), ("G", 5)),
    ("R4", "1k", ("I", 9), ("I", 5)),
    ("R2", "10k", ("J", 9), ("N", 9)),
    ("R1", "10k", ("P", 9), ("P", 5)),
]
# Copper-side solder trails. Each one bridges neighbouring pads in order.
TRAILS = [holes(t) for t in (
    "H11 H10 H09 G09",
    "I11 I10 I09",
    "J11 J10 J09",
    "N09 O09 P09",
    "G05 H05 I05 J05 K05 L05 M05 N05 O05 P05",
    "L11 L10 L09 L08 L07",
)]
WIRES = [("car pin 1", ("K", 5)), ("car pin 12", ("L", 7))]

# ---------- Netlist check ----------
nano = {}
for i, col in enumerate(LETTERS[:15]):
    nano[(col, NANO_D_ROW)] = f"nano.{NANO_D[i]}"
    nano[(col, NANO_A_ROW)] = f"nano.A-side {NANO_A[i]}"

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
    for (c1, r1), (c2, r2) in zip(t, t[1:]):
        assert abs(LETTERS.index(c1) - LETTERS.index(c2)) + abs(r1 - r2) == 1, f"{c1}{r1}-{c2}{r2} not neighbours"
        parent[find((c1, r1))] = find((c2, r2))

for (c, r) in [h for t in TRAILS for h in t] + list(legs) + list(nano):
    assert c in LETTERS and 1 <= r <= ROWS, f"{c}{r:02d} off the board"

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
# The only exception is the fan-out from D5, D4 and D3 (columns H-J, rows 09-11), at header pitch.
used = set(nano) | set(legs) | {h for t in TRAILS for h in t}
for (c, r) in used:
    right = LETTERS[LETTERS.index(c) + 1] if c != LETTERS[-1] else None
    for nb in ((right, r), (c, r + 1)):
        if nb not in used or find((c, r)) == find(nb):
            continue
        if (c, r) in nano and nb in nano:
            continue
        fan_out = all(h[0] in "HIJ" and h[1] >= 9 for h in ((c, r), nb))
        assert fan_out, f"{c}{r:02d} and {nb[0]}{nb[1]:02d} are neighbours on different nets"
print("netlist OK", file=sys.stderr)

# ---------- SVG ----------
P = 22             # hole pitch in px
X0, Y0 = 80, 110   # first hole of a panel, relative to the panel origin
NC = len(LETTERS)
PANEL_W = (NC - 1) * P + X0 + 50
GAP = 20
W = 2 * PANEL_W + GAP
H = Y0 + (ROWS - 1) * P + 90

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
    def xy(col, row):
        i = LETTERS.index(col)
        x = NC - 1 - i if mirrored else i
        return ox + X0 + x * P, Y0 + (row - 1) * P
    add(f'<text class="th" x="{ox + X0 - 10}" y="22">{title}</text>')
    add(f'<rect x="{ox + X0 - 16}" y="{Y0 - 16}" width="{(NC - 1) * P + 32}" height="{(ROWS - 1) * P + 32}" rx="4" fill="#3f7f5a" stroke="#2a5a3e"/>')
    for col in LETTERS:
        x, _ = xy(col, 1)
        for ty in (Y0 - 22, Y0 + (ROWS - 1) * P + 32):
            add(f'<text class="ts" x="{x}" y="{ty}" text-anchor="middle">{col}</text>')
    for row in range(1, ROWS + 1):
        for col in (LETTERS[0], LETTERS[-1]):
            x, y = xy(col, row)
            lx = x - 30 if x == ox + X0 else x + 30
            add(f'<text class="ts" x="{lx}" y="{y + 4}" text-anchor="middle">{row:02d}</text>')
    for row in range(1, ROWS + 1):
        for col in LETTERS:
            x, y = xy(col, row)
            add(f'<circle cx="{x}" cy="{y}" r="6" fill="#d9a066"/><circle cx="{x}" cy="{y}" r="2.4" fill="#ffffff"/>')
    if not mirrored:
        draw_parts(xy)
        return
    for t in TRAILS:
        pts = " ".join(f"{x},{y}" for x, y in (xy(*h) for h in t))
        add(f'<polyline points="{pts}" fill="none" stroke="#9a9a96" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>')
    for h in sorted(used - set(nano)) + [(c, NANO_D_ROW) for c in "HIJL"]:
        x, y = xy(*h)
        add(f'<circle cx="{x}" cy="{y}" r="4.5" fill="#5f5e5a"/>')


def draw_parts(xy):
    xa, ya = xy("A", NANO_D_ROW)
    xb, yb = xy("O", NANO_A_ROW)
    add(f'<rect x="{xa - 34}" y="{ya - 15}" width="{xb - xa + 46}" height="{yb - ya + 30}" rx="3" fill="#dbe6f3" fill-opacity="0.92" stroke="#185fa5"/>')
    add(f'<rect x="{xa - 48}" y="{ya + 34}" width="26" height="{yb - ya - 68}" rx="2" fill="#b4b2a9" stroke="#5f5e5a"/>')
    add(f'<text class="lb" x="{xa - 35}" y="{(ya + yb) / 2}" text-anchor="middle" transform="rotate(-90 {xa - 35} {(ya + yb) / 2})">USB</text>')
    add(f'<text class="th" x="{(xa + xb) / 2}" y="{(ya + yb) / 2 + 5}" text-anchor="middle" fill="#0c447c">Nano</text>')
    for i, col in enumerate(LETTERS[:15]):
        for row, names, anchor, dy in ((NANO_D_ROW, NANO_D, "end", 8), (NANO_A_ROW, NANO_A, "start", -8)):
            x, y = xy(col, row)
            add(f'<rect x="{x - 4}" y="{y - 4}" width="8" height="8" fill="#5f5e5a"/>')
            used_pin = names[i] in ("D3", "D4", "D5", "GND") and row == NANO_D_ROW
            weight = ' font-weight="700"' if used_pin else ''
            ty = y + dy
            add(f'<text class="lb" x="{x + 3.5}" y="{ty}" text-anchor="{anchor}" transform="rotate(-90 {x + 3.5} {ty})"{weight}>{names[i]}</text>')
    for name, val, a, b in RES:
        x1, y1 = xy(*a)
        x2, y2 = xy(*b)
        add(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#ba7517" stroke-width="2"/>')
        if y1 == y2:
            add(f'<rect x="{min(x1, x2) + 16}" y="{y1 - 7}" width="{abs(x2 - x1) - 32}" height="14" rx="4" fill="#ef9f27" stroke="#854f0b" stroke-width="0.5"/>')
            add(f'<text class="lb" x="{(x1 + x2) / 2}" y="{y1 + 3.5}" text-anchor="middle">{name} {val}</text>')
        else:
            ym = (y1 + y2) / 2
            add(f'<rect x="{x1 - 7}" y="{min(y1, y2) + 16}" width="14" height="{abs(y2 - y1) - 32}" rx="4" fill="#ef9f27" stroke="#854f0b" stroke-width="0.5"/>')
            add(f'<text class="lb" x="{x1 + 3.5}" y="{ym}" text-anchor="middle" transform="rotate(-90 {x1 + 3.5} {ym})">{name} {val}</text>')
        for xx, yy in ((x1, y1), (x2, y2)):
            add(f'<circle cx="{xx}" cy="{yy}" r="3" fill="#ba7517"/>')
    colors = {"car pin 1": "#d85a30", "car pin 12": "#2c2c2a"}
    for name, h in WIRES:
        x, y = xy(*h)
        c = colors[name]
        _, y_end = xy(h[0], 1)
        add(f'<circle cx="{x}" cy="{y}" r="4" fill="{c}"/>')
        add(f'<line x1="{x}" y1="{y}" x2="{x}" y2="{y_end - 50}" stroke="{c}" stroke-width="2.5"/>')
    _, y_end = xy("K", 1)
    xk, _ = xy("K", 1)
    xl, _ = xy("L", 1)
    add(f'<text class="ts" x="{xk - 6}" y="{y_end - 40}" text-anchor="end">car pin 1</text>')
    add(f'<text class="ts" x="{xl + 6}" y="{y_end - 40}">car pin 12</text>')


panel(0, False, "Component side")
panel(PANEL_W + GAP, True, "Copper side (board flipped left to right)")
ly = H - 26
add(f'<line x1="{X0}" y1="{ly}" x2="{X0 + 30}" y2="{ly}" stroke="#9a9a96" stroke-width="7" stroke-linecap="round"/>')
add(f'<text class="ts" x="{X0 + 42}" y="{ly + 4}">solder trail: bridge the neighbouring pads, or solder a bare wire across them</text>')
add(f'<circle cx="{X0 + 500}" cy="{ly}" r="4.5" fill="#5f5e5a"/>')
add(f'<text class="ts" x="{X0 + 510}" y="{ly + 4}">solder joint</text>')
add('</svg>')
print("\n".join(out))
