"""Build the fly brain used by the ragdoll playground.

Uses every neuron and connection of the FlyWire FAFB v783 connectome shipped with
FlyBrain (flybrain/data/*.csv.gz) and labels neurons into groups the ragdoll can drive
and read, using the FlyWire cell type annotations (Schlegel et al., Nature 2024;
data/flywire_annotations.tsv).

Edges are re-aggregated here rather than taken from FlyBrain's binary, because that
build counted glutamate as excitatory. In the fly brain glutamate mostly inhibits
(through GluCl channels), and the whole-brain LIF model of Shiu et al. (Nature 2024)
treats both GABA and glutamate as inhibitory; with glutamate excitatory the network
runs away into brain-wide firing.

Neuron index i is the i-th row of flybrain/data/neurons.csv.gz.

The annotation table isn't in the repository: download Supplemental_file1_neuron_annotations.tsv
from github.com/flyconnectome/flywire_annotations and save it as data/flywire_annotations.tsv.

Outputs:
  data/brain.bin.gz     header + edges (pre, post, signed synapse count) + (uint8 region, uint16 group) per neuron
  data/brain_meta.json  groups, and named neuron index sets (odour receptor glomeruli)

Usage: python tools/build_brain.py [--flybrain ../flybrain]
"""
import argparse
import csv
import gzip
import json
import struct
import sys
from collections import Counter
from pathlib import Path

REGIONS = {"sensory": 0, "central": 1, "drives": 2, "motor": 3}

# Fast synaptic sign per transmitter. Dopamine carries no fast signal: in the mushroom body
# it changes how strong Kenyon cell -> MBON synapses are (done by the learning rule in the
# worker) rather than firing its targets. Counted as excitatory, a burst of punishment
# dopamine set off Kenyon cells all over and the fly learned to fear every smell at once.
# Serotonin and octopamine stay excitatory, as in FlyBrain.
NT_SIGN = {"ACH": 1.0, "GABA": -1.0, "GLUT": -1.0, "DA": 0.0, "SER": 1.0, "OCT": 1.0, "OA": 1.0}

# name, region, Vietnamese label shown in the brain panel
GROUPS = [
    ("VIS_PHOTO", "sensory", "Photoreceptors"),
    ("VIS_OPTIC", "sensory", "Optic lobe"),
    ("VIS_LOOM", "sensory", "Looming detectors (LC4, LPLC2)"),
    ("VIS_PROJ", "sensory", "Other visual projection"),
    ("OLF_ORN", "sensory", "Odour receptors (ORN)"),
    ("OLF_PN", "sensory", "Olfactory projection neurons (PN)"),
    ("OLF_LN", "sensory", "Olfactory local neurons (LN)"),
    ("MECH_BRISTLE", "sensory", "Head bristles"),
    ("MECH_JO", "sensory", "Wind / gravity (Johnston's organ)"),
    ("GUS_SWEET", "sensory", "Sweet / water taste"),
    ("GUS_BITTER", "sensory", "Bitter taste"),
    ("GUS_OTHER", "sensory", "Other taste"),
    ("THERMO", "sensory", "Heat / humidity"),
    ("SENS_OTHER", "sensory", "Other senses"),
    ("ASC", "sensory", "Signals from the body (ascending)"),
    ("KC", "central", "Kenyon cells (mushroom body)"),
    ("MBON_AP", "central", "Approach MBONs (ACh / GABA)"),
    ("MBON_AV", "central", "Avoidance MBONs (glutamate)"),
    ("DAN_PPL1", "central", "PPL1 dopamine (punishment)"),
    ("DAN_PAM", "central", "PAM dopamine (reward)"),
    ("DAN_OTHER", "central", "Other dopamine"),
    ("LH", "central", "Lateral horn (innate smell)"),
    ("CX", "central", "Central complex (heading)"),
    ("OA", "central", "Octopamine (arousal)"),
    ("CENTRAL_OTHER", "central", "Other central brain"),
    ("HUNGER", "drives", "Hormonal: hunger (pars intercerebralis)"),
    ("FATIGUE", "drives", "Hormonal: fatigue (pars lateralis)"),
    ("ENDO_OTHER", "drives", "Other neuroendocrine"),
    ("DN_GF", "motor", "Giant Fiber (escape)"),
    ("DN_MDN", "motor", "MDN (walk backwards)"),
    ("DN_TURN_L", "motor", "Turn left (DNa01/02)"),
    ("DN_TURN_R", "motor", "Turn right (DNa01/02)"),
    ("DN_P09", "motor", "DNp09 (freeze)"),
    ("DN_OTHER", "motor", "Other descending neurons"),
    ("MN_FEED", "motor", "Feeding motor (proboscis, swallowing)"),
    ("MN_HEAD", "motor", "Head and neck motor"),
    ("MN_OTHER", "motor", "Other motor"),
]
GID = {name: i for i, (name, _, _) in enumerate(GROUPS)}


def group_of(a):
    """Pick the group for one annotation row (dict) — most specific rule first."""
    sc, cc, sub, ct, nt, side = (a.get(k, "") for k in
                                 ("super_class", "cell_class", "cell_sub_class", "cell_type", "top_nt", "side"))
    # descending commands
    if ct == "DNp01":
        return "DN_GF"
    if ct == "MDN":
        return "DN_MDN"
    if ct in ("DNa01", "DNa02"):
        return "DN_TURN_L" if side == "left" else "DN_TURN_R"
    if ct == "DNp09":
        return "DN_P09"
    if sc == "descending":
        return "DN_OTHER"
    # vision
    if ct in ("LC4", "LPLC2"):
        return "VIS_LOOM"
    if cc in ("visual", "ocellar"):
        return "VIS_PHOTO"
    if sc == "optic":
        return "VIS_OPTIC"
    if sc in ("visual_projection", "visual_centrifugal"):
        return "VIS_PROJ"
    # smell
    if cc == "olfactory":
        return "OLF_ORN"
    if cc in ("ALPN", "ALON"):
        return "OLF_PN"
    if cc in ("ALLN", "ALIN"):
        return "OLF_LN"
    # touch, wind, taste, temperature
    if cc == "mechanosensory":
        return "MECH_JO" if sub in ("wind_gravity", "auditory") else "MECH_BRISTLE"
    if cc == "gustatory":
        if sub in ("sugar/water", "low-salt"):
            return "GUS_SWEET"
        if sub == "bitter":
            return "GUS_BITTER"
        return "GUS_OTHER"
    if cc in ("thermosensory", "hygrosensory"):
        return "THERMO"
    if sc in ("ascending", "sensory_ascending"):
        return "ASC"
    if sc == "sensory":
        return "SENS_OTHER"
    # mushroom body
    if cc == "Kenyon_Cell":
        return "KC"
    if cc == "MBON":
        # Aso et al. 2014: glutamatergic MBONs drive avoidance, cholinergic and GABAergic approach
        return "MBON_AV" if nt == "glutamate" else "MBON_AP"
    if ct.startswith("PPL1"):
        return "DAN_PPL1"
    if ct.startswith("PAM"):
        return "DAN_PAM"
    if cc == "DAN":
        return "DAN_OTHER"
    if cc in ("LHLN", "LHCENT"):
        return "LH"
    if cc in ("CX", "TuBu"):
        return "CX"
    # drives
    if cc == "pars_intercerebralis":
        return "HUNGER"
    if cc == "pars_lateralis":
        return "FATIGUE"
    if sc == "endocrine":
        return "ENDO_OTHER"
    # brain motor neurons
    if sc == "motor":
        if any(k in sub for k in ("proboscis", "ingestion", "haustellum", "salivary", "crop")):
            return "MN_FEED"
        if any(k in sub for k in ("neck", "eye", "antennal")):
            return "MN_HEAD"
        return "MN_OTHER"
    if nt == "octopamine":
        return "OA"
    return "CENTRAL_OTHER"


def main():
    here = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--flybrain", type=Path, default=here.parent / "flybrain")
    args = ap.parse_args()
    fb = args.flybrain / "data"

    with gzip.open(fb / "neurons.csv.gz", "rt", encoding="utf-8") as f:
        root_ids = [row["root_id"] for row in csv.DictReader(f)]
    with open(here / "data" / "flywire_annotations.tsv", encoding="utf-8") as f:
        ann = {row["root_id"]: row for row in csv.DictReader(f, delimiter="\t")}

    groups, sets = [], {}
    missing = 0
    for i, rid in enumerate(root_ids):
        a = ann.get(rid)
        if a is None:
            missing += 1
            groups.append(GID["CENTRAL_OTHER"])
            continue
        groups.append(GID[group_of(a)])
        ct = a.get("cell_type", "")
        if ct.startswith("ORN_"):
            sets.setdefault(ct, []).append(i)
        # uniglomerular projection neurons, e.g. DM1_lPN -> PN_DM1
        if a.get("cell_class") == "ALPN" and "_" in ct and ct.endswith("PN") and "+" not in ct:
            glom = ct.split("_")[0]
            if glom and glom != "M":
                sets.setdefault("PN_" + glom, []).append(i)

    index = {rid: i for i, rid in enumerate(root_ids)}
    sums = {}
    with gzip.open(fb / "connections.csv.gz", "rt", encoding="utf-8") as f:
        next(f)
        for line in f:
            pre_s, post_s, _np, syn, nt = line.rstrip().split(",")
            a, b = index.get(pre_s), index.get(post_s)
            if a is None or b is None:
                continue
            k = a * 200000 + b
            sums[k] = sums.get(k, 0.0) + int(syn) * NT_SIGN.get(nt, 1.0)
    edges = sorted(k for k, w in sums.items() if w != 0.0)
    n, e = len(root_ids), len(edges)

    out = here / "data"
    with gzip.open(out / "brain.bin.gz", "wb", compresslevel=6) as f:
        f.write(struct.pack("<II", n, e))
        buf = bytearray()
        for k in edges:
            buf += struct.pack("<IIf", k // 200000, k % 200000, sums[k])
            if len(buf) > 1 << 22:
                f.write(buf); buf = bytearray()
        f.write(buf)
        meta_block = bytearray()
        for g in groups:
            meta_block += struct.pack("<BH", REGIONS[GROUPS[g][1]], g)
        f.write(meta_block)

    # The same bytes as base64 text in parts under 16 MB, for hosts that only serve text and
    # common media types (the page falls back to these when brain.bin.gz can't be fetched).
    import base64
    blob = base64.b64encode((out / "brain.bin.gz").read_bytes())
    part = 9_000_000
    for old in out.glob("brain.b64.*.txt"):
        old.unlink()
    for n in range(0, len(blob), part):
        (out / f"brain.b64.{n // part}.txt").write_bytes(blob[n:n + part])

    # Where each neuron sits in the brain, for the 3D view: the FlyWire anchor point on the
    # neuron's backbone (voxels of 4 x 4 x 40 nm), centred and packed as int16 x, y, z in
    # neuron order (missing = -32768), then base64.
    pts = []
    for rid in root_ids:
        a = ann.get(rid)
        try:
            pts.append((float(a["pos_x"]) * 4, float(a["pos_y"]) * 4, float(a["pos_z"]) * 40))
        except (TypeError, ValueError, KeyError):
            pts.append(None)
    have = [p for p in pts if p]
    lo = [min(p[k] for p in have) for k in range(3)]
    hi = [max(p[k] for p in have) for k in range(3)]
    center = [(lo[k] + hi[k]) / 2 for k in range(3)]
    unit = max(hi[k] - lo[k] for k in range(3)) / 2 / 32000      # nm per stored unit
    packed = bytearray()
    for p in pts:
        packed += struct.pack("<hhh", *((round((p[k] - center[k]) / unit) for k in range(3)) if p else (-32768,) * 3))
    (out / "brain_points.b64.txt").write_bytes(base64.b64encode(bytes(packed)))
    # and the group of each neuron (one byte each), so the view can colour brain parts
    (out / "brain_groups.b64.txt").write_bytes(base64.b64encode(bytes(groups)))

    counts = Counter(groups)
    meta = {
        "neuron_count": n,
        "edge_count": e,
        "source": "FlyWire FAFB v783 via FlyBrain; groups from FlyWire cell type annotations (Schlegel et al. 2024)",
        "groups": [{"id": i, "name": name, "region": region, "label": label, "size": counts.get(i, 0)}
                   for i, (name, region, label) in enumerate(GROUPS)],
        "sets": {k: v for k, v in sorted(sets.items())},
        "points": {"file": "brain_points.b64.txt", "groups": "brain_groups.b64.txt", "nm_per_unit": unit, "center_nm": center},
    }
    with open(out / "brain_meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))

    print(f"{n} neurons, {e} edges, {missing} without annotation")
    for i, (name, region, _) in enumerate(GROUPS):
        print(f"  {name:14s} {region:8s} {counts.get(i, 0)}")
    print(f"{len(sets)} odour sets (receptors and projection neurons); wrote {out / 'brain.bin.gz'} "
          f"({(out / 'brain.bin.gz').stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
