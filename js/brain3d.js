/* A 3D view of the fly brain: every one of the 139,255 FlyWire neurons as a dot at its real
 * position (the anchor point on its backbone), grouped into brain parts. Drag to turn, scroll
 * or pinch to zoom, pick a part to pick it out. When a brain is running, the neurons of groups
 * that are firing turn red.
 *
 *   Brain3D.open(() => someFlyBrainOrNull);
 */
(function () {
	'use strict';

	var THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';

	// brain parts, built from the functional groups in brain_meta.json
	var PARTS = [
		{ name: 'Optic lobes', color: '#2f6fb5', groups: ['VIS_PHOTO', 'VIS_OPTIC', 'VIS_LOOM', 'VIS_PROJ'], split: true,
			note: 'The compound eyes and the layers that process images; LC4/LPLC2 detect things coming at the fly.' },
		{ name: 'Antennal lobes (smell)', color: '#3a9a4a', groups: ['OLF_ORN', 'OLF_PN', 'OLF_LN'], split: true,
			note: 'Odour receptors converge on glomeruli; projection neurons carry each smell on to the mushroom body and lateral horn.' },
		{ name: 'Mushroom body', color: '#d9a400', groups: ['KC', 'MBON_AP', 'MBON_AV', 'DAN_PPL1', 'DAN_PAM', 'DAN_OTHER'],
			note: 'Where smells are learned and remembered: Kenyon cells, MBON output neurons, reward (PAM) and punishment (PPL1) dopamine.' },
		{ name: 'Lateral horn', color: '#8a4fb8', groups: ['LH'], note: 'Inborn responses to smells, no learning needed.' },
		{ name: 'Central complex', color: '#e0701f', groups: ['CX'], note: 'The brain\'s compass: heading and steering.' },
		{ name: 'Taste, touch, wind', color: '#1a9c9c', groups: ['GUS_SWEET', 'GUS_BITTER', 'GUS_OTHER', 'MECH_BRISTLE', 'MECH_JO', 'THERMO', 'SENS_OTHER'],
			note: 'Sweet and bitter taste; sensory bristles; Johnston\'s organ senses wind and gravity.' },
		{ name: 'Signals from the body', color: '#7a5230', groups: ['ASC'], note: 'Ascending neurons from the nerve cord, carrying feeling (pain too) from the body and legs.' },
		{ name: 'Descending neurons', color: '#111111', groups: ['DN_GF', 'DN_MDN', 'DN_TURN_L', 'DN_TURN_R', 'DN_P09', 'DN_OTHER'],
			note: 'Commands sent down to the nerve cord: Giant Fiber (escape), MDN (walk backwards), DNa01/02 (turn), DNp09 (freeze).' },
		{ name: 'Feeding and head motor', color: '#d64f9a', groups: ['MN_FEED', 'MN_HEAD', 'MN_OTHER'], note: 'Motor neurons in the brain: proboscis, swallowing, neck, eyes, antennae.' },
		{ name: 'Hormones, octopamine', color: '#6d8c1c', groups: ['HUNGER', 'FATIGUE', 'ENDO_OTHER', 'OA'], note: 'Neuroendocrine cells (hunger, fatigue) and octopamine (arousal).' },
		{ name: 'Rest of the central brain', color: '#b5b5b5', groups: ['CENTRAL_OTHER'], note: 'Everything else in the central brain.' },
	];

	var meta = null, pointsReady = null, loadingThree = null;
	var overlay, canvas, renderer, scene, camera, geom, colors, groupOf, partOf, labels = [];
	var getBrain = null, selected = -1, raf = 0, lastColor = 0;
	var view = { yaw: 0.6, pitch: 0.25, dist: 3.2, auto: true, drag: null };

	function loadScript(url) {
		return new Promise(function (res, rej) {
			var s = document.createElement('script');
			s.src = url; s.onload = res; s.onerror = function () { rej(new Error('couldn\'t load three.js')); };
			document.head.appendChild(s);
		});
	}

	function version() { return window.FlyBrain && FlyBrain.version ? '?v=' + FlyBrain.version : ''; }

	function loadData() {
		if (pointsReady) return pointsReady;
		pointsReady = fetch('data/brain_meta.json' + version()).then(function (r) {
			if (!r.ok) throw new Error('brain_meta.json ' + r.status);
			return r.json();
		}).then(function (m) {
			meta = m;
			return fetch('data/' + m.points.file + version());
		}).then(function (r) {
			if (!r.ok) throw new Error('brain_points ' + r.status);
			return r.text();
		}).then(function (t) {
			var bin = atob(t.trim()), bytes = new Uint8Array(bin.length);
			for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			return new Int16Array(bytes.buffer);
		});
		pointsReady.catch(function () { pointsReady = null; });
		return pointsReady;
	}

	function makeScene(raw, neuronGroup) {
		var partByGroup = {}, idOf = {};
		meta.groups.forEach(function (g) { idOf[g.name] = g.id; });
		PARTS.forEach(function (p, pi) { p.groups.forEach(function (g) { if (g in idOf) partByGroup[idOf[g]] = pi; }); });
		var n = raw.length / 3, pos = [], keep = [];
		var S = 1 / 32000;
		for (var i = 0; i < n; i++) {
			var x = raw[i * 3], y = raw[i * 3 + 1], z = raw[i * 3 + 2];
			if (x === -32768) continue;
			// FlyWire: x left-right, y top-down, z front-back. Stretch z to true proportion.
			pos.push(x * S, -y * S, -z * S);
			keep.push(i);
		}
		groupOf = new Uint16Array(keep.length); partOf = new Uint8Array(keep.length);
		for (var k = 0; k < keep.length; k++) { groupOf[k] = neuronGroup[keep[k]]; partOf[k] = partByGroup[groupOf[k]] ?? 10; }
		geom = new THREE.BufferGeometry();
		geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
		colors = new Float32Array(keep.length * 3);
		geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
		var mat = new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false });
		scene = new THREE.Scene();
		scene.background = new THREE.Color(0xffffff);
		scene.add(new THREE.Points(geom, mat));
		camera = new THREE.PerspectiveCamera(38, 1, 0.01, 50);
		renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

		// label anchors: each part's centre (optic and antennal lobes one per side)
		labels.forEach(function (l) { l.el.remove(); });
		labels = [];
		PARTS.forEach(function (p, pi) {
			var sides = p.split ? [-1, 1] : [0];
			sides.forEach(function (side) {
				var cx = 0, cy = 0, cz = 0, c = 0;
				for (var k = 0; k < partOf.length; k++) {
					if (partOf[k] !== pi) continue;
					var px = pos[k * 3];
					if (side && Math.sign(px) !== side) continue;
					cx += px; cy += pos[k * 3 + 1]; cz += pos[k * 3 + 2]; c++;
				}
				if (!c) return;
				var el = document.createElement('div');
				el.className = 'b3-label'; el.textContent = p.name;
				overlay.querySelector('.b3-stage').appendChild(el);
				labels.push({ el: el, part: pi, v: new THREE.Vector3(cx / c, cy / c, cz / c) });
			});
		});
		recolor(true);
	}

	function recolor(force) {
		var b = getBrain && getBrain(), act = b && b.ready ? b.act : null;
		if (!force && !act) return;
		var byGroup = {};
		if (act) meta.groups.forEach(function (g) { byGroup[g.id] = Math.min(1, (act[g.name] || 0) * 8); });
		var rgb = PARTS.map(function (p) { var c = new THREE.Color(p.color); return [c.r, c.g, c.b]; });
		for (var k = 0; k < partOf.length; k++) {
			var own = selected < 0 || partOf[k] === selected, c = own ? rgb[partOf[k]] : [0.9, 0.9, 0.9];
			var r = c[0], g = c[1], bl = c[2];
			var a = act && own ? byGroup[groupOf[k]] : 0;
			if (act && own) { r = 0.8 + 0.2 * r; g = 0.8 + 0.2 * g; bl = 0.8 + 0.2 * bl; }   // pale while a brain runs,
			if (a > 0.01) { r += (0.86 - r) * a; g += (0.04 - g) * a; bl += (0.12 - bl) * a; }  // red where it fires
			colors[k * 3] = r; colors[k * 3 + 1] = g; colors[k * 3 + 2] = bl;
		}
		geom.attributes.color.needsUpdate = true;
		renderLegend(act);
	}

	function renderLegend(act) {
		var list = overlay.querySelector('.b3-parts');
		var counts = PARTS.map(function () { return 0; });
		for (var k = 0; k < partOf.length; k++) counts[partOf[k]]++;
		list.innerHTML = PARTS.map(function (p, pi) {
			var level = 0;
			if (act) p.groups.forEach(function (g) { level = Math.max(level, act[g] || 0); });
			return '<button type="button" data-part="' + pi + '" aria-pressed="' + (selected === pi) + '">' +
				'<span><i class="b3-sw" style="background:' + p.color + '"></i>' + p.name + '</span><span class="b3-num">' + counts[pi].toLocaleString('en-US') +
				(act ? ' · ' + (level * 100).toFixed(1) + '%' : '') + '</span></button>';
		}).join('');
		var note = overlay.querySelector('.b3-note');
		note.textContent = selected >= 0 ? PARTS[selected].note
			: act ? 'Red: neurons firing right now in the brain of the person it belongs to.' : 'Each dot is one neuron, placed where it sits in a real fly brain (FlyWire). Pick a part to see where it is.';
	}

	function frame() {
		raf = requestAnimationFrame(frame);
		var w = canvas.clientWidth, h = canvas.clientHeight;
		if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
			renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
		}
		if (view.auto) view.yaw += 0.003;
		var cp = Math.cos(view.pitch);
		camera.position.set(Math.sin(view.yaw) * cp * view.dist, Math.sin(view.pitch) * view.dist, Math.cos(view.yaw) * cp * view.dist);
		camera.lookAt(0, 0, 0);
		renderer.render(scene, camera);
		labels.forEach(function (l) {
			var p = l.v.clone().project(camera);
			l.el.hidden = l.part !== selected || p.z > 1;
			l.el.style.transform = 'translate(' + ((p.x + 1) / 2 * w) + 'px,' + ((1 - p.y) / 2 * h) + 'px) translate(-50%,-50%)';
		});
		var now = performance.now();
		if (now - lastColor > 100) { lastColor = now; recolor(false); }
	}

	function bindControls() {
		canvas.addEventListener('pointerdown', function (e) {
			view.auto = false; view.drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch };
			canvas.setPointerCapture(e.pointerId);
		});
		canvas.addEventListener('pointermove', function (e) {
			if (!view.drag) return;
			view.yaw = view.drag.yaw - (e.clientX - view.drag.x) * 0.008;
			view.pitch = Math.max(-1.4, Math.min(1.4, view.drag.pitch + (e.clientY - view.drag.y) * 0.008));
		});
		var end = function () { view.drag = null; };
		canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
		canvas.addEventListener('wheel', function (e) {
			e.preventDefault(); view.auto = false;
			view.dist = Math.max(0.9, Math.min(8, view.dist * Math.exp(e.deltaY * 0.001)));
		}, { passive: false });
		// pinch zoom
		var touches = {};
		canvas.addEventListener('touchstart', function (e) { if (e.touches.length === 2) touches.d = dist2(e.touches); }, { passive: true });
		canvas.addEventListener('touchmove', function (e) {
			if (e.touches.length !== 2 || !touches.d) return;
			var d = dist2(e.touches); view.dist = Math.max(0.9, Math.min(8, view.dist * touches.d / d)); touches.d = d;
		}, { passive: true });
		function dist2(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
		overlay.querySelector('.b3-parts').addEventListener('click', function (e) {
			var b = e.target.closest('[data-part]');
			if (!b) return;
			var pi = +b.dataset.part;
			view.auto = false;
			selected = selected === pi ? -1 : pi;
			recolor(true);
		});
		overlay.querySelector('[data-close]').addEventListener('click', close);
		document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !overlay.hidden) close(); });
	}

	function close() {
		overlay.hidden = true;
		cancelAnimationFrame(raf); raf = 0;
	}

	function open(brainGetter) {
		getBrain = brainGetter || null;
		overlay = overlay || document.getElementById('brain3d');
		canvas = canvas || overlay.querySelector('canvas');
		overlay.hidden = false;
		var status = overlay.querySelector('.b3-status');
		if (scene) { status.textContent = ''; recolor(true); if (!raf) frame(); return; }
		status.textContent = 'Loading the positions of 139,255 neurons…';
		if (!overlay.dataset.bound) { bindControls(); overlay.dataset.bound = '1'; }
		loadingThree = loadingThree || (window.THREE ? Promise.resolve() : loadScript(THREE_URL));
		Promise.all([loadingThree, loadData(), loadGroups()]).then(function (res) {
			makeScene(res[1], res[2]);
			status.textContent = '';
			frame();
		}).catch(function (err) {
			if (!window.THREE) loadingThree = null;
			status.textContent = location.protocol === 'file:'
				? 'The 3D model needs the game opened through the web server (double-click "Play.bat").'
				: 'Couldn\'t load the model: ' + err.message;
		});
	}

	// the group of every neuron, one byte each (the connectome itself is too big to fetch for this)
	function loadGroups() {
		return loadData().then(function () {
			return fetch('data/' + meta.points.groups + version());
		}).then(function (r) {
			if (!r.ok) throw new Error('brain_groups ' + r.status);
			return r.text();
		}).then(function (t) {
			var bin = atob(t.trim()), out = new Uint8Array(bin.length);
			for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
			return out;
		});
	}

	window.Brain3D = { open: open, close: close };
})();
