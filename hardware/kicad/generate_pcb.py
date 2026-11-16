"""Writes dsm-adapter.kicad_pcb: places and routes the parts of dsm-adapter.kicad_sch.

Run with the Python that ships with KiCad (it needs the pcbnew module).
Coordinates are in mm from the top-left board corner. y grows down.
"""
import re
import subprocess
import tempfile
import uuid
from pathlib import Path

import pcbnew

HERE = Path(__file__).parent
FP = Path("/usr/share/kicad/footprints")
ROOT = "6f1c2a0e-5d3b-4c8e-9a71-2b4d8e0f1c35"  # The same as in generate_sch.py.
ORIGIN = (100.0, 50.0)                           # Board corner on the page.
W, H = 48.0, 55.0

board = pcbnew.BOARD()
nets = {}


def schematic_nets():
    """Returns {(ref, pad): net} from the schematic netlist, the one owner of the connections."""
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "net"
        subprocess.run(["kicad-cli", "sch", "export", "netlist", "--format", "kicadsexpr", "-o", str(out),
                        str(HERE / "dsm-adapter.kicad_sch")], check=True, capture_output=True)
        s = out.read_text()
    s = s[s.index("(nets"):]
    pads = {}
    for block in re.split(r"\n\t\t\(net\n", s)[1:]:
        name = re.search(r'\(name "([^"]+)"', block).group(1)
        for ref, pin in re.findall(r'\(ref "([^"]+)"\)\s*\(pin "([^"]+)"\)', block):
            pads[ref, pin] = name
    return pads


SCH = schematic_nets()


def mm(x, y):
    return pcbnew.VECTOR2I(pcbnew.FromMM(ORIGIN[0] + x), pcbnew.FromMM(ORIGIN[1] + y))


def net(name):
    if name not in nets:
        nets[name] = pcbnew.NETINFO_ITEM(board, name)
        board.Add(nets[name])
    return nets[name]


def footprint(lib, name, ref, value, x, y, angle, pad_nets):
    """Places a library footprint and links it to its schematic symbol."""
    fp = pcbnew.FootprintLoad(str(FP / f"{lib}.pretty"), name)
    fp.SetFPID(pcbnew.LIB_ID(lib, name))
    fp.SetReference(ref)
    fp.SetValue(value)
    fp.SetPath(pcbnew.KIID_PATH(f"/{uuid.uuid5(uuid.UUID(ROOT), f'sym/{ref}')}"))
    fp.SetSheetname("/")
    fp.SetSheetfile("dsm-adapter.kicad_sch")
    board.Add(fp)
    fp.SetPosition(mm(x, y))
    fp.SetOrientationDegrees(angle)
    for pad in fp.Pads():
        n = pad.GetNumber()
        # The layout states its intended nets too, so a schematic change cannot reroute silently.
        if n in pad_nets:
            assert SCH.get((ref, n)) == pad_nets[n], f"{ref}.{n}: layout {pad_nets[n]}, schematic {SCH.get((ref, n))}"
        if (ref, n) in SCH:
            pad.SetNet(net(SCH[ref, n]))
    return fp


def track(points, net_name, width=0.4, layer=pcbnew.F_Cu):
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(mm(x1, y1))
        t.SetEnd(mm(x2, y2))
        t.SetWidth(pcbnew.FromMM(width))
        t.SetLayer(layer)
        t.SetNet(net(net_name))
        board.Add(t)


def text(s, x, y, size=1.0, angle=0):
    t = pcbnew.PCB_TEXT(board)
    t.SetText(s)
    t.SetPosition(mm(x, y))
    t.SetLayer(pcbnew.F_SilkS)
    t.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(size), pcbnew.FromMM(size)))
    t.SetTextThickness(pcbnew.FromMM(size * 0.15))
    t.SetTextAngleDegrees(angle)
    board.Add(t)


# Board outline.
corners = [(0, 0), (W, 0), (W, H), (0, H)]
for a, b in zip(corners, corners[1:] + corners[:1]):
    e = pcbnew.PCB_SHAPE(board)
    e.SetShape(pcbnew.SHAPE_T_SEGMENT)
    e.SetStart(mm(*a))
    e.SetEnd(mm(*b))
    e.SetLayer(pcbnew.Edge_Cuts)
    e.SetWidth(pcbnew.FromMM(0.1))
    board.Add(e)

# Nano: pad 1 (TX) at the top, USB at the bottom edge. D3, D4, D5 = pads 6, 7, 8.
NANO_X, NANO_Y = 30.0, 12.0
footprint("Module", "Arduino_Nano", "A1", "Arduino_Nano_v3.x", NANO_X, NANO_Y, 0,
          {"6": "/D3", "7": "/D4", "8": "/D5", "4": "GND", "29": "GND"})
pad_y = lambda n: NANO_Y + (n - 1) * 2.54

# Resistors at 180°: pad 1 is the right end, pad 2 is 10.16 mm to the left.
R = "R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal"
ROW_RX, ROW_TX, ROW_PD = 17.0, pad_y(7), 37.0
footprint("Resistor_THT", R, "R2", "10k", 25.16, ROW_RX, 180, {"1": "/D3", "2": "/N_RX"})
footprint("Resistor_THT", R, "R1", "10k", 12.16, ROW_RX, 180, {"1": "/N_RX", "2": "/LINE"})
footprint("Resistor_THT", R, "R4", "1k", 25.16, ROW_TX, 180, {"1": "/D4", "2": "/LINE"})
footprint("Resistor_THT", R, "R6", "1k", 25.16, ROW_PD, 180, {"1": "/D5", "2": "/N_PD"})
footprint("Resistor_THT", R, "R5", "1k", 12.16, ROW_PD, 180, {"1": "/N_PD", "2": "/LINE"})

# Screw terminal at 180°: the wire enters from the top edge. Pad 1 right (GND), pad 2 left (LINE).
J = "TerminalBlock_Phoenix_MKDS-1,5-2_1x02_P5.00mm_Horizontal"
j1 = footprint("TerminalBlock_Phoenix", J, "J1", "Car pin 12, pin 1", 16.0, 6.0, 180, {"1": "GND", "2": "/LINE"})
j1.Reference().SetPosition(mm(21.5, 6))

for i, (x, y) in enumerate([(3.5, 3.5), (3.5, 51.5), (44.5, 3.5)], 1):
    h = footprint("MountingHole", "MountingHole_3.2mm_M3", f"H{i}", "M3", x, y, 0, {})
    h.SetBoardOnly(True)
    h.Reference().SetVisible(False)

# Signals on the top layer.
track([(11, 6), (11, 11), (2, 11), (2, ROW_PD)], "/LINE", 0.6)
track([(15, ROW_TX), (2, ROW_TX)], "/LINE", 0.6)
track([(12.16, ROW_RX), (15, ROW_RX)], "/N_RX")
track([(12.16, ROW_PD), (15, ROW_PD)], "/N_PD")
track([(25.16, ROW_RX), (27.6, ROW_RX), (27.6, pad_y(6) - 2.4), (NANO_X, pad_y(6))], "/D3")
track([(25.16, ROW_TX), (NANO_X, ROW_TX)], "/D4")
track([(25.16, ROW_PD), (27.6, ROW_PD), (27.6, pad_y(8) + 2.4), (NANO_X, pad_y(8))], "/D5")

# Ground on the bottom layer: a track from the terminal to the Nano, and a pour.
track([(16, 6), (16, 9.5), (27.6, 9.5), (27.6, pad_y(4)), (NANO_X, pad_y(4))], "GND", 0.6, pcbnew.B_Cu)
zone = pcbnew.ZONE(board)
zone.SetLayer(pcbnew.B_Cu)
zone.SetNet(net("GND"))
zone.SetLocalClearance(pcbnew.FromMM(0.4))
zone.SetMinThickness(pcbnew.FromMM(0.25))
outline = zone.Outline()
outline.NewOutline()
for x, y in [(0.3, 0.3), (W - 0.3, 0.3), (W - 0.3, H - 0.3), (0.3, H - 0.3)]:
    outline.Append(mm(x, y))
board.Add(zone)
pcbnew.ZONE_FILLER(board).Fill(board.Zones())

# Silkscreen.
text("pin 1", 11, 12.9, 0.9)
text("pin 12", 16, 12.9, 0.9)
text("10k", 7.08, ROW_RX - 2.2)
text("10k", 20.08, ROW_RX - 2.2)
text("1k", 20.08, ROW_TX - 2.2)
text("1k", 7.08, ROW_PD - 2.2)
text("1k", 20.08, ROW_PD - 2.2)
text("dsm-diag E935 adapter", 13, 44.5, 1.2)
text("WIRING_INVERTED", 13, 46.8, 1.0)

pcbnew.SaveBoard(str(HERE / "dsm-adapter.kicad_pcb"), board)
print("wrote dsm-adapter.kicad_pcb")
