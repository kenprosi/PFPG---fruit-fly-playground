/* FlyBrain: one fly brain (its own worker) that a ragdoll can wear.
 *
 *   await FlyBrain.load();            // fetch the connectome once
 *   const b = new FlyBrain();         // spins up a worker with its own copy
 *   b.hold({ OLF_FOOD_A: 0.2 });      // sustained input, replaced on every call
 *   b.pulse({ DN_GF: 3 });            // one-off kick
 *   b.act.DN_GF                       // smoothed activity, 0..1 of the group firing per tick
 *   b.spikes.DN_GF                    // spikes in the latest tick
 *   b.memory                          // { approach, avoid } strength of the learnable pathways
 *   b.kill();
 */
(function () {
	'use strict';

	var shared = null;   // { meta, buffer, groups: {name: id}, sizes }
	var loading = null;

	function FlyBrain(opts) {
		opts = opts || {};
		if (!shared) throw new Error('FlyBrain.load() first');
		var self = this;
		this.ready = false;
		this.act = {};            // exponential moving average of firing fraction per group
		this.spikes = {};         // spike count per group, latest tick
		this.history = [];        // recent ticks of { name: firing fraction } for the panel
		this.memory = { approach: 1, avoid: 1, punish: 0, reward: 0 };
		this.tickMs = 0;
		this.ticks = 0;
		this.onTick = null;
		shared.meta.groups.forEach(function (g) { self.act[g.name] = 0; self.spikes[g.name] = 0; });

		this.worker = new Worker(shared.workerUrl);
		this.worker.onmessage = function (e) { self._message(e.data); };
		this.worker.onerror = function (e) { self.error = e.message || 'worker error'; };
		this.worker.postMessage({ type: 'init', buffer: shared.buffer.slice(0), groups: shared.groups, sets: shared.meta.sets,
			synWeight: opts.synWeight || 0, thresholdScale: opts.thresholdScale || FlyBrain.THRESHOLDS });
	}

	FlyBrain.prototype._message = function (d) {
		if (d.type === 'ready') {
			this.ready = true;
			this.sizes = d.groupSizes;
			this.worker.postMessage({ type: 'start' });
			if (this._pendingHold) this.hold(this._pendingHold);
			return;
		}
		if (d.type === 'error') { this.error = d.message; return; }
		if (d.type === 'probe') { this.probe = d; return; }
		if (d.type !== 'tick') return;
		var groups = shared.meta.groups, frame = {};
		for (var g = 0; g < groups.length; g++) {
			var name = groups[g].name, size = groups[g].size || 1, n = d.counts[g] || 0;
			var frac = n / size;
			this.spikes[name] = n;
			this.act[name] = Math.max(frac, this.act[name] * 0.8 + frac * 0.2);
			frame[name] = frac;
		}
		this.history.push(frame);
		if (this.history.length > 120) this.history.shift();
		if (d.memory) this.memory = d.memory;
		this.tickMs = d.ms;
		this.ticks++;
		if (this.onTick) this.onTick(this);
	};

	// sustained input: { groupOrSetName: intensity per worker tick }; `context` names the smell
	// being sensed, so the brain can build up that smell's Kenyon cell fingerprint
	FlyBrain.prototype.hold = function (inputs, context) {
		if (!this.ready) { this._pendingHold = inputs; return; }
		var items = [];
		for (var k in inputs) if (inputs[k]) items.push([k, inputs[k]]);
		this.worker.postMessage({ type: 'setStim', items: items, context: context || null });
	};

	FlyBrain.prototype.pulse = function (inputs) {
		if (!this.ready) return;
		var items = [];
		for (var k in inputs) if (inputs[k]) items.push([k, inputs[k]]);
		this.worker.postMessage({ type: 'pulse', items: items });
	};

	FlyBrain.prototype.kill = function () { this.worker.terminate(); this.ready = false; };

	FlyBrain.load = function (base) {
		if (shared) return Promise.resolve(shared);
		if (loading) return loading;
		base = base || '';
		var v = FlyBrain.version ? '?v=' + FlyBrain.version : '';
		loading = Promise.all([
			fetch(base + 'data/brain_meta.json' + v).then(function (r) { if (!r.ok) throw new Error('brain_meta.json ' + r.status); return r.json(); }),
			fetchBrain(base, v),
		]).then(function (res) {
			var meta = res[0], groups = {};
			meta.groups.forEach(function (g) { groups[g.name] = g.id; });
			shared = { meta: meta, buffer: res[1], groups: groups, workerUrl: base + 'js/brain-worker.js' + (FlyBrain.version ? '?v=' + FlyBrain.version : '') };
			return shared;
		});
		loading.catch(function () { loading = null; });
		return loading;
	};

	// Kenyon cells fire only with several projection-neuron inputs at once, which keeps each
	// smell to a small, distinct set of them (sparse coding) — the basis of telling smells apart.
	FlyBrain.THRESHOLDS = { KC: 1.5 };

	// the connectome: brain.bin.gz, or the same bytes as base64 text parts where a host won't
	// serve .gz files (brain.b64.0.txt, brain.b64.1.txt, ...)
	function fetchBrain(base, v) {
		return fetch(base + 'data/brain.bin.gz' + v).then(function (r) {
			if (r.ok) return r.arrayBuffer();
			throw new Error('brain.bin.gz ' + r.status);
		}).catch(function () {
			var parts = [];
			function next(n) {
				return fetch(base + 'data/brain.b64.' + n + '.txt' + v).then(function (r) {
					if (!r.ok) {
						if (n === 0) throw new Error('brain data not found');
						return null;
					}
					return r.text().then(function (t) { parts.push(t); return next(n + 1); });
				});
			}
			return next(0).then(function () {
				var bin = atob(parts.join('')), bytes = new Uint8Array(bin.length);
				for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
				return bytes.buffer;
			});
		});
	}

	FlyBrain.meta = function () { return shared && shared.meta; };

	window.FlyBrain = FlyBrain;
})();
