# Ragdoll playground + fly brain

A People Playground–style ragdoll sandbox (black and white, gore, healing, immortality) where a person can be given a **real fruit fly brain**: all 139,255 neurons and about 2.7 million connections of the FlyWire dataset, running in the browser. A person with a brain feels pain, smells, tastes, sees things flying at them and senses being lifted; the brain responds, and its response drives the body.

## Running it

Easiest: double-click **`Play.bat`**. It starts a small web server (a minimised window on the taskbar; close it to stop) and opens the game in your browser.

The brain is loaded with `fetch` and runs in a Web Worker, so the page has to come from a web server, not straight from the file. To do it by hand, run this in the folder:

```
python tools/serve.py
```

then open `http://localhost:8000/`. (Opening `index.html` directly still plays, you just can't attach a brain.)

## Playing

Drag to lift; swing and let go to throw.

**Right-click** (press and hold on touch) for the menu: add people, place food (banana, apple, bitter pill) and mould (a danger smell), attach or remove a fly brain (up to 2 people), view the brain, view the **3D fly brain model**, heal, keep healing, immortal. When a body heals, every piece that was torn off melts into a clot of blood, flies back to the biggest part of the body, reappears there as a small, lumpy limb, swells out to size, and its skin fades from red back to normal.

The **Items** button opens the items panel (sword, knife, axe, hammer, baseball bat, spear, iron block, iron beam, bomb, press). Drag one onto the field and let go; while you drag it out of the panel it collides with nothing, and becomes solid once dropped. Hold **A / D** to turn what you're holding anticlockwise / clockwise about the point you hold it by.

- **Blades** swept fast enough cut through flesh, bone and joints.
- **Points** driven in hard enough go into the body and through it, threading on each part they pass through (a knife one part, a sword about three, a spear more) and staying stuck. The body can only slide along the blade; a harder thrust goes deeper and can come out the back. Pulling along the blade drags the body along and then draws it out; wrenching it sideways too hard tears it free.
- **Blunt** things bruise, dent and knock out.
- **Iron blocks and beams** are heavy, stack, and crush people.
- **Bombs** go off 3 seconds after being dropped (right-click: detonate now), throwing people and things outward, breaking, bruising and scorching bodies, knocking them out, and setting off other bombs nearby.
- **The press** stands on the floor and keeps bringing its plate down to crush whoever is under it, then lifts it again (right-click: switch off/on); anything solid stops it.

## Files

| File | What it is |
|---|---|
| `index.html` | The page, the menus and panels |
| `js/game.js` | Body physics (particle lattices, joints, dents, gore, healing), items, movement (postures, walking, turning, hopping away), senses, reflexes, choosing behaviour, drawing |
| `js/brain.js` | The `FlyBrain` class: loads the brain, one worker per brain, sends stimuli, reads activity |
| `js/brain-worker.js` | Leaky integrate-and-fire simulation over every connection, and learning in the mushroom body |
| `js/brain3d.js` | The 3D model: each neuron a dot where it sits in the real brain, coloured by brain part; firing neurons turn red (uses three.js) |
| `data/brain.bin.gz`, `data/brain.b64.*.txt`, `data/brain_meta.json` | The built brain (made by `tools/build_brain.py`; the `.b64` parts are the same bytes as text, for hosts that don't serve `.gz`) |
| `data/brain_points.b64.txt`, `data/brain_groups.b64.txt` | 3D position (FlyWire anchor point) and group of every neuron, for the 3D model |
| `tools/build_brain.py` | Builds the brain from the FlyWire data in `../flybrain/data` and the annotation table `data/flywire_annotations.tsv` |
| `tools/serve.py` | The local web server `Play.bat` starts (tells the browser not to keep old copies, so updates show on reload) |
| `tools/brain-lab.html` | A test page for measuring the brain's responses (development only) |
| `Play.bat` | Starts the server and opens the game |

### Bodies

Each body part is a lattice of about 15–24 small particles stuck together. The middle is bone (tough), the outside flesh (brittle), and each part is split at random into lumps of about five particles. Hit hard, the seams between lumps crack, cracks spread, and the part breaks into pieces; each piece keeps its own shape and collides as a thing of its own. A bone with a little flesh chipped off still works; a bone broken in two stops the joints on it working.

## How the brain is built

- **Data:** FlyWire FAFB v783 connectivity from the FlyBrain project; neurons are grouped by their **real cell type names** in the FlyWire annotations (Schlegel et al. 2024): Giant Fiber (DNp01), MDN, DNa01/02, DNp09, LC4/LPLC2, PPL1, PAM, MBONs, Kenyon cells, odour receptors and projection neurons by glomerulus, and so on.
- **Neuron model** after the whole-brain model of Shiu et al. (Nature 2024): each synapse is worth about 1% of threshold; acetylcholine excites, GABA and **glutamate inhibit** (FlyBrain treats glutamate as excitatory, which sets the whole brain alight). Spike-frequency adaptation makes activity die down.
- **Dopamine** doesn't carry fast signals; it changes synapse strength. **Learning in the mushroom body:** when PPL1 (punishment) fires, the synapses from the Kenyon cells the current smell is driving (above their background) onto approach MBONs weaken; PAM (reward) weakens the avoidance side. What the brain remembers about a smell is read off the Kenyon cells specific to that smell.

Responses measured in the model that match real flies: sweet taste drives the feeding motor neurons; wind/gravity drives the Giant Fiber; pain signals from the body drive PPL1, octopamine and MDN (walking backwards); being hit while smelling something makes the fly avoid that smell afterwards (and, partly, similar smells).

## What is rules, not neurons

To be clear about it:

- The data covers only the brain, **not the nerve cord (VNC)**, so there are no leg or arm motor neurons. Instant reflexes (flinching, hopping away) and turning the brain's commands into human movement (walking, running, cowering, bending down to eat, rubbing a sore spot) are code in `game.js`.
- **Fear**, **hunger** and **fatigue** are state variables; they are fed into the brain (octopamine, neuroendocrine cells) but are themselves rules.
- When hit, the reflex layer injects directly into PPL1 and the Giant Fiber (the real pain pathway runs through the VNC). Eating something sweet injects into PAM, because this simple model doesn't connect sweet taste to PAM by itself.
- The direction to go (toward food, away from a threat) is chosen by the behaviour layer; the brain decides whether to walk, run, back up, freeze, eat or avoid.

## Sources

- Dorkenwald, S. et al. *Neuronal wiring diagram of an adult brain.* Nature 634 (2024) — the FlyWire data.
- Schlegel, P. et al. *Whole-brain annotation and multi-connectome cell typing of Drosophila.* Nature 634 (2024) — the cell type annotations (github.com/flyconnectome/flywire_annotations).
- Shiu, P. K. et al. *A Drosophila computational brain model reveals sensorimotor processing.* Nature 634 (2024) — neuron model parameters.
- Aso, Y. et al. (2014) on MBON/dopamine roles; Stensmyr et al. (2012) geosmin → DA2; Suh et al. (2004) CO2 → V; Card & Dickinson (2008), Zacarias et al. (2018), Gibson et al. (2015) on escape, freezing and fear-like states.
- The FlyBrain project (MIT) — the original worker simulation and the downloaded data.

## License

The code is under the MIT License (see `LICENSE`). The brain data in `data/` is built from the FlyWire connectome and its cell type annotations, and stays under their own terms: credit FlyWire (Dorkenwald et al. 2024; Schlegel et al. 2024) when you use or share it. `data/flywire_annotations.tsv` isn't included; `tools/build_brain.py` says where to get it.
