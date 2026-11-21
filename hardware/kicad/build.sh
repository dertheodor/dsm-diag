#!/usr/bin/env bash
# Regenerates the schematic and the board, checks both, and writes the fabrication files to out/.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out

python3 -I generate_sch.py
python3 generate_pcb.py

kicad-cli sch erc --exit-code-violations -o out/erc.rpt dsm-adapter.kicad_sch
kicad-cli pcb drc --exit-code-violations --schematic-parity --refill-zones -o out/drc.rpt dsm-adapter.kicad_pcb

rm -rf out/gerbers && mkdir out/gerbers
kicad-cli pcb export gerbers -l F.Cu,B.Cu,F.Mask,B.Mask,F.Silkscreen,B.Silkscreen,Edge.Cuts -o out/gerbers/ dsm-adapter.kicad_pcb
kicad-cli pcb export drill --format excellon -o out/gerbers/ dsm-adapter.kicad_pcb
(cd out/gerbers && zip -q -r ../dsm-adapter-gerbers.zip .)

kicad-cli sch export pdf -o out/dsm-adapter-schematic.pdf dsm-adapter.kicad_sch
kicad-cli pcb render --side top -w 1200 --height 1200 -o dsm-adapter-top.png dsm-adapter.kicad_pcb
kicad-cli pcb render --side bottom -w 1200 --height 1200 -o out/dsm-adapter-bottom.png dsm-adapter.kicad_pcb
echo "OK: out/dsm-adapter-gerbers.zip"
