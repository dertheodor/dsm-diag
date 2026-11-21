"""Writes dsm-adapter.kicad_sch: the inverted (E935) wiring with an Arduino Nano.

The circuit is the one in docs/wiring.md#inverted-wiring-e935. Run with python3 -I.
"""
import re
import uuid
from pathlib import Path

LIB = Path("/usr/share/kicad/symbols")
OUT = Path(__file__).with_name("dsm-adapter.kicad_sch")
ROOT = "6f1c2a0e-5d3b-4c8e-9a71-2b4d8e0f1c35"
NS = uuid.UUID(ROOT)


def uid(*key):
    """Returns a stable UUID, so a rerun gives the same file."""
    return str(uuid.uuid5(NS, "/".join(map(str, key))))


def lib_block(lib, name):
    s = (LIB / f"{lib}.kicad_sym").read_text()
    i = s.index(f'\t(symbol "{name}"\n')
    depth = 0
    for j in range(i, len(s)):
        depth += {"(": 1, ")": -1}.get(s[j], 0)
        if depth == 0 and s[j] == ")":
            return s[i:j + 1]


def pins(block):
    """Returns {number: (x, y)} of the pin connection points in symbol units."""
    out = {}
    for m in re.finditer(r'\(pin \w+ \w+\s*\(at ([-\d.]+) ([-\d.]+) \d+\).*?\(number "([^"]*)"', block, re.S):
        out[m.group(3)] = (float(m.group(1)), float(m.group(2)))
    return out


# The library stores v3.x as an alias of v2.x; a schematic needs it flat.
nano = lib_block("MCU_Module", "Arduino_Nano_v2.x").replace("Arduino_Nano_v2.x", "Arduino_Nano_v3.x")
v3 = lib_block("MCU_Module", "Arduino_Nano_v3.x")
PROP = r'\t\t\(property "([^"]+)".*?\n\t\t\)\n'
v3_props = {m.group(1): m.group(0) for m in re.finditer(PROP, v3, re.S)}
nano = re.sub(PROP, lambda m: v3_props.get(m.group(1), m.group(0)), nano, flags=re.S)
SYMS = {
    "MCU_Module:Arduino_Nano_v3.x": nano,
    "Device:R": lib_block("Device", "R"),
    "Connector:Screw_Terminal_01x02": lib_block("Connector", "Screw_Terminal_01x02"),
    "power:GND": lib_block("power", "GND"),
    "power:PWR_FLAG": lib_block("power", "PWR_FLAG"),
}
PINS = {k: pins(v) for k, v in SYMS.items()}

FP_R = "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal"
FP_J = "TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-1,5-2_1x02_P5.00mm_Horizontal"

# (ref, lib_id, value, footprint, x, y, {pin: net}). None marks a no-connect pin.
NANO_NETS = {"6": "D3", "7": "D4", "8": "D5", "4": "GND", "29": "GND"}
PARTS = [
    ("A1", "MCU_Module:Arduino_Nano_v3.x", "Arduino_Nano_v3.x", "Module:Arduino_Nano", 152.4, 101.6,
     {n: NANO_NETS.get(n) for n in PINS["MCU_Module:Arduino_Nano_v3.x"]}),
    ("R2", "Device:R", "10k", FP_R, 101.6, 76.2, {"1": "D3", "2": "N_RX"}),
    ("R1", "Device:R", "10k", FP_R, 101.6, 96.52, {"1": "N_RX", "2": "LINE"}),
    ("R4", "Device:R", "1k", FP_R, 76.2, 76.2, {"1": "D4", "2": "LINE"}),
    ("R5", "Device:R", "2k", FP_R, 50.8, 76.2, {"1": "D5", "2": "LINE"}),
    ("J1", "Connector:Screw_Terminal_01x02", "Car pin 12, pin 1", FP_J, 63.5, 127.0, {"1": "GND", "2": "LINE"}),
    ("#FLG01", "power:PWR_FLAG", "PWR_FLAG", "", 152.4, 139.7, {"1": "GND"}),
]
FLAG_AT = (152.4, 139.7)


def font(justify=None, hide=False):
    j = f"\n\t\t\t\t(justify {justify})" if justify else ""
    h = "\n\t\t\t(hide yes)" if hide else ""
    return f"{h}\n\t\t\t(effects\n\t\t\t\t(font\n\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t){j}\n\t\t\t)"


def prop(name, value, x, y, hide=False):
    return f'\t\t(property "{name}" "{value}"\n\t\t\t(at {x:.2f} {y:.2f} 0){font(hide=hide)}\n\t\t)\n'


def symbol(ref, lib_id, value, fp, x, y):
    power = ref.startswith("#")
    s = (f'\t(symbol\n\t\t(lib_id "{lib_id}")\n\t\t(at {x:.2f} {y:.2f} 0)\n\t\t(unit 1)\n'
         f'\t\t(exclude_from_sim no)\n\t\t(in_bom {"no" if power else "yes"})\n\t\t(on_board {"no" if power else "yes"})\n'
         f'\t\t(dnp no)\n\t\t(uuid "{uid("sym", ref)}")\n')
    s += prop("Reference", ref, x + 2.54, y - 1.27, hide=power)
    s += prop("Value", value, x + 2.54, y + 1.27, hide=power)
    s += prop("Footprint", fp, x, y, hide=True)
    s += prop("Datasheet", "", x, y, hide=True)
    for n in PINS[lib_id]:
        s += f'\t\t(pin "{n}"\n\t\t\t(uuid "{uid("pin", ref, n)}")\n\t\t)\n'
    s += (f'\t\t(instances\n\t\t\t(project "dsm-adapter"\n\t\t\t\t(path "/{ROOT}"\n'
          f'\t\t\t\t\t(reference "{ref}")\n\t\t\t\t\t(unit 1)\n\t\t\t\t)\n\t\t\t)\n\t\t)\n\t)\n')
    return s


def pin_point(lib_id, x, y, n):
    px, py = PINS[lib_id][n]
    return round(x + px, 2), round(y - py, 2)


body = []
gnd = []
for ref, lib_id, value, fp, x, y, nets in PARTS:
    body.append(symbol(ref, lib_id, value, fp, x, y))
    for n, net in nets.items():
        px, py = pin_point(lib_id, x, y, n)
        if net is None:
            body.append(f'\t(no_connect\n\t\t(at {px:.2f} {py:.2f})\n\t\t(uuid "{uid("nc", ref, n)}")\n\t)\n')
            continue
        if ref.startswith("#"):
            continue
        if net == "GND":
            gnd.append((px, py))
            continue
        # Label angle: point away from the symbol body.
        sx, sy = PINS[lib_id][n]
        if abs(sx) >= abs(sy):
            angle, just = (180, "right bottom") if sx < 0 else (0, "left bottom")
        else:
            angle, just = (90, "left bottom") if sy > 0 else (270, "right bottom")
        body.append(f'\t(label "{net}"\n\t\t(at {px:.2f} {py:.2f} {angle}){font(just)}\n\t\t(uuid "{uid("lbl", ref, n)}")\n\t)\n')
# A GND symbol on every GND pin, and one under the flag.
for i, (x, y) in enumerate(gnd + [FLAG_AT], 1):
    body.append(symbol(f"#PWR0{i}", "power:GND", "GND", "", x, y))


def lib_symbol(lib_id, block):
    name = lib_id.split(":")[1]
    return block.replace(f'(symbol "{name}"', f'(symbol "{lib_id}"', 1)


text = (f'(kicad_sch\n\t(version 20250610)\n\t(generator "dsm-diag")\n\t(generator_version "9.99")\n'
        f'\t(uuid "{ROOT}")\n\t(paper "A4")\n\t(title_block\n\t\t(title "dsm-diag Nano adapter, inverted line (E935)")\n'
        f'\t\t(comment 1 "Circuit: docs/wiring.md#inverted-wiring-e935. Firmware: dsm_bridge.ino with WIRING_INVERTED.")\n\t)\n'
        '\t(lib_symbols\n' + "\n".join("\t" + lib_symbol(k, v).replace("\n", "\n\t") for k, v in SYMS.items()) + '\n\t)\n'
        + "".join(body)
        + f'\t(sheet_instances\n\t\t(path "/"\n\t\t\t(page "1")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n')
OUT.write_text(text)
print(f"wrote {OUT.name}")
