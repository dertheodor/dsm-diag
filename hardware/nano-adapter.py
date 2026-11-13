"""Stripboard layout for the Nano E935 adapter: checks the netlist, then writes the SVG."""
import sys

COLS = 24
STRIPS = "ABCDEFGHIJKLMNO"
# Nano header on column 9, top to bottom (USB at the top edge).
NANO_RIGHT = ["D12", "D11", "D10", "D9", "D8", "D7", "D6", "D5", "D4", "D3", "D2", "GND", "RST", "RX0", "TX1"]
NANO_LEFT = ["D13", "3V3", "REF", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "5V", "RST", "GND", "VIN"]

CUTS = [(s, 6) for s in STRIPS] + [("H", 13), ("H", 18), ("I", 13), ("J", 13), ("J", 18)]

# (name, value, (strip, col), (strip, col))
RES = [
    ("R6", "1k", ("H", 11), ("H", 15)),
    ("R5", "1k", ("H", 16), ("H", 20)),
    ("R4", "1k", ("I", 11), ("I", 15)),
    ("R2", "10k", ("J", 11), ("J", 15)),
    ("R1", "10k", ("J", 16), ("J", 20)),
]
LINKS = [(("H", 22), ("I", 22)), (("I", 23), ("J", 23))]
WIRES = [("car pin 1", ("I", 24)), ("car pin 12", ("L", 24))]


def segment(strip, col):
    """Returns the copper segment id of a hole: (strip, index of the segment)."""
    cuts = sorted(c for s, c in CUTS if s == strip)
    assert col not in cuts, f"{strip}{col} is a cut hole"
    return (strip, sum(1 for c in cuts if c < col))


# Union-find over segments.
parent = {}
def find(x):
    parent.setdefault(x, x)
    while parent[x] != x:
        x = parent[x]
    return x
def union(a, b):
    parent[find(a)] = find(b)

for a, b in LINKS:
    union(segment(*a), segment(*b))

nodes = {}
for i, s in enumerate(STRIPS):
    nodes[f"nano.{NANO_RIGHT[i]}"] = segment(s, 9)
for name, _, a, b in RES:
    nodes[f"{name}.a"] = segment(*a)
    nodes[f"{name}.b"] = segment(*b)
for name, h in WIRES:
    nodes[name] = segment(*h)

USED = [(s, 9) for s in "HIJL"] + [h for _, _, a, b in RES for h in (a, b)] + [h for l in LINKS for h in l] + [h for _, h in WIRES]
net = lambda n: find(nodes[n])

# Expected circuit (docs/wiring.md, inverted wiring):
#   D4 -R4 1k- line;  line -R5 1k- x -R6 1k- D5;  line -R1 10k- y -R2 10k- D3;  GND = car pin 12.
expect_same = [
    ["nano.D4", "R4.a"], ["R4.b", "R5.b", "R1.b", "car pin 1"],
    ["nano.D5", "R6.a"], ["R6.b", "R5.a"],
    ["nano.D3", "R2.a"], ["R2.b", "R1.a"],
    ["nano.GND", "car pin 12"],
]
for group in expect_same:
    assert len({net(n) for n in group}) == 1, f"not connected: {group}"
reps = [net(g[0]) for g in expect_same]
assert len(set(reps)) == len(reps), "two nets are shorted"
# No other Nano pin may touch a used net.
for n in nodes:
    if n.startswith("nano.") and n not in ("nano.D3", "nano.D4", "nano.D5", "nano.GND"):
        assert net(n) not in reps, f"{n} shorted to a used net"
# Every resistor has its legs on different segments.
for name, _, a, b in RES:
    assert segment(*a) != segment(*b), f"{name} legs shorted"
# Left header is isolated from the right header.
for i, s in enumerate(STRIPS):
    assert segment(s, 3) != segment(s, 9)
print("netlist OK", file=sys.stderr)

# ---------- SVG ----------
P = 22            # hole pitch in px
X0, Y0 = 50, 100   # first hole of a panel
PANEL_W = COLS * P + 110
GAP = 50
W = 2 * PANEL_W + GAP + 60
H = Y0 + len(STRIPS) * P + 60

out = []
add = out.append
add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img">')
add('<title>dsm-diag Nano adapter, stripboard layout, inverted line (E935)</title>')
add('''<style>
  text { font-family: -apple-system, "Segoe UI", "DejaVu Sans", Helvetica, Arial, sans-serif; }
  .ts { font-size: 11px; fill: #444441; }
  .th { font-size: 14px; font-weight: 600; fill: #2c2c2a; }
  .lb { font-size: 10px; fill: #2c2c2a; }
</style>''')
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')


def panel(ox, mirrored, title):
    def xy(strip, col):
        c = COLS + 1 - col if mirrored else col
        return ox + X0 + (c - 1) * P, Y0 + STRIPS.index(strip) * P
    add(f'<text class="th" x="{ox + X0 - 10}" y="22">{title}</text>')
    # Board.
    add(f'<rect x="{ox + X0 - 14}" y="{Y0 - 14}" width="{(COLS - 1) * P + 28}" height="{(len(STRIPS) - 1) * P + 28}" rx="4" fill="#f3e9d2" stroke="#b4b2a9"/>')
    # Column and strip labels.
    for col in range(1, COLS + 1):
        if col in (1, 3, 6, 9, 11, 13, 15, 16, 18, 20, 22, 24):
            x, _ = xy("A", col)
            add(f'<text class="ts" x="{x}" y="{Y0 - 20}" text-anchor="middle">{col}</text>')
    for s in STRIPS:
        x, y = xy(s, 1)
        lx = x + 22 if mirrored else x - 22
        add(f'<text class="ts" x="{lx}" y="{y + 4}" text-anchor="middle">{s}</text>')
    # Copper strips.
    color = "#c87533" if mirrored else "#ecd3bd"
    for s in STRIPS:
        x1, y = xy(s, 1)
        x2, _ = xy(s, COLS)
        add(f'<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="{color}" stroke-width="12" stroke-linecap="round"/>')
    # Holes.
    for s in STRIPS:
        for col in range(1, COLS + 1):
            x, y = xy(s, col)
            add(f'<circle cx="{x}" cy="{y}" r="2.6" fill="#ffffff" stroke="#888780" stroke-width="0.5"/>')
    if not mirrored:
        draw_parts(xy)
        return
    # Holes with a part leg or wire.
    for h in USED:
        x, y = xy(*h)
        add(f'<circle cx="{x}" cy="{y}" r="4" fill="#2c2c2a"/>')
    # Cuts.
    for s, col in CUTS:
        x, y = xy(s, col)
        add(f'<rect x="{x - 5}" y="{y - 8}" width="10" height="16" fill="#ffffff" stroke="#d22" stroke-width="1.5"/>'
            f'<line x1="{x - 5}" y1="{y - 8}" x2="{x + 5}" y2="{y + 8}" stroke="#d22" stroke-width="1.5"/>')


def draw_parts(xy):
    # Nano outline and pins.
    xa, ya = xy("A", 3)
    xb, yb = xy("O", 9)
    add(f'<rect x="{xa - 11}" y="{ya - 40}" width="{xb - xa + 22}" height="{yb - ya + 51}" rx="3" fill="#dbe6f3" stroke="#185fa5"/>')
    add(f'<rect x="{xa + 30}" y="{ya - 48}" width="{xb - xa - 60}" height="24" rx="2" fill="#b4b2a9" stroke="#5f5e5a"/>')
    add(f'<text class="lb" x="{(xa + xb) / 2}" y="{ya - 32}" text-anchor="middle">USB</text>')
    add(f'<text class="th" x="{(xa + xb) / 2}" y="{(ya + yb) / 2}" text-anchor="middle" fill="#0c447c">Nano</text>')
    for i, s in enumerate(STRIPS):
        for col, names, anchor, dx in ((3, NANO_LEFT, "start", 6), (9, NANO_RIGHT, "end", -6)):
            x, y = xy(s, col)
            add(f'<rect x="{x - 4}" y="{y - 4}" width="8" height="8" fill="#5f5e5a"/>')
            used = names[i] in ("D3", "D4", "D5", "GND") and col == 9
            weight = ' font-weight="700"' if used else ''
            add(f'<text class="lb" x="{x + dx}" y="{y + 3.5}" text-anchor="{anchor}"{weight}>{names[i]}</text>')
    # Resistors.
    for name, val, a, b in RES:
        x1, y = xy(*a)
        x2, _ = xy(*b)
        add(f'<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="#ba7517" stroke-width="2"/>')
        add(f'<rect x="{x1 + 18}" y="{y - 6}" width="{x2 - x1 - 36}" height="12" rx="4" fill="#ef9f27" stroke="#854f0b" stroke-width="0.5"/>')
        add(f'<text class="lb" x="{(x1 + x2) / 2}" y="{y + 3.5}" text-anchor="middle">{name} {val}</text>')
        for xx in (x1, x2):
            add(f'<circle cx="{xx}" cy="{y}" r="3" fill="#ba7517"/>')
    # Links.
    for a, b in LINKS:
        x1, y1 = xy(*a)
        x2, y2 = xy(*b)
        add(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#2c2c2a" stroke-width="2.5"/>')
        for xx, yy in ((x1, y1), (x2, y2)):
            add(f'<circle cx="{xx}" cy="{yy}" r="3" fill="#2c2c2a"/>')
    # Car wires.
    colors = {"car pin 1": "#d85a30", "car pin 12": "#2c2c2a"}
    for name, h in WIRES:
        x, y = xy(*h)
        c = colors[name]
        add(f'<circle cx="{x}" cy="{y}" r="4" fill="{c}"/>')
        add(f'<line x1="{x}" y1="{y}" x2="{x + 40}" y2="{y}" stroke="{c}" stroke-width="2.5"/>')
        add(f'<text class="ts" x="{x + 44}" y="{y + 4}">{name}</text>')


panel(0, False, "Component side")
panel(PANEL_W + GAP, True, "Copper side (board flipped left to right)")
ly = H - 22
add(f'<rect x="{X0}" y="{ly - 9}" width="10" height="14" fill="#ffffff" stroke="#d22" stroke-width="1.5"/>'
    f'<line x1="{X0}" y1="{ly - 9}" x2="{X0 + 10}" y2="{ly + 5}" stroke="#d22" stroke-width="1.5"/>')
add(f'<text class="ts" x="{X0 + 18}" y="{ly + 2}">track cut (drill or knife the copper at this hole)</text>')
add(f'<line x1="{X0 + 330}" y1="{ly - 2}" x2="{X0 + 350}" y2="{ly - 2}" stroke="#2c2c2a" stroke-width="2.5"/>')
add(f'<text class="ts" x="{X0 + 358}" y="{ly + 2}">wire link</text>')
add(f'<circle cx="{X0 + 470}" cy="{ly - 2}" r="4" fill="#2c2c2a"/>')
add(f'<text class="ts" x="{X0 + 480}" y="{ly + 2}">solder joint of a resistor, link or wire (the Nano pins are not marked)</text>')
add('</svg>')
print("\n".join(out))
