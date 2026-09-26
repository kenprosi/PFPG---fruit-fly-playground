/* Fly brain worker for the ragdoll playground.
 *
 * Leaky integrate-and-fire over the whole FlyWire connectome (139,255 neurons,
 * 2.7M connections), adapted from FlyBrain's sim-worker.js: neurons are sorted by
 * group so only groups that are receiving input are ticked ("neuropil gating").
 *
 * Added here: learning in the mushroom body. Kenyon cells that fired recently keep a
 * fading eligibility trace. When punishment dopamine neurons (PPL1) fire, the
 * connections from those Kenyon cells onto approach MBONs weaken; when reward
 * dopamine neurons (PAM) fire, their connections onto avoidance MBONs weaken. That is
 * the textbook model of how a fly learns to avoid (or seek) a smell it met together
 * with pain (or food). Weakened connections drift back slowly, so memories fade.
 *
 * Binary: header (uint32 neurons, uint32 edges), edges (uint32 pre, uint32 post,
 * float32 weight) sorted by pre, then per neuron (uint8 region, uint16 group).
 *
 * Main -> worker: init {buffer, groups: {name: id}, sets: {name: [neuron index in file order]}},
 *                 start, stop, setStim {items}, pulse {items}, setParams {...}, reset
 *   items = [[name, intensity], ...] where name is a group name or a set name; the
 *   worker resolves names itself because it keeps neurons in its own (sorted) order.
 * Worker -> main: ready {neurons, edges, groupSizes}, tick {counts, memory}, error
 */
'use strict';

var LEAK = 0.95, THRESHOLD = 1.0, REFRACTORY = 3;
// Each synapse adds a fixed share of the firing threshold, after the whole-brain LIF model
// of Shiu et al. (Nature 2024) built on this same FlyWire data: 0.275 mV per synapse through
// a 5 ms synaptic current into a 20 ms membrane is ~0.07 mV, about 1% of the 7 mV gap to
// threshold. (A larger value makes the whole brain fire at once.)
var SYN_WEIGHT = 0.01;
var TICK_RATE = 20, COOLDOWN = 20;   // ticks per second of game time
// Spike-frequency adaptation: each spike raises that neuron's threshold a little and the rise
// fades over ~50 ticks (2.5 s). Real neurons do this; without it recurrent loops (the olfactory /
// lateral horn / PPL1 loop especially) keep firing forever once anything starts them.
var ADAPT_STEP = 0.25, ADAPT_DECAY = 0.98;
// Receptor neurons and Kenyon cells adapt only lightly, so the same smell keeps producing the
// same Kenyon cell code each time it comes back; strong adaptation there wiped the code out.
// Second-order neurons (projection, local, lateral horn...) keep full adaptation, or the
// olfactory loop keeps ringing after the smell is gone.
var ADAPT_STEP_SENSORY = 0.03;
var KC_KC = false;           // let Kenyon cell -> Kenyon cell synapses fire (off, see buildPlasticity)
var LIGHT_ADAPT = ['OLF_ORN', 'KC', 'MECH_BRISTLE', 'MECH_JO', 'GUS_SWEET', 'GUS_BITTER', 'GUS_OTHER',
	'THERMO', 'VIS_PHOTO', 'SENS_OTHER', 'ASC'];
var adaptStep = null;        // per group
// learning
var TRACE_RATE = 0.1;        // per tick: eligibility is a Kenyon cell's firing averaged over ~10 ticks (0.5 s)
var ELIGIBLE = 0.06;         // how far above its background a Kenyon cell must fire to count as part of the current smell;
                             // high enough that a smell from a few seconds ago no longer counts
var LEARN_RATE = 0.6;        // fraction a fully eligible synapse weakens per dopamine tick
var DOPA_THRESHOLD = 0.3;    // fraction of the dopamine group firing in one tick needed to teach;
                             // smells alone reach ~0.25 of PPL1, a real hit (pain pulse) far more
var MIN_WEIGHT = 0.05;       // a weakened synapse keeps at least this fraction of its strength
var RECOVERY = 0.0008;       // per tick drift back to full strength (~2 min to fade)

var THR_SCALE = {};          // group name -> threshold multiplier (Kenyon cells need coincident input)
var thr = null;              // per-group threshold
var N = 0, E = 0, V, A, fired, refr, rowPtr, colIdx, W, groupId, numGroups = 0, gOff;
var gActive, gCool, gRecv, gFired, gStim;
var stimIdx = null, stimVal = null, running = false;
var G = {};                   // group name -> id
var SETS = {};                // set name -> Uint32Array of sorted neuron indices
var kcStart = 0, kcEnd = 0, trace, background;
// background: each Kenyon cell's usual firing when nothing in particular is being smelled.
// Recurrent loops keep some of them flickering all the time; a cell only counts as part of the
// current smell (and can learn) when the smell drives it well above that.
// Eligibility is a slow average: a smell keeps its Kenyon cells firing for seconds, while the
// pain of a hit only flickers some others briefly. Only the sustained ones learn, so a smell
// present when it hurt gets the blame, not every Kenyon cell the jolt happened to set off.
var plastic = null, plasticBase = null, plasticPre = null, plasticKind = null; // kind 0 = approach, 1 = avoid
// Each smell's fingerprint: how often each Kenyon cell has been part of it. The code a smell
// evokes wobbles from one sniff to the next, so memory about a smell is read over its whole
// fingerprint rather than over whichever Kenyon cells happen to be firing this instant.
var context = null, fingerprints = {}, odorMemory = {}, tickCount = 0;

async function gunzip(buffer) {
	var ds = new DecompressionStream('gzip');
	var w = ds.writable.getWriter(); w.write(new Uint8Array(buffer)); w.close();
	var r = ds.readable.getReader(), parts = [], len = 0;
	for (;;) { var c = await r.read(); if (c.done) break; parts.push(c.value); len += c.value.byteLength; }
	var out = new Uint8Array(len), o = 0;
	for (var i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].byteLength; }
	return out.buffer;
}

function parse(buffer) {
	var dv = new DataView(buffer);
	N = dv.getUint32(0, true); E = dv.getUint32(4, true);
	var meta = 8 + E * 12;
	// weights in the file are signed synapse counts (inhibitory transmitters negative)
	var pre = new Uint32Array(E), post = new Uint32Array(E), w = new Float32Array(E);
	for (var e = 0; e < E; e++) {
		var b = 8 + e * 12;
		pre[e] = dv.getUint32(b, true); post[e] = dv.getUint32(b + 4, true);
		w[e] = dv.getFloat32(b + 8, true);
	}
	var gid = new Uint16Array(N), region = new Uint8Array(N);
	for (var i = 0; i < N; i++) {
		region[i] = dv.getUint8(meta + i * 3);
		gid[i] = dv.getUint16(meta + i * 3 + 1, true); if (gid[i] >= numGroups) numGroups = gid[i] + 1;
	}
	var groupRegion = new Uint8Array(numGroups);
	for (i = 0; i < N; i++) groupRegion[gid[i]] = region[i];

	// sort neurons by group so each group is one contiguous range
	var counts = new Uint32Array(numGroups);
	for (i = 0; i < N; i++) counts[gid[i]]++;
	gOff = new Uint32Array(numGroups + 1);
	for (var g = 0; g < numGroups; g++) gOff[g + 1] = gOff[g] + counts[g];
	var toSorted = new Uint32Array(N), wp = gOff.slice(0, numGroups);
	for (i = 0; i < N; i++) toSorted[i] = wp[gid[i]]++;
	groupId = new Uint16Array(N);
	for (i = 0; i < N; i++) groupId[toSorted[i]] = gid[i];

	// CSR in sorted order
	rowPtr = new Uint32Array(N + 1);
	for (e = 0; e < E; e++) rowPtr[toSorted[pre[e]] + 1]++;
	for (i = 0; i < N; i++) rowPtr[i + 1] += rowPtr[i];
	var fill = rowPtr.slice(0, N);
	colIdx = new Uint32Array(E); W = new Float32Array(E);
	for (e = 0; e < E; e++) {
		var s = toSorted[pre[e]], k = fill[s]++;
		colIdx[k] = toSorted[post[e]];
		W[k] = w[e] * SYN_WEIGHT;
	}
	V = new Float32Array(N); A = new Float32Array(N); fired = new Uint8Array(N); refr = new Uint8Array(N);
	gActive = new Uint8Array(numGroups); gCool = new Uint8Array(numGroups);
	gRecv = new Uint8Array(numGroups); gFired = new Uint8Array(numGroups); gStim = new Uint8Array(numGroups);
	adaptStep = new Float32Array(numGroups);
	adaptStep.fill(ADAPT_STEP);
	for (var ln = 0; ln < LIGHT_ADAPT.length; ln++) if (G[LIGHT_ADAPT[ln]] < numGroups) adaptStep[G[LIGHT_ADAPT[ln]]] = ADAPT_STEP_SENSORY;
	return toSorted;
}

// find every Kenyon cell -> MBON connection; these are the ones that learn
function buildPlasticity() {
	kcStart = gOff[G.KC]; kcEnd = gOff[G.KC + 1];
	// Kenyon cells also synapse onto each other along their axons. Whatever those synapses do
	// in the fly, as plain excitation here they make the whole Kenyon cell population ring on
	// long after a smell is gone, blurring one smell into the next, so they carry no spikes.
	if (!KC_KC) for (var a = kcStart; a < kcEnd; a++)
		for (var e2 = rowPtr[a]; e2 < rowPtr[a + 1]; e2++) if (colIdx[e2] >= kcStart && colIdx[e2] < kcEnd) W[e2] = 0;
	trace = new Float32Array(kcEnd - kcStart); background = new Float32Array(kcEnd - kcStart);
	var list = [], pres = [], kinds = [];
	for (var i = kcStart; i < kcEnd; i++) {
		for (var j = rowPtr[i]; j < rowPtr[i + 1]; j++) {
			var tg = groupId[colIdx[j]];
			if (tg === G.MBON_AP || tg === G.MBON_AV) { list.push(j); pres.push(i - kcStart); kinds.push(tg === G.MBON_AV ? 1 : 0); }
		}
	}
	plastic = Uint32Array.from(list);
	plasticPre = Uint32Array.from(pres);
	plasticKind = Uint8Array.from(kinds);
	plasticBase = new Float32Array(plastic.length);
	for (var p = 0; p < plastic.length; p++) plasticBase[p] = W[plastic[p]];
}

// [[name, intensity], ...] -> flat neuron indices and intensities
function resolve(items) {
	var idx = [], val = [];
	for (var n = 0; n < (items || []).length; n++) {
		var name = items[n][0], v = items[n][1];
		if (!v) continue;
		if (SETS[name]) { var s = SETS[name]; for (var q = 0; q < s.length; q++) { idx.push(s[q]); val.push(v); } }
		else if (G[name] !== undefined && G[name] < numGroups) {
			for (var i = gOff[G[name]]; i < gOff[G[name] + 1]; i++) { idx.push(i); val.push(v); }
		}
	}
	return { idx: Uint32Array.from(idx), val: Float32Array.from(val) };
}

function wake(g) { if (!gActive[g]) { gActive[g] = 1; gCool[g] = COOLDOWN; } }

function tick() {
	var t0 = performance.now();
	var spikes = new Uint16Array(numGroups);
	gRecv.fill(0); gFired.fill(0); gStim.fill(0);

	if (stimIdx) for (var k = 0; k < stimIdx.length; k++) { var g0 = groupId[stimIdx[k]]; gStim[g0] = 1; wake(g0); }

	var g, i, j;
	for (g = 0; g < numGroups; g++) {
		if (!gActive[g]) continue;
		for (i = gOff[g]; i < gOff[g + 1]; i++) {
			if (refr[i] > 0) { refr[i]--; V[i] = 0; } else V[i] *= LEAK;
			A[i] *= ADAPT_DECAY;
		}
	}
	if (stimIdx) for (k = 0; k < stimIdx.length; k++) { var si = stimIdx[k]; if (refr[si] === 0) V[si] += stimVal[k]; }

	for (g = 0; g < numGroups; g++) {
		if (!gActive[g]) continue;
		for (i = gOff[g]; i < gOff[g + 1]; i++) {
			if (!fired[i]) continue;
			for (j = rowPtr[i]; j < rowPtr[i + 1]; j++) { var t = colIdx[j]; V[t] += W[j]; gRecv[groupId[t]] = 1; }
		}
	}
	for (g = 0; g < numGroups; g++) if (gRecv[g]) wake(g);

	for (g = 0; g < numGroups; g++) {
		if (!gActive[g]) continue;
		var th = thr[g], ast = adaptStep[g];
		for (i = gOff[g]; i < gOff[g + 1]; i++) {
			fired[i] = 0;
			if (refr[i] === 0 && V[i] >= th + A[i]) {
				fired[i] = 1; V[i] = 0; refr[i] = REFRACTORY; A[i] += ast; gFired[g] = 1; spikes[g]++;
			}
		}
	}
	for (g = 0; g < numGroups; g++) {
		if (!gActive[g]) continue;
		if (gFired[g] || gRecv[g] || gStim[g]) gCool[g] = COOLDOWN;
		else if (--gCool[g] <= 0) {
			gActive[g] = 0;
			V.fill(0, gOff[g], gOff[g + 1]); A.fill(0, gOff[g], gOff[g + 1]);
			fired.fill(0, gOff[g], gOff[g + 1]); refr.fill(0, gOff[g], gOff[g + 1]);
		}
	}

	var memory = learn(spikes);
	self.postMessage({ type: 'tick', counts: spikes, memory: memory, ms: performance.now() - t0 });
	if (running) setTimeout(tick, Math.max(0, 1000 / TICK_RATE - (performance.now() - t0)));
}

// dopamine-gated weakening of recently active Kenyon cell -> MBON synapses
function learn(spikes) {
	if (!plastic) return null;
	var punish = spikes[G.DAN_PPL1] / Math.max(1, gOff[G.DAN_PPL1 + 1] - gOff[G.DAN_PPL1]);
	var reward = spikes[G.DAN_PAM] / Math.max(1, gOff[G.DAN_PAM + 1] - gOff[G.DAN_PAM]);
	var teachAp = punish > DOPA_THRESHOLD ? punish : 0, teachAv = reward > DOPA_THRESHOLD ? reward : 0;
	for (var i = kcStart; i < kcEnd; i++) {
		var k = i - kcStart;
		trace[k] += ((fired[i] ? 1 : 0) - trace[k]) * TRACE_RATE;
		if (!context) background[k] += (trace[k] - background[k]) * 0.01;
	}
	if (context) {
		var fp = fingerprints[context] || (fingerprints[context] = { n: 0, c: new Float32Array(kcEnd - kcStart) });
		fp.n++;
		for (k = 0; k < fp.c.length; k++) if (trace[k] - background[k] > ELIGIBLE) fp.c[k] += 1;
	}
	var sumAp = 0, sumAv = 0, nAp = 0, nAv = 0;
	// what the smell being sensed right now has been taught: strength of the synapses from the
	// Kenyon cells firing at this moment, compared with where they started
	var nowAp = 0, baseAp = 0, nowAv = 0, baseAv = 0;
	for (var p = 0; p < plastic.length; p++) {
		var j = plastic[p], base = plasticBase[p], tr = trace[plasticPre[p]] - background[plasticPre[p]];
		if (tr > ELIGIBLE) {
			if (plasticKind[p] === 0) { nowAp += W[j]; baseAp += base; } else { nowAv += W[j]; baseAv += base; }
			var teach = plasticKind[p] === 0 ? teachAp : teachAv;
			if (teach) W[j] = Math.max(base * MIN_WEIGHT, W[j] * (1 - LEARN_RATE * Math.min(1, teach * 4) * Math.min(1, tr * 8)));
		}
		W[j] += (base - W[j]) * RECOVERY;
		if (plasticKind[p] === 0) { sumAp += W[j] / base; nAp++; } else { sumAv += W[j] / base; nAv++; }
	}
	// Every few ticks, each known smell: synapse strength weighted by how specific each Kenyon
	// cell is to that smell (its rate for this smell squared, over its rate summed over all
	// smells). Kenyon cells that fire for any smell count for little, so learning about one
	// smell doesn't read as learning about all of them.
	if (tickCount++ % 5 === 0) {
		var names = Object.keys(fingerprints), total = new Float32Array(kcEnd - kcStart);
		for (var nn = 0; nn < names.length; nn++) {
			var fq = fingerprints[names[nn]];
			for (k = 0; k < total.length; k++) total[k] += fq.c[k] / fq.n;
		}
		for (nn = 0; nn < names.length; nn++) {
		var name = names[nn], f = fingerprints[name], wa = 0, ba = 0, wv = 0, bv = 0;
		for (p = 0; p < plastic.length; p++) {
			var kk = plasticPre[p], rate = f.c[kk] / f.n;
			if (!rate) continue;
			var wgt = rate * rate / total[kk];
			if (plasticKind[p] === 0) { wa += W[plastic[p]] * wgt; ba += plasticBase[p] * wgt; }
			else { wv += W[plastic[p]] * wgt; bv += plasticBase[p] * wgt; }
		}
		odorMemory[name] = { approach: ba ? wa / ba : 1, avoid: bv ? wv / bv : 1 };
		}
	}
	// how much of each pathway is still at full strength (1 = nothing learned)
	return { approach: nAp ? sumAp / nAp : 1, avoid: nAv ? sumAv / nAv : 1, punish: punish, reward: reward,
		odorApproach: baseAp > 0 ? nowAp / baseAp : -1, odorAvoid: baseAv > 0 ? nowAv / baseAv : -1, odors: odorMemory };
}

self.onmessage = function (e) {
	var d = e.data;
	switch (d.type) {
	case 'init':
		G = d.groups || {};
		if (d.synWeight) SYN_WEIGHT = d.synWeight;
		if (d.kcKc) KC_KC = true;
		THR_SCALE = d.thresholdScale || {};
		// the file is gzipped, unless whoever served it already unpacked it on the way
		var head = new Uint8Array(d.buffer, 0, 2);
		(head[0] === 0x1f && head[1] === 0x8b ? gunzip(d.buffer) : Promise.resolve(d.buffer)).then(function (raw) {
			var toSorted = parse(raw);
			thr = new Float32Array(numGroups).fill(THRESHOLD);
			for (var tn in THR_SCALE) if (G[tn] !== undefined && G[tn] < numGroups) thr[G[tn]] = THRESHOLD * THR_SCALE[tn];
			for (var name in (d.sets || {})) SETS[name] = Uint32Array.from(d.sets[name], function (ix) { return toSorted[ix]; });
			if (G.KC !== undefined) buildPlasticity();
			var sizes = new Uint32Array(numGroups);
			for (var g = 0; g < numGroups; g++) sizes[g] = gOff[g + 1] - gOff[g];
			self.postMessage({ type: 'ready', neurons: N, edges: E, groupSizes: sizes, plastic: plastic ? plastic.length : 0 });
		}).catch(function (err) { self.postMessage({ type: 'error', message: String(err && err.message || err) }); });
		break;
	case 'start': running = true; setTimeout(tick, 0); break;
	case 'stop': running = false; break;
	case 'setStim':
		context = d.context || null;
		var r = resolve(d.items);
		stimIdx = r.idx.length ? r.idx : null; stimVal = r.val;
		break;
	case 'pulse':
		var p2 = resolve(d.items);
		for (var k = 0; k < p2.idx.length; k++) { var ix = p2.idx[k]; V[ix] += p2.val[k]; wake(groupId[ix]); }
		break;
	// debug: which Kenyon cells are currently eligible (recently fired)
	case 'probeKC':
		var on = [];
		for (var q = 0; q < trace.length; q++) if (trace[q] - background[q] > ELIGIBLE) on.push(q);
		var mt = 0, md = 0, c1 = 0, c2 = 0, c3 = 0, mb = 0;
		for (q = 0; q < trace.length; q++) {
			var dd = trace[q] - background[q];
			if (trace[q] > mt) mt = trace[q]; if (dd > md) md = dd; if (background[q] > mb) mb = background[q];
			if (trace[q] > 0.15) c1++; if (dd > 0.05) c2++; if (dd > 0.1) c3++;
		}
		self.postMessage({ type: 'probe', kc: on, stats: { maxTrace: mt, maxDiff: md, maxBg: mb, trace015: c1, diff005: c2, diff01: c3 } });
		break;
	case 'setParams':
		if (d.dopaThreshold !== undefined) DOPA_THRESHOLD = d.dopaThreshold;
		if (d.tickRate) TICK_RATE = d.tickRate;
		if (d.learnRate !== undefined) LEARN_RATE = d.learnRate;
		break;
	case 'reset':
		V.fill(0); A.fill(0); fired.fill(0); refr.fill(0); gActive.fill(0); stimIdx = stimVal = null;
		if (plastic) { for (var p = 0; p < plastic.length; p++) W[plastic[p]] = plasticBase[p]; trace.fill(0); background.fill(0); }
		fingerprints = {}; odorMemory = {};
		break;
	}
};
