/* Ragdoll playground: bodies, physics, drawing, input. */
(() => {
  const cv = document.getElementById('c');
  const ctx = cv.getContext('2d');
  const countEl = document.getElementById('count');
  const menuEl = document.getElementById('menu');

  let W = 0, H = 0, G = 0, dpr = 1;
  let S = 1; // body scale, fixed at load
  const people = [];
  const dust = [];
  const drops = [];  // flying blood
  const stains = []; // blood on the floor
  let slow = false;
  const MAX_PEOPLE = 12;
  const BLOOD = '#c8102e';

  // ---------- body plan ----------
  // Each bone is a lattice of small particles stuck together. It holds its shape while it is
  // one piece and cracks into pieces that each hold their own shape. The inner columns are bone
  // (tough), the outer ones flesh (tears easily). Coordinates are for a person facing right
  // with feet on the floor at y = 0, at scale 1.
  // name, start, end, width, rows, cols, particle radius, tear stretch, damage multiplier
  const BONES = [
    ['head',   [0, -129], [0, -152], 18, 5, 4, 3.5, 1.2, 0.25],
    ['chest',  [0, -128], [0, -98],  18, 6, 4, 3.5, 0.8, 0.2],
    ['belly',  [0, -98],  [0, -66],  18, 6, 4, 3.5, 0.8, 0.25],
    ['thighF', [1, -70],  [1, -34],  10, 7, 3, 3.2, 0.9, 0.35],
    ['shinF',  [1, -34],  [1, -4],    9, 6, 3, 3,   0.9, 0.35],
    ['thighB', [-1, -70], [-1, -34], 10, 7, 3, 3.2, 0.9, 0.35],
    ['shinB',  [-1, -34], [-1, -4],   9, 6, 3, 3,   0.9, 0.35],
    ['armF',   [0, -124], [2, -100],  8, 5, 3, 3,   0.9, 0.35],
    ['foreF',  [2, -100], [6, -76],   7, 5, 3, 2.8, 0.9, 0.35],
    ['armB',   [0, -124], [1, -100],  8, 5, 3, 3,   0.9, 0.35],
    ['foreB',  [1, -100], [4, -76],   7, 5, 3, 2.8, 0.9, 0.35],
  ];
  const BONE_TOUGH = 0.45, FLESH_WEAK = 1.6; // damage multipliers: bone to bone, anything with flesh
  const LUMP_TOUGH = 0.15;                   // and for bonds inside one lump of flesh (see buildBody)
  const HEAD = 0, CHEST = 1, BELLY = 2, SHIN_F = 4, SHIN_B = 6;
  const DRAW_ORDER = [9, 10, 5, 6, 2, 1, 0, 3, 4, 7, 8];
  // parent bone, child bone, joint point, lo, hi, target, muscle group, tear distance, damage multiplier
  const JOINTS = [
    [1, 0,  [0, -129], -0.6,  0.6,   0,     'core', 9,  0.8],  // neck
    [1, 2,  [0, -98],  -0.6,  0.6,   0,     'core', 16, 0.15], // waist
    [2, 3,  [1, -68],  -2.3,  0.5,   0,     'leg',  12, 0.6],  // hip
    [3, 4,  [1, -34],  -0.05, 2.5,   0,     'leg',  11, 0.7],  // knee
    [2, 5,  [-1, -68], -2.3,  0.5,   0,     'leg',  12, 0.6],
    [5, 6,  [-1, -34], -0.05, 2.5,   0,     'leg',  11, 0.7],
    [1, 7,  [0, -124], -3.0,  1.0,  -0.06,  'arm',  10, 0.9],  // shoulder
    [7, 8,  [2, -100], -2.6,  0.03, -0.25,  'arm',  10, 0.7],  // elbow
    [1, 9,  [0, -124], -3.0,  1.0,   0.02,  'arm',  10, 0.9],
    [9, 10, [1, -100], -2.6,  0.03, -0.2,   'arm',  10, 0.7],
  ];
  const NECK = 0, WAIST = 1, LEG_JOINTS = [2, 3, 4, 5];
  const MUSCLE = { core: 0.14, leg: 0.12, arm: 0.035 };

  const key = (a, b) => a < b ? a * 1024 + b : b * 1024 + a;

  function spawn(x, feetY, dir) {
    if (people.length >= MAX_PEOPLE) return null;
    const p = buildBody(x, feetY, dir || (Math.random() < 0.5 ? 1 : -1));
    people.push(p);
    updateCount();
    return p;
  }

  function buildBody(x, feetY, dir) {
    const onFloor = feetY >= G - 1;
    if (onFloor) feetY = G;
    const pts = [], bones = [], bonds = [];
    const addPt = (rx, ry, r, bone, anchor) => {
      const X = x + rx * dir * S, Y = feetY + ry * S;
      pts.push({ x: X, y: Y, px: X, py: Y, r: r * S, bone, anchor, wound: 0, torn: false, stain: 0, hurt: 0, fire: 0, burn: 0, frost: 0,
        comp: 0, bonds: [], ivx: 0, ivy: 0, contact: false });
      return pts.length - 1;
    };
    const addBond = (a, b, kind, tear, dmg, extra) => {
      const A = pts[a], B = pts[b];
      const L = kind === 'joint' ? 0 : Math.hypot(B.x - A.x, B.y - A.y);
      bonds.push(Object.assign({ a, b, L, kind, tear, dmg, hp: 1, broken: false }, extra));
      return bonds.length - 1;
    };

    BONES.forEach((d, bi) => {
      const [name, [sx, sy], [ex, ey], w, rows, cols, r, tear, dmg] = d;
      const len = Math.hypot(ex - sx, ey - sy), nx = -(ey - sy) / len, ny = (ex - sx) / len;
      const grid = [];
      for (let ri = 0; ri < rows; ri++) {
        const t = ri / (rows - 1), cx = sx + (ex - sx) * t, cy = sy + (ey - sy) * t, row = [];
        for (let ci = 0; ci < cols; ci++) {
          const o = (ci / (cols - 1) - 0.5) * w;
          const q = addPt(cx + nx * o, cy + ny * o, r, bi, false);
          pts[q].core = ci > 0 && ci < cols - 1;
          row.push(q);
        }
        grid.push(row);
      }
      const mid = grid[rows >> 1];
      bones.push({ name, grid, mid, end: grid[rows - 1], core: mid[cols >> 1], all: grid.flat(), intact: true, width: w, joints: [] });
      // grain: the bone is split at random into lumps of about five particles; bonds inside a lump
      // hardly ever break, the seams between lumps do, so a smashed bone comes apart in chunks
      const flat = grid.flat(), seeds = [];
      for (const i of flat.slice().sort(() => Math.random() - 0.5)) {
        if (seeds.every(sd => Math.hypot(pts[i].x - pts[sd].x, pts[i].y - pts[sd].y) > 9 * S)) seeds.push(i);
      }
      for (const i of flat) {
        let best = 0, bd = Infinity;
        seeds.forEach((sd, si) => {
          const d = Math.hypot(pts[i].x - pts[sd].x, pts[i].y - pts[sd].y) * (0.8 + Math.random() * 0.4);
          if (d < bd) { bd = d; best = si; }
        });
        pts[i].lump = best;
      }
      const link = (a, b) => addBond(a, b, 'in', tear,
        dmg * (pts[a].core && pts[b].core ? BONE_TOUGH : FLESH_WEAK) * (pts[a].lump === pts[b].lump ? LUMP_TOUGH : 1), { bone: bi });
      for (let ri = 0; ri < rows; ri++) for (let ci = 0; ci < cols; ci++) {
        const a = grid[ri][ci];
        if (ci + 1 < cols) link(a, grid[ri][ci + 1]);
        if (ri + 1 < rows) {
          link(a, grid[ri + 1][ci]);
          if (ci + 1 < cols) link(a, grid[ri + 1][ci + 1]);
        }
      }
    });

    const joints = JOINTS.map((d, ji) => {
      const [pb, cb, [jx, jy], lo, hi, tgt, grp, tear, dmg] = d;
      // an invisible anchor inside each bone, pinned to it by three stiff bonds
      const anchor = bi => {
        const a = addPt(jx, jy, 0, bi, true), A = pts[a];
        const near = bones[bi].all.filter(i => !pts[i].anchor)
          .map(i => [i, (pts[i].x - A.x) ** 2 + (pts[i].y - A.y) ** 2])
          .sort((u, v) => u[1] - v[1]).slice(0, 3).map(n => n[0]);
        A.nbrs = near;
        for (const i of near) addBond(a, i, 'anchor', 0, 0, { bone: bi });
        bones[bi].all.push(a);
        return a;
      };
      const aP = anchor(pb), aC = anchor(cb);
      const bond = addBond(aP, aC, 'joint', tear, dmg, { joint: ji });
      bones[pb].joints.push(ji); bones[cb].joints.push(ji);
      return { p: pb, c: cb, aP, aC, bond, grp, rel0: 0, active: true, cSide: [], pSide: [],
        lo: dir > 0 ? lo : -hi, hi: dir > 0 ? hi : -lo, tgt: tgt * dir };
    });

    // each bone remembers its own shape, so it can always be pulled back into it
    for (const bone of bones) {
      let cx = 0, cy = 0;
      for (const i of bone.all) { cx += pts[i].x; cy += pts[i].y; }
      cx /= bone.all.length; cy /= bone.all.length;
      bone.rest = bone.all.map(i => [pts[i].x - cx, pts[i].y - cy]);
      bone.orig = bone.rest.map(r => r.slice());
      bone.rest0 = bone.rest.map(r => r.slice());
      bone.maxDent = bone.width * 0.6 * S;
      bone.all.forEach((i, k) => { pts[i].k = k; });
      bone.anchorW = Math.max(1, bone.grid.flat().length / 7);
      bone.frags = [bone.all.map((i, k) => k)];
      bone.body = bone.all.slice();
      bone.axisK = bone.frags[0].filter(k => !pts[bone.all[k]].anchor);
      // which way the bone pointed when built, to measure its turns against
      const g = bone.grid, first = rowMid(pts, g[0]), last = rowMid(pts, g[g.length - 1]);
      bone.axis0 = Math.atan2(last[1] - first[1], last[0] - first[0]);
    }
    for (const b of bonds) b.L0 = b.L;

    const bondMap = new Map();
    bonds.forEach((b, i) => { bondMap.set(key(b.a, b.b), i); pts[b.a].bonds.push(i); pts[b.b].bonds.push(i); });
    // the skin: two triangles per lattice square, each with the three bonds that must hold for it to show
    for (const bone of bones) {
      const g = bone.grid, tris = [];
      const bd = (u, v) => bondMap.get(key(u, v));
      for (let r = 0; r < g.length - 1; r++) for (let c = 0; c < g[r].length - 1; c++) {
        const a = g[r][c], b = g[r][c + 1], cc = g[r + 1][c + 1], d = g[r + 1][c];
        tris.push(a, b, cc, bd(a, b), bd(b, cc), bd(a, cc), a, cc, d, bd(a, cc), bd(cc, d), bd(a, d));
      }
      bone.tris = tris;
    }
    const p = { pts, bones, bonds, joints, bondMap, dir, restPos: pts.map(q => [q.x, q.y]),
      links: bonds.filter(b => b.kind !== 'in'), jointBonds: joints.map(j => j.bond),
      ko: 0, fallT: 0, blood: 100, dead: false, dirty: true,
      ctrl: onFloor ? 1 : 0, standing: onFloor, standX: x, grounded: onFloor, legsOk: true, nBroken: 0, regen: false, regenT: 0,
      posture: 'stand', walkV: 0, gait: 0, rubT: 0 };
    for (const j of joints) j.rel0 = Math.abs(rawAngle(p, j, false)) > Math.PI / 2 ? Math.PI : 0;
    return p;
  }

  // Heal in place: the biggest piece of the body is kept as it is (dents pressed out),
  // everything missing grows back from the joints it hangs off, and the torn-off pieces
  // are used up to do it, so they vanish from the floor.
  // Where every bone should be to make the body whole: bones on the biggest piece stay as they
  // are (dents pressed out); missing ones take the pose of the bone they hang off, outward.
  function healPlan(person) {
    if (person.dirty) topology(person);
    const P = person.pts, B = person.bones, R0 = person.restPos;
    const size = new Map();
    for (const q of P) if (!q.anchor && !q.ghost) size.set(q.comp, (size.get(q.comp) || 0) + 1);
    let main = -1, best = -1;
    for (const [c, n] of size) if (n > best) { best = n; main = c; }
    const T = B.map(bone => !bone.ghost && bone.intact && bone.body.every(i => P[i].comp === main) ? fitBone(P, R0, bone.body) : null);
    if (!T.some(Boolean)) return null;
    for (let grew = true; grew;) {
      grew = false;
      for (const j of person.joints) {
        // (pivot: the joint on the kept body a grown limb sprouts from, where it starts out small)
        if (T[j.p] && !T[j.c]) { T[j.c] = Object.assign({}, T[j.p], { grown: true, pivot: T[j.p].grown ? T[j.p].pivot : R0[j.aC] }); grew = true; }
        else if (T[j.c] && !T[j.p]) { T[j.p] = Object.assign({}, T[j.c], { grown: true, pivot: T[j.c].grown ? T[j.c].pivot : R0[j.aP] }); grew = true; }
      }
    }
    return T;
  }

  // Where a particle goes when it comes back: its place in the whole body, or for one that is
  // regrowing, a place in a small, lumpy version of its part that then swells out to full size.
  const SQUASH = 0.45, CHIP_SQUASH = 0.6, LUMPS = 2.5;
  function planRest(person, T, i) {
    const q = person.pts[i], R0 = person.restPos;
    if (!q.regrow || !person.healNoise) return R0[i];
    const t = T[q.bone], nz = person.healNoise;
    let cx, cy, sc;
    if (t.grown) { [cx, cy] = t.pivot; sc = SQUASH; }
    else {
      // a chip off a kept bone comes back pulled in toward the middle of that bone
      const all = person.bones[q.bone].all;
      cx = 0; cy = 0;
      for (const k of all) { cx += R0[k][0]; cy += R0[k][1]; }
      cx /= all.length; cy /= all.length; sc = CHIP_SQUASH;
    }
    return [cx + (R0[i][0] - cx) * sc + nz[i * 2], cy + (R0[i][1] - cy) * sc + nz[i * 2 + 1]];
  }
  function planPoint(person, T, i) {
    const t = T[person.pts[i].bone], [rx, ry] = planRest(person, T, i);
    return [t.tx + t.c * rx - t.s * ry, t.ty + t.s * rx + t.c * ry];
  }

  // Heal in place. Torn-off and torn bones melt into blood that flies back to the biggest piece
  // of the body and gathers there into the missing parts (see updateReform); the rest mends at
  // once. With nothing whole left to grow from, the body is rebuilt where the chest is.
  function heal(person) {
    if (person.reform || person.inflate) return;
    const P = person.pts, B = person.bones;
    const T = healPlan(person);
    if (!T) {
      for (const q of P) q.ghost = false;
      const x = rowMid(P, B[CHEST].mid)[0];
      const fresh = buildBody(Math.max(20 * S, Math.min(W - 20 * S, x)), G, person.dir);
      fresh.regen = person.regen;
      fresh.immortal = person.immortal;
      if (held && held.person === person) held = null;
      Object.assign(person, fresh);
      updateCount();
      return;
    }
    // whole bones that are lost, and chips broken off the ones that are kept
    const lost = [];
    B.forEach((bone, bi) => {
      if (T[bi].grown) { bone.ghost = true; lost.push(...bone.all); }
      else for (const i of bone.all) if (P[i].chip) lost.push(i);
    });
    if (!lost.length) { applyHeal(person, T); return; }
    // lumps for the small, misshapen parts the blood gathers into (none on joint anchors, so
    // a regrowing limb stays on its joint)
    const nz = person.healNoise = new Float32Array(P.length * 2);
    for (const i of lost) {
      P[i].regrow = true;
      if (!P[i].anchor) { nz[i * 2] = (Math.random() - 0.5) * 2 * LUMPS * S; nz[i * 2 + 1] = (Math.random() - 0.5) * 2 * LUMPS * S; }
    }
    // the pieces turn to blood where they lie, then fly home, each piece as one clot
    const flow = [], groups = new Map();
    let far = 0;
    for (const i of lost) {
      const q = P[i];
      q.ghost = true;
      if (q.anchor) continue;
      const [tx, ty] = planPoint(person, T, i);
      far = Math.max(far, Math.hypot(tx - q.x, ty - q.y));
      const key = q.bone * 1000 + q.frag;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { delay: Math.random() * 0.2, cx0: 0, cy0: 0, n: 0, members: [] });
      const f = { i, x0: q.x, y0: q.y, x: q.x, y: q.y, x1: q.x, y1: q.y, x2: q.x, y2: q.y, tx, ty };
      g.members.push(f); g.cx0 += q.x; g.cy0 += q.y; g.n++;
      flow.push(f);
      if (Math.random() < 0.15) spray(q.x, q.y, 0, -60 * S, 1);
    }
    for (const g of groups.values()) { g.cx0 /= g.n; g.cy0 /= g.n; }
    if (held && P[held.idx].ghost) held = null;
    person.reform = { t: 0, dur: 0.7 + Math.min(1.3, far / (900 * S)), flow, groups: [...groups.values()] };
  }

  // Blood in flight. Each piece flies as one clot along an arc toward where it belongs right now,
  // drawing in tight on the way and opening out again into the shape it lands in.
  function updateReform(person, dt) {
    const r = person.reform;
    r.t += dt;
    const T = healPlan(person);
    if (!T) { person.reform = null; person.healNoise = null; for (const q of person.pts) q.regrow = false; return; }
    for (const g of r.groups) {
      let cx1 = 0, cy1 = 0;
      for (const f of g.members) { [f.tx, f.ty] = planPoint(person, T, f.i); cx1 += f.tx; cy1 += f.ty; }
      cx1 /= g.n; cy1 /= g.n;
      const u = Math.max(0, Math.min(1, (r.t - g.delay) / (r.dur - 0.25)));
      const e = u * u * (3 - 2 * u), arc = Math.sin(Math.PI * e);
      const lift = arc * Math.min(90 * S, Math.hypot(cx1 - g.cx0, cy1 - g.cy0) * 0.35);
      const cx = g.cx0 + (cx1 - g.cx0) * e, cy = g.cy0 + (cy1 - g.cy0) * e - lift, tight = 1 - 0.7 * arc;
      for (const f of g.members) {
        const ox = (f.x0 - g.cx0) + ((f.tx - cx1) - (f.x0 - g.cx0)) * e;
        const oy = (f.y0 - g.cy0) + ((f.ty - cy1) - (f.y0 - g.cy0)) * e;
        f.x2 = f.x1; f.y2 = f.y1; f.x1 = f.x; f.y1 = f.y;
        f.x = cx + ox * tight; f.y = cy + oy * tight;
      }
    }
    if (r.t < r.dur) return;
    for (const bone of person.bones) bone.ghost = false;
    for (const q of person.pts) if (q.ghost) { q.ghost = false; q.fresh = 1; }
    person.reform = null;
    applyHeal(person, T);
  }

  // A regrown part appears small and lumpy where the blood gathered, swells out a little past
  // its size and settles; its skin, blood red to start with, pales back to normal after that.
  function updateInflate(person, dt) {
    const f = person.inflate;
    f.t += dt;
    const u = Math.min(1, f.t / f.dur);
    const c = 1.9, e = 1 + (c + 1) * (u - 1) ** 3 + c * (u - 1) ** 2; // ease out, with a slight overshoot
    for (const bone of person.bones) {
      if (!bone.inflateFrom) continue;
      const F = bone.inflateFrom, R1 = bone.rest0;
      for (let k = 0; k < F.length; k++) {
        bone.rest[k][0] = F[k][0] + (R1[k][0] - F[k][0]) * e;
        bone.rest[k][1] = F[k][1] + (R1[k][1] - F[k][1]) * e;
        bone.orig[k][0] = bone.rest[k][0]; bone.orig[k][1] = bone.rest[k][1];
      }
      if (u >= 1) { bone.rest = R1.map(r => r.slice()); bone.orig = R1.map(r => r.slice()); bone.inflateFrom = null; }
    }
    if (u >= 1) {
      person.inflate = null; person.healNoise = null;
      for (const q of person.pts) q.regrow = false;
    }
  }

  function applyHeal(person, T) {
    const P = person.pts, B = person.bones, R0 = person.restPos;
    let regrew = false;
    B.forEach((bone, bi) => {
      const t = T[bi];
      let squashed = false;
      for (const i of bone.all) {
        const q = P[i];
        const vx = t.grown ? t.vx : q.x - q.px, vy = t.grown ? t.vy : q.y - q.py;
        [q.x, q.y] = planPoint(person, T, i);
        q.px = q.x - vx; q.py = q.y - vy;
        q.wound = 0; q.torn = false; q.stain = 0; q.hurt = 0; q.soft = 0; q.contact = false; q.fire = 0; q.burn = 0; q.frost = 0;
        if (q.regrow) squashed = true;
      }
      bone.intact = true;
      bone.bent = false;
      bone.rest = bone.rest0.map(r => r.slice());
      if (squashed) {
        // start from the small lumpy shape it came back as; updateInflate swells it out
        bone.all.forEach((i, k) => {
          const [sx, sy] = planRest(person, T, i);
          bone.rest[k][0] += sx - R0[i][0]; bone.rest[k][1] += sy - R0[i][1];
        });
        bone.inflateFrom = bone.rest.map(r => r.slice());
        regrew = true;
      }
      bone.orig = bone.rest.map(r => r.slice());
    });
    if (regrew) person.inflate = { t: 0, dur: 0.9 };
    for (const b of person.bonds) { b.broken = false; b.hp = 1; b.L = b.L0; }
    // a limb that grew back into the floor or a wall lifts the body clear instead of tearing again
    let up = 0, left = 0, right = 0;
    for (const q of P) {
      up = Math.max(up, q.y + q.r - G);
      left = Math.max(left, q.r - q.x);
      right = Math.max(right, q.x + q.r - W);
    }
    const sx = left > 0 ? left : -right;
    if (up > 0 || sx) for (const q of P) { q.y -= up; q.py -= up; q.x += sx; q.px += sx; }
    if (held && held.person === person && T[P[held.idx].bone].grown) held = null;
    Object.assign(person, { blood: 100, dead: false, ko: 0, nBroken: 0, dented: false, dirty: true, regenT: 0, poison: 0, frozen: false, burning: 0,
      heartStopped: false, shockTime: 0, defib: 0 });
    updateCount();
  }

  // best rotation + shift taking a bone from its built position to where it is now
  function fitBone(P, R0, all) {
    const n = all.length;
    let rcx = 0, rcy = 0, ccx = 0, ccy = 0, vx = 0, vy = 0;
    for (const i of all) {
      rcx += R0[i][0]; rcy += R0[i][1]; ccx += P[i].x; ccy += P[i].y;
      vx += P[i].x - P[i].px; vy += P[i].y - P[i].py;
    }
    rcx /= n; rcy /= n; ccx /= n; ccy /= n;
    let a = 0, b = 0;
    for (const i of all) {
      const rx = R0[i][0] - rcx, ry = R0[i][1] - rcy, dx = P[i].x - ccx, dy = P[i].y - ccy;
      a += rx * dx + ry * dy;
      b += rx * dy - ry * dx;
    }
    const L = Math.hypot(a, b) || 1, c = a / L, s = b / L;
    return { c, s, tx: ccx - (c * rcx - s * rcy), ty: ccy - (s * rcx + c * rcy), vx: vx / n, vy: vy / n };
  }

  function removePerson(person) {
    if (person.brain) person.brain.kill();
    const i = people.indexOf(person);
    if (i >= 0) people.splice(i, 1);
    if (held && held.person === person) held = null;
    updateCount();
  }

  function updateCount() {
    const dead = people.filter(p => p.dead).length;
    const brains = people.filter(p => p.brain).length;
    countEl.textContent = people.length + (people.length === 1 ? ' person' : ' people') + (dead ? ' · ' + dead + ' dead' : '') +
      (brains ? ' · ' + brains + (brains === 1 ? ' fly brain' : ' fly brains') : '');
  }

  // ---------- topology: what is still attached to what ----------
  // Split every bone into the pieces its unbroken bonds still hold together. The biggest piece
  // is the bone proper (it carries the joints, muscles and balance) as long as it keeps at least
  // half the bone and both its joint anchors; smaller ones are chips that have broken off.
  function fragments(person) {
    const P = person.pts, bonds = person.bonds;
    person.shattered = false;
    person.bones.forEach((bone, bi) => {
      const all = bone.all, m = all.length, par = new Int32Array(m);
      for (let k = 0; k < m; k++) par[k] = k;
      const find = k => { while (par[k] !== k) { par[k] = par[par[k]]; k = par[k]; } return k; };
      for (const i of all) {
        if (P[i].anchor) continue;
        for (const ob of P[i].bonds) {
          const b = bonds[ob];
          if (b.broken || b.kind !== 'in') continue;
          const ra = find(P[b.a].k), rb = find(P[b.b].k);
          if (ra !== rb) par[ra] = rb;
        }
      }
      // a joint anchor stays with the piece most of its grip is on, and lets go of the rest
      for (const i of all) {
        if (!P[i].anchor) continue;
        const grip = new Map();
        for (const ob of P[i].bonds) {
          const b = bonds[ob];
          if (b.broken || b.kind !== 'anchor') continue;
          const r = find(P[b.a === i ? b.b : b.a].k);
          grip.set(r, (grip.get(r) || 0) + 1);
        }
        let best = -1, bn = 0;
        for (const [r, c] of grip) if (c > bn) { bn = c; best = r; }
        if (best < 0) continue;
        for (const ob of P[i].bonds) {
          const b = bonds[ob];
          if (b.broken || b.kind !== 'anchor') continue;
          if (find(P[b.a === i ? b.b : b.a].k) !== best) b.broken = true;
        }
        par[find(P[i].k)] = best;
      }
      const groups = new Map();
      for (let k = 0; k < m; k++) {
        const r = find(k);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(k);
      }
      bone.frags = [...groups.values()];
      const flesh = f => f.reduce((c, k) => c + (P[all[k]].anchor ? 0 : 1), 0);
      let main = bone.frags[0], mn = -1;
      for (const f of bone.frags) { const c = flesh(f); if (c > mn) { mn = c; main = f; } }
      const anchors = all.filter(i => P[i].anchor).length;
      const mainAnchors = main.filter(k => P[all[k]].anchor).length;
      bone.intact = mn * 2 >= m - anchors && mainAnchors === anchors;
      const inMain = new Set(main);
      bone.frags.forEach((f, fi) => { for (const k of f) { P[all[k]].frag = fi; P[all[k]].chip = !inMain.has(k); } });
      bone.body = main.map(k => all[k]);
      bone.chipped = bone.frags.length > 1 && mn < m - anchors;
      if (!bone.intact) person.shattered = true;
      // a joint can't hang on to a crumb: an anchor left in a piece of a few particles lets go
      for (const f of bone.frags) {
        if (f === main || flesh(f) >= 5) continue;
        for (const k of f) if (P[all[k]].anchor) {
          for (const j of person.joints) if (j.aP === all[k] || j.aC === all[k]) bonds[j.bond].broken = true;
        }
      }
      bone.axisK = main.filter(k => !P[all[k]].anchor);
      if (bone.axisK.length < 2) bone.axisK = all.map((i, k) => k).filter(k => !P[all[k]].anchor);
    });
  }

  function topology(person) {
    const P = person.pts, n = P.length, par = new Int32Array(n);
    fragments(person);
    for (let i = 0; i < n; i++) par[i] = i;
    const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (const b of person.bonds) if (!b.broken) { const ra = find(b.a), rb = find(b.b); if (ra !== rb) par[ra] = rb; }
    for (let i = 0; i < n; i++) P[i].comp = find(i);

    const J = person.joints, B = person.bones;
    for (const j of J) j.active = !person.bonds[j.bond].broken && B[j.p].intact && B[j.c].intact;
    const side = (start, skip) => {
      const seen = new Set([start]), stack = [start], out = [];
      while (stack.length) {
        const b = stack.pop();
        out.push(...B[b].body);
        for (const ji of B[b].joints) {
          if (ji === skip || !J[ji].active) continue;
          const o = J[ji].p === b ? J[ji].c : J[ji].p;
          if (!seen.has(o)) { seen.add(o); stack.push(o); }
        }
      }
      return out;
    };
    J.forEach((j, ji) => {
      if (!j.active) { j.cSide = j.pSide = []; return; }
      j.cSide = side(j.c, ji); j.pSide = side(j.p, ji);
    });
    person.legsOk = LEG_JOINTS.every(ji => J[ji].active);
    person.dirty = false;
  }

  // ---------- physics ----------
  const GRAV = () => 2100 * S;
  const VMAX = 6; // fastest a particle can go, per substep at scale 1 (about 3600 px/s)
  const SUB = 10;
  let held = null; // { person, idx }
  const pointer = { x: 0, y: 0, down: false };
  let lastH = 1 / 600;

  const wrap = a => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
  const isHeld = (person, i) => held && held.person === person && held.idx === i;

  // middle of a row of particles, leaving out any that have broken off
  function rowMid(P, row, prev) {
    let x = 0, y = 0, n = 0;
    for (const i of row) if (!P[i].chip) { x += prev ? P[i].px : P[i].x; y += prev ? P[i].py : P[i].y; n++; }
    if (!n) for (const i of row) { x += prev ? P[i].px : P[i].x; y += prev ? P[i].py : P[i].y; n++; }
    return [x / n, y / n];
  }
  // Which way a bone points: from its first row to its last while it is whole and in shape;
  // otherwise (dented, chipped, swelling back) the turn that best fits what is left of it onto
  // the shape it now has. Rows of a dented bone lean with the dent, and joints judged by them
  // would keep being forced "back" to a wrong angle, shoving a lying body along the floor.
  function boneAxis(P, bone, prev) {
    if (!bone.chipped && !bone.bent && !bone.inflateFrom) {
      const first = bone.grid[0], last = bone.end;
      let dx = 0, dy = 0;
      if (prev) {
        for (const i of last) { dx += P[i].px; dy += P[i].py; }
        for (const i of first) { dx -= P[i].px; dy -= P[i].py; }
      } else {
        for (const i of last) { dx += P[i].x; dy += P[i].y; }
        for (const i of first) { dx -= P[i].x; dy -= P[i].y; }
      }
      return Math.atan2(dy, dx); // the rows are the same length, so sums point the same way as means
    }
    const ks = bone.axisK, R = bone.rest, all = bone.all, n = ks.length;
    let rx = 0, ry = 0, cx = 0, cy = 0;
    for (const k of ks) { const q = P[all[k]]; rx += R[k][0]; ry += R[k][1]; cx += prev ? q.px : q.x; cy += prev ? q.py : q.y; }
    rx /= n; ry /= n; cx /= n; cy /= n;
    let a = 0, b = 0;
    for (const k of ks) {
      const q = P[all[k]], ax = R[k][0] - rx, ay = R[k][1] - ry;
      const dx = (prev ? q.px : q.x) - cx, dy = (prev ? q.py : q.y) - cy;
      a += ax * dx + ay * dy; b += ax * dy - ay * dx;
    }
    return bone.axis0 + Math.atan2(b, a);
  }
  function rawAngle(person, j, prev) {
    return wrap(boneAxis(person.pts, person.bones[j.c], prev) - boneAxis(person.pts, person.bones[j.p], prev));
  }
  const jointAngle = (person, j, prev) => wrap(rawAngle(person, j, prev) - j.rel0);

  // Bend a joint by `corr` radians: turn each side of it as a rigid piece (the whole
  // limb, or with `local` just the two bones), split by inertia so it adds no spin,
  // then re-centre so it adds no push.
  function twist(person, j, corr, maxStep, local, prev) {
    if (corr > maxStep) corr = maxStep; else if (corr < -maxStep) corr = -maxStep;
    if (!corr || !j.cSide.length) return;
    const cSide = local ? person.bones[j.c].body : j.cSide, pSide = local ? person.bones[j.p].body : j.pSide;
    // (with `prev`, the same turn is given to where the particles were a step ago, which
    // changes how fast the joint is turning without moving anything)
    const X = prev ? 'px' : 'x', Y = prev ? 'py' : 'y';
    const P = person.pts, A = P[j.aP], B = P[j.aC];
    const ox = (A[X] + B[X]) / 2, oy = (A[Y] + B[Y]) / 2;
    let Ic = 0, Ie = 0;
    for (const i of cSide) Ic += (P[i][X] - ox) ** 2 + (P[i][Y] - oy) ** 2;
    for (const i of pSide) Ie += (P[i][X] - ox) ** 2 + (P[i][Y] - oy) ** 2;
    const tc = corr * Ie / (Ic + Ie || 1), te = corr - tc;
    let sx = 0, sy = 0;
    const turn = (list, a) => {
      const c = Math.cos(a), s = Math.sin(a);
      for (const i of list) {
        const q = P[i], dx = q[X] - ox, dy = q[Y] - oy;
        const nx = ox + dx * c - dy * s, ny = oy + dx * s + dy * c;
        sx += nx - q[X]; sy += ny - q[Y]; q[X] = nx; q[Y] = ny;
      }
    };
    turn(cSide, -tc); turn(pSide, te);
    const n = cSide.length + pSide.length;
    sx /= n; sy /= n;
    for (const i of cSide) { P[i][X] -= sx; P[i][Y] -= sy; }
    for (const i of pSide) { P[i][X] -= sx; P[i][Y] -= sy; }
  }

  // `cap` is the most this can push, in multiples of gravity: people are only so strong
  function springBone(person, bone, tx, ty, k, kd, cap) {
    const P = person.pts;
    let cx = 0, cy = 0, vx = 0, vy = 0;
    for (const i of bone.body) { const q = P[i]; cx += q.x; cy += q.y; vx += q.x - q.px; vy += q.y - q.py; }
    const n = bone.body.length;
    let dx = (tx - cx / n) * k - (vx / n) * kd, dy = (ty - cy / n) * k - (vy / n) * kd;
    const lim = cap * GRAV() * lastH * lastH, m = Math.hypot(dx, dy);
    if (m > lim) { dx *= lim / m; dy *= lim / m; }
    for (const i of bone.body) { P[i].x += dx; P[i].y += dy; }
  }

  function impact(person, i, speed, x, y) {
    const q = person.pts[i];
    if (person.mind) feel(person, i, speed, x);
    const lim = (q.bone === HEAD ? 780 : 1150) * S;
    if (speed > lim * 0.55) puff(x, y, Math.min(8, Math.floor(speed / (220 * S))));
    // stumbling while trying to get up shouldn't knock them out again
    if (speed > lim && !(person.fallT > 1.6 && speed < lim * 1.6)) {
      person.ko = Math.max(person.ko, 2.5 + Math.min(4, (speed - lim) / (500 * S)));
    }
    // every hit past a firm knock bruises: light hits go purple, heavier ones red, then near black
    if (speed > 700 * S) {
      const add = (speed - 700 * S) / (3000 * S);
      q.hurt = Math.min(1.2, q.hurt + add);
      for (const bi of q.bonds) {
        const o = person.bonds[bi], other = person.pts[o.a === i ? o.b : o.a];
        if (!other.anchor) other.hurt = Math.min(1.2, other.hurt + add * 0.4);
      }
    }
    // a hard enough hit lets the bone dent where it landed, for a few substeps
    if (speed > 1000 * S) q.soft = Math.max(q.soft || 0, Math.min(1, (speed - 1000 * S) / (1800 * S)));
    // hard hits crush the flesh around the point of impact, and a little beyond it
    const excess = speed - (q.frost > 0.5 ? 650 : 1500) * S;
    if (excess > 0) {
      const d = Math.min(2.2, excess / (1100 * S));
      for (const bi of q.bonds) {
        damage(person, bi, d);
        const o = person.bonds[bi], other = o.a === i ? o.b : o.a;
        if (o.kind === 'in') for (const b2 of person.pts[other].bonds) damage(person, b2, d * 0.35);
      }
      if (d > 0.4) spray(x, y, 0, -100 * S, Math.min(8, Math.round(d * 4)));
    }
  }

  function damage(person, bi, d) {
    const b = person.bonds[bi];
    if (b.broken || b.kind === 'anchor') return;
    // frozen flesh is brittle as glass: it shatters, and ignores the grain of the lumps
    const P = person.pts;
    if (b.kind === 'in' && P[b.a].frost > 0.5 && P[b.b].frost > 0.5) {
      b.hp -= d * 1.1;
      if (b.hp <= 0) breakBond(person, bi);
      return;
    }
    b.hp -= d * b.dmg;
    if (b.hp <= 0) breakBond(person, bi);
  }

  function breakBond(person, bi) {
    const b = person.bonds[bi], P = person.pts;
    if (b.broken) return;
    b.broken = true;
    person.dirty = true;
    person.nBroken++;
    const A = P[b.a], B = P[b.b];
    for (const ei of [b.a, b.b]) {
      // a torn joint wounds the flesh around its anchor, not the invisible anchor itself
      for (const t of P[ei].anchor ? P[ei].nbrs : [ei]) {
        const q = P[t];
        q.wound = 1; q.torn = true; q.stain = 1; q.hurt = Math.max(q.hurt, 1);
        for (const ob of q.bonds) {
          const o = person.bonds[ob], other = P[o.a === t ? o.b : o.a];
          if (!other.anchor) { other.stain = Math.max(other.stain, 0.6); other.hurt = Math.max(other.hurt, 0.6); }
        }
      }
    }
    const vx = ((A.x - A.px) + (B.x - B.px)) / 2 / lastH, vy = ((A.y - A.py) + (B.y - B.py)) / 2 / lastH;
    spray((A.x + B.x) / 2, (A.y + B.y) / 2, vx * 0.3, vy * 0.3, b.kind === 'joint' ? 16 : Math.random() < 0.4 ? 1 : 0);
    // a crack runs on: the bonds next to a broken one take some of its load, a little at random,
    // so pieces break off along ragged lines
    if (b.kind === 'in' && crackDepth < 3) {
      crackDepth++;
      for (const e of [b.a, b.b]) for (const ob of P[e].bonds) {
        if (person.bonds[ob].kind === 'in') damage(person, ob, 0.15 + Math.random() * 0.45);
      }
      crackDepth--;
    }
  }
  let crackDepth = 0;

  function spray(x, y, vx, vy, n, c) {
    for (let i = 0; i < n && drops.length < 1600; i++) {
      drops.push({ x, y, vx: vx + (Math.random() - 0.5) * 380 * S, vy: vy - Math.random() * 320 * S, s: (0.8 + Math.random() * 1.2) * S, c });
    }
  }

  function puff(x, y, n) {
    for (let i = 0; i < n; i++) {
      dust.push({ x, y, vx: (Math.random() - 0.5) * 180 * S, vy: -Math.random() * 140 * S, life: 1, s: (2 + Math.random() * 3) * S });
    }
  }

  let tick = 0;
  function substep(h) {
    lastH = h;
    tick++;
    const g = GRAV();
    for (const person of people) {
      if (person.dirty) topology(person);
      const P = person.pts;
      for (let i = 0; i < P.length; i++) {
        const q = P[i];
        if (q.ghost) continue;                    // melted into blood, flying home
        if (isHeld(person, i)) {
          const nx = q.x + (pointer.x - q.x) * 0.35, ny = q.y + (pointer.y - q.y) * 0.35;
          q.ivx = nx - q.x; q.ivy = ny - q.y;
          q.px = q.x; q.py = q.y; q.x = nx; q.y = ny;
          continue;
        }
        let vx = (q.x - q.px) * 0.9995, vy = (q.y - q.py) * 0.9995;
        // nothing moves more than about two of its own widths in one step, or it would sink so far
        // into the floor or another body that pushing it back out would fling it away
        const sp = Math.hypot(vx, vy);
        if (sp > VMAX * S) { vx *= VMAX * S / sp; vy *= VMAX * S / sp; }
        // how fast this particle is really travelling, before joints and bonds nudge it;
        // impacts are judged on this so constraint corrections never count as hits
        q.ivx = vx; q.ivy = vy + g * h * h;
        q.px = q.x; q.py = q.y;
        if (q.soft) q.soft = q.soft > 0.01 ? q.soft * 0.7 : 0;
        q.x += vx; q.y += vy + g * h * h;
      }
      // a joint tears when one side is stopped dead while the other keeps going:
      // judge that on how differently its two anchors are travelling
      for (const j of person.joints) {
        const b = person.bonds[j.bond];
        if (b.broken) continue;
        const A = P[j.aP], C = P[j.aC];
        if (A.ghost || C.ghost) continue;
        const rel = Math.hypot(A.ivx - C.ivx, A.ivy - C.ivy) / h;
        if (rel > 1500 * S) damage(person, j.bond, (rel - 1500 * S) / (800 * S));
      }
      // balance controller
      const c = person.ctrl, B = person.bones;
      if (c > 0 && person.grounded && person.legsOk && !person.dead && (!person.frozen || person.statue) && !(held && held.person === person)) {
        const standing = person.standing;
        // a standing person keeps their balance over the spot where they stood up, so they don't wander
        if (standing && person.walkV) person.standX = Math.max(30 * S, Math.min(W - 30 * S, person.standX + person.walkV * h));
        const cx = standing ? person.standX : rowMid(P, B[BELLY].end)[0];
        const k = (standing ? 0.0016 : 0.0007) * c, kd = 0.05 * c;
        // standing only needs to steady the body; getting up may push a little harder,
        // but never enough to lift the whole body off the floor
        const cap = standing ? 1.6 : 2.2;
        // heights ease toward the posture's, so sitting down or getting up takes a moment
        const goal = POSES[standing ? person.posture : 'stand'].h;
        const ht = person.htCur || (person.htCur = goal.slice());
        for (let n = 0; n < 3; n++) ht[n] += (goal[n] - ht[n]) * 0.004;
        springBone(person, B[HEAD], cx + person.dir * S, G - ht[0] * S, k, kd, cap);
        springBone(person, B[CHEST], cx, G - ht[1] * S, k, kd, cap);
        springBone(person, B[BELLY], cx, G - ht[2] * S, k * 0.8, kd, cap);
        if (standing && person.walkV) stepLegs(person, h);
        if (!standing) {
          springBone(person, B[SHIN_F], cx + 2 * S * person.dir, G - 19 * S, k * 0.5, kd * 0.5, 1);
          springBone(person, B[SHIN_B], cx - 2 * S * person.dir, G - 19 * S, k * 0.5, kd * 0.5, 1);
        }
      }
      if (tick % 2 === 0) muscles(person);
    }
    for (let it = 0; it < 3; it++) for (const person of people) solveBody(person);
    collideWorld(h);
    collideAll(h);
    stepProps(h);
    for (const person of people) checkBreaks(person);
  }

  function solveBody(person) {
    const P = person.pts;
    // bonds inside a piece need no solving: holding the piece's shape keeps them all
    for (const b of person.links) {
      if (b.broken) continue;
      const A = P[b.a], B = P[b.b];
      if (A.ghost || B.ghost) continue;
      // the held point is a soft pin: heavier than the rest, but not immovable
      const wa = isHeld(person, b.a) ? 0.2 : 1, wb = isHeld(person, b.b) ? 0.2 : 1;
      const dx = B.x - A.x, dy = B.y - A.y;
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) continue;
      const diff = (d - b.L) / d / (wa + wb);
      A.x += dx * diff * wa; A.y += dy * diff * wa;
      B.x -= dx * diff * wb; B.y -= dy * diff * wb;
    }
    for (const bone of person.bones) if (!bone.ghost) for (const f of bone.frags) keepShape(person, bone, f);
    // joint limits: push back toward the nearer limit, never the long way round
    for (const j of person.joints) {
      // a chipped bone's axis wobbles as it is measured, and forcing a limit on it would keep
      // jerking the pieces around: limits hold only between whole bones
      if (!j.active || person.bones[j.p].chipped || person.bones[j.c].chipped) continue;
      const rel = jointAngle(person, j, false);
      if (rel >= j.lo && rel <= j.hi) continue;
      const dLo = wrap(rel - j.lo), dHi = wrap(rel - j.hi);
      // only the two bones at the joint turn, so a limit can't fling a whole limb
      const low = Math.abs(dLo) < Math.abs(dHi);
      twist(person, j, (low ? dLo : dHi) * 0.5, 0.08, true);
      // and the joint stops dead at its limit instead of bouncing off it: whatever turning
      // speed it has further into the limit is taken away
      const spin = wrap(jointAngle(person, j, false) - jointAngle(person, j, true));
      if (low ? spin < 0 : spin > 0) twist(person, j, -spin, 0.3, true, true);
    }
  }

  const STRAIN = 4.5; // how far out of shape (at scale 1) a particle can be wrenched before bonds crack

  // Pull a bone back to its own shape: find the rotation that best fits its rest
  // layout to where its particles are now, then move them onto that. Bonds alone
  // only hold lengths, so a hard knock could fold a bone inside out; this can't.
  // (ks: the piece of the bone to hold, as indexes into bone.all)
  function keepShape(person, bone, ks) {
    const P = person.pts, all = bone.all, R = bone.rest, n = ks.length;
    if (n < 2 || P[all[ks[0]]].ghost) return;
    // Joint anchors count for several particles, so a joint pulls on a finely built bone as
    // firmly as it would on a coarse one: the body needs that to get up and stand. Only while
    // it is doing so, though (while it has any control of itself): the extra pull has no real
    // mass behind it, and on a limp, dented or broken body it feeds on itself, shoving the body
    // along the floor or flinging pieces about.
    const AW = bone.chipped || person.shattered || !person.ctrl ? 1 : bone.anchorW;
    let cx = 0, cy = 0, rmx = 0, rmy = 0, wsum = 0;
    for (const k of ks) {
      const w = P[all[k]].anchor ? AW : 1;
      cx += P[all[k]].x * w; cy += P[all[k]].y * w; rmx += R[k][0] * w; rmy += R[k][1] * w; wsum += w;
    }
    cx /= wsum; cy /= wsum; rmx /= wsum; rmy /= wsum;
    let a = 0, b = 0;
    for (const k of ks) {
      const w = P[all[k]].anchor ? AW : 1;
      const dx = P[all[k]].x - cx, dy = P[all[k]].y - cy, rx = R[k][0] - rmx, ry = R[k][1] - rmy;
      a += (rx * dx + ry * dy) * w;
      b += (rx * dy - ry * dx) * w;
    }
    const L = Math.hypot(a, b) || 1, c = a / L, s = b / L;
    let dented = false, strained = null;
    // a part swelling back to size changes shape, not speed: its particles keep only the piece's
    // own (gentle) motion, or the swelling would kick off the floor and throw the body about
    let ivx = 0, ivy = 0;
    if (bone.inflateFrom) {
      for (const k of ks) { ivx += P[all[k]].x - P[all[k]].px; ivy += P[all[k]].y - P[all[k]].py; }
      ivx /= n; ivy /= n;
      const m = Math.hypot(ivx, ivy), cap = 0.6 * S;
      if (m > cap) { ivx *= cap / m; ivy *= cap / m; }
    }
    for (const k of ks) {
      const q = P[all[k]], i = all[k];
      // a particle that was just hit hard gives way: part of how far it has been pushed
      // out of shape becomes the bone's new shape, so the dent stays
      if (q.soft > 0.01 && !q.anchor) {
        const dx = q.x - (cx + c * (R[k][0] - rmx) - s * (R[k][1] - rmy)), dy = q.y - (cy + s * (R[k][0] - rmx) + c * (R[k][1] - rmy));
        let nx = R[k][0] + (c * dx + s * dy) * q.soft, ny = R[k][1] + (-s * dx + c * dy) * q.soft;
        const ox = bone.orig[k][0], oy = bone.orig[k][1], d = Math.hypot(nx - ox, ny - oy);
        if (d > bone.maxDent) { nx = ox + (nx - ox) * bone.maxDent / d; ny = oy + (ny - oy) * bone.maxDent / d; }
        if (Math.abs(nx - R[k][0]) + Math.abs(ny - R[k][1]) > 0.01) { R[k][0] = nx; R[k][1] = ny; q.bent = true; dented = true; }
      }
      const rx = R[k][0] - rmx, ry = R[k][1] - rmy;
      const tx = cx + c * rx - s * ry, ty = cy + s * rx + c * ry;
      // wrenched far out of shape in one step (bent over something, stopped dead at one end):
      // the bonds there crack
      if (!q.anchor && !q.soft && !bone.inflateFrom && !isHeld(person, i)) { // (a part swelling back isn't being wrenched)
        const e = Math.hypot(q.x - tx, q.y - ty);
        if (e > STRAIN * S) (strained || (strained = [])).push(i, e);
      }
      q.x = tx; q.y = ty;
      if (bone.inflateFrom) { q.px = tx - ivx; q.py = ty - ivy; }
    }
    // Pushing a piece out of the floor or a wall moves it without changing where it was, and
    // that turns into speed: a hard or slanted landing would fling it back up or set it spinning
    // like a top. So no part of a piece touching the floor or a wall may rebound faster than a
    // little.
    let touch = 0;
    for (const k of ks) touch |= P[all[k]].touch || 0;
    const floor = touch & 1, left = touch & 2, right = touch & 4;
    if (floor || left || right) {
      const lim = 0.5 * S;
      for (const k of ks) {
        const q = P[all[k]];
        if (floor && q.py - q.y > lim) q.py = q.y + lim;
        if (left && q.x - q.px > lim) q.px = q.x - lim;
        if (right && q.px - q.x > lim) q.px = q.x + lim;
      }
    }
    if (strained) for (let u = 0; u < strained.length; u += 2) {
      const d = (strained[u + 1] / S - STRAIN) * 0.12;
      for (const ob of P[strained[u]].bonds) damage(person, ob, d);
    }
    if (dented) {
      bone.bent = true;
      // keep the rest shape centred, or every fit would nudge the whole bone sideways
      let mx = 0, my = 0;
      for (const r of R) { mx += r[0]; my += r[1]; }
      mx /= n; my /= n;
      for (let k = 0; k < n; k++) { R[k][0] -= mx; R[k][1] -= my; bone.orig[k][0] -= mx; bone.orig[k][1] -= my; }
      // bonds inside the bone take on the new shape too, so they don't fight it
      person.dented = true;
      for (const b of person.bonds) {
        if (b.kind !== 'in' || b.bone !== person.bones.indexOf(bone) || !(P[b.a].bent || P[b.b].bent)) continue;
        const ka = all.indexOf(b.a), kb = all.indexOf(b.b);
        b.L = Math.hypot(R[ka][0] - R[kb][0], R[ka][1] - R[kb][1]);
      }
      for (const i of all) P[i].bent = false;
    }
  }

  // Frozen solid: every joint is held at the angle it froze at, firmly but the way muscles
  // hold a pose (a hard lock fought the collisions and shook the body apart)
  function holdFrozen(person) {
    for (const j of person.joints) {
      if (!j.active || j.lock === undefined || j.lock === null) continue;
      const rel = rawAngle(person, j, false), spin = wrap(rel - rawAngle(person, j, true));
      twist(person, j, wrap(rel - j.lock) * 0.5 + spin * 0.5, 0.02, true);
    }
  }

  // muscles: a damped angular spring toward the standing pose, once per substep
  function muscles(person) {
    if (person.frozen) { holdFrozen(person); return; }
    if (person.ko > 0 || person.dead) return;
    const heldHere = held && held.person === person;
    // full strength only to hold a standing pose; held they go nearly limp, lying or getting up
    // they are weak. Muscles also turn joints slowly, so they can never kick the body off the floor.
    const strength = heldHere ? 0.08 : person.standing ? Math.max(0.25, person.ctrl) : 0.1 + 0.9 * person.ctrl;
    const maxStep = person.standing ? 0.01 : 0.004 + 0.006 * person.ctrl;
    let pose = null;
    if (!heldHere && person.standing) {
      // ease joint targets toward the plan: quick for walking steps, slow for changing posture
      const plan = posePlan(person), cur = person.poseCur || (person.poseCur = POSES.stand.j.slice());
      const rate = person.walkV ? 0.05 : 0.01;
      for (let n = 0; n < cur.length; n++) cur[n] += (plan[n] - cur[n]) * rate;
      pose = cur;
    } else person.poseCur = null;
    for (let ji = 0; ji < person.joints.length; ji++) {
      const j = person.joints[ji];
      if (!j.active) continue;
      const rel = jointAngle(person, j, false);
      const spin = wrap(rel - jointAngle(person, j, true));
      const tgt = pose ? pose[ji] * person.dir : j.tgt;
      // runs every other substep, so it pushes twice as hard
      const corr = (wrap(rel - tgt) * MUSCLE[j.grp] * 2 + spin * 0.25) * strength;
      if (Math.abs(corr) > 1e-4) twist(person, j, corr, maxStep, true);
    }
  }

  // ---------- movement ----------
  // Joint targets per posture, in the order of JOINTS (neck, waist, hipF, kneeF, hipB, kneeB,
  // shoulderF, elbowF, shoulderB, elbowB), for a person facing right; and the heights (at
  // scale 1) the balance controller holds the head, chest and belly at. For a squat with the
  // thighs a rad forward and shins b rad back, the pelvis sits at 36cos(a) + 30cos(b) + 4.
  const POSES = {
    stand:  { j: [0, 0, 0, 0, 0, 0, -0.06, -0.25, 0.02, -0.2], h: [140.5, 113, 82] },
    squat:  { j: [0, 0, -0.9, 1.8, -0.9, 1.8, -0.5, -0.6, -0.4, -0.6], h: [115, 88, 57] },
    crouch: { j: [-0.2, 0, -1.25, 2.5, -1.25, 2.5, -0.5, -0.1, -0.4, -0.1], h: [100, 73, 42] },
    cower:  { j: [-0.4, 0, -1.1, 2.2, -1.1, 2.2, -2.5, -2.0, -2.4, -2.1], h: [106, 79, 48] },
    flinch: { j: [-0.3, 0, -0.4, 0.8, -0.4, 0.8, -2.2, -2.0, -2.0, -2.0], h: [130, 103, 72] },
  };

  // what the muscles aim for right now: the posture, bent by the gait while walking and a
  // rubbing hand when soothing a hurt
  function posePlan(person) {
    const base = POSES[person.posture].j, t = base.slice();
    if (person.walkV && person.posture === 'stand') {
      const m = Math.sign(person.walkV) * person.dir;          // +1 walking the way they face
      const ph = person.gait % 1, swingF = ph < 0.5, s = Math.sin(Math.PI * ((ph % 0.5) * 2));
      const reach = Math.min(1, Math.abs(person.walkV) / (160 * S));
      const sw = -(0.35 + 0.25 * reach) * m, st = (0.25 + 0.15 * reach) * m;
      t[2] = swingF ? sw : st; t[3] = swingF ? 0.9 * s : 0.05;
      t[4] = swingF ? st : sw; t[5] = swingF ? 0.05 : 0.9 * s;
      t[6] = -0.06 + (swingF ? 0.35 : -0.35) * m * reach;       // arms swing against the legs
      t[8] = 0.02 + (swingF ? -0.35 : 0.35) * m * reach;
    }
    if (person.rubT > 0) {
      // bring a hand to where it hurts and rub: head up high, body across the chest, legs low
      const part = person.rubPart, useBack = part === 7 || part === 8;
      const [sh, el] = part === HEAD ? [-2.4, -1.6] : part === CHEST || part === BELLY ? [-0.9, -1.9] : [-0.3, -0.2];
      const si = useBack ? 8 : 6;
      t[si] = sh; t[si + 1] = el + Math.sin(performance.now() / 1000 * 18) * 0.35;
    }
    return t;
  }

  // Walking: while the balance point slides along, legs take turns. The swinging foot is
  // lifted and carried to a spot ahead; the planted one stays put by friction. Every push goes
  // through the capped balance springs, so nobody can sprint or bound unrealistically.
  function stepLegs(person, h) {
    const v = Math.abs(person.walkV), stepT = Math.max(0.28, 0.55 - v / (600 * S));
    person.gait += h / (stepT * 2);
    const ph = person.gait % 1, swing = ph < 0.5 ? SHIN_F : SHIN_B, local = (ph % 0.5) * 2;
    const stride = Math.min(60, 25 + v / (4 * S)) * S * Math.sign(person.walkV);
    const lift = Math.sin(Math.PI * local) * 12 * S;
    springBone(person, person.bones[swing], person.standX + stride * 0.5, G - 19 * S - lift, 0.004, 0.08, 1.8);
  }

  function turnAround(person) {
    person.dir = -person.dir;
    for (const j of person.joints) { const lo = j.lo; j.lo = -j.hi; j.hi = -lo; j.tgt = -j.tgt; }
  }

  // a short startled hop away from something: about 1.5 times gravity, well short of a leap
  function hopAway(person, awayX) {
    const P = person.pts, main = P[person.bones[CHEST].core].comp;
    const vx = Math.sign(awayX || -person.dir) * 170 * S, vy = -190 * S;
    for (const q of P) if (q.comp === main) { q.px -= vx * lastH; q.py -= vy * lastH; }
  }

  // joints tear when pulled too far apart (pieces themselves break by strain and impact)
  function checkBreaks(person) {
    const P = person.pts;
    for (const i of person.jointBonds) {
      const b = person.bonds[i];
      if (b.broken || P[b.a].ghost || P[b.b].ghost) continue;
      const d = Math.hypot(P[b.b].x - P[b.a].x, P[b.b].y - P[b.a].y);
      const give = Math.max(0.35, b.hp);
      // bones are rigid now, so a joint soaks up the whole jolt and may gape a little before tearing
      // a joint on a broken bone has nothing firm to hold and gives way much sooner
      const j = person.joints[b.joint], loose = !person.bones[j.p].intact || !person.bones[j.c].intact;
      if (d > b.tear * 2 * S * give * (loose ? 0.3 : 1)) breakBond(person, i);
    }
  }

  function collideWorld(h) {
    for (const person of people) {
      const P = person.pts;
      for (let i = 0; i < P.length; i++) {
        const q = P[i];
        if (q.anchor || q.ghost) continue;
        const vx = q.x - q.px, vy = q.y - q.py;
        // only a fresh contact counts as a hit; weight resting on the floor is not an impact
        const was = q.contact;
        q.contact = false; q.touch = 0;
        if (q.y > G - q.r) {
          q.contact = true; q.touch = 1;
          if (q.ivy > 0 && !was) impact(person, i, q.ivy / h, q.x, G);
          q.y = G - q.r;
          // a little bounce, never much: a loose chip must not spring off the floor like a ball
          q.py = q.y + Math.min(vy * 0.15, 0.6 * S);
          // static friction holds a slow contact exactly where it was; faster ones slide and slow
          // down. Feet of someone standing still grip harder, so crouching doesn't skid them away.
          const grip = person.standing && !person.walkV && (q.bone === SHIN_F || q.bone === SHIN_B) ? 1.5 : 0.35;
          if (Math.abs(vx) < grip * S) q.x = q.px;
          else q.px = q.x - vx * 0.9;
        }
        if (q.x < q.r) {
          q.contact = true; q.touch |= 2;
          if (q.ivx < 0 && !was) impact(person, i, -q.ivx / h, 0, q.y);
          q.x = q.r; q.px = q.x + Math.max(vx * 0.2, -0.8 * S);
        } else if (q.x > W - q.r) {
          q.contact = true; q.touch |= 4;
          if (q.ivx > 0 && !was) impact(person, i, q.ivx / h, W, q.y);
          q.x = W - q.r; q.px = q.x + Math.min(vx * 0.2, 0.8 * S);
        }
        if (q.y < -H) { q.y = -H; q.py = q.y; }
      }
      // whatever is still joined to something on the floor can't spring up off it fast either:
      // a hard landing would otherwise rebound through the joints and toss the body high
      const down = new Set();
      for (const q of P) if (q.touch & 1) down.add(q.comp);
      if (down.size) {
        const lim = 1.2 * S;
        for (let i = 0; i < P.length; i++) {
          const q = P[i];
          if (down.has(q.comp) && q.py - q.y > lim && !isHeld(person, i)) q.py = q.y + lim;
        }
      }
    }
  }

  // particle vs particle through a spatial hash; pieces of the same body only
  // collide once they have been torn apart
  const grid = new Map();
  const NB = [[1, 0], [-1, 1], [0, 1], [1, 1]];
  function collideAll(h) {
    const cell = 10 * S;
    grid.clear();
    for (let pi = 0; pi < people.length; pi++) {
      const P = people[pi].pts;
      for (let i = 0; i < P.length; i++) {
        const q = P[i];
        if (q.anchor || q.ghost || (q.core && !q.chip && !q.torn)) continue; // the inside of a piece can't be touched
        const k = (Math.floor(q.x / cell) + 4000) * 16384 + (Math.floor(q.y / cell) + 8000);
        let arr = grid.get(k);
        if (!arr) grid.set(k, arr = []);
        arr.push(pi, i);
      }
    }
    for (const [k, arr] of grid) {
      for (let a = 0; a < arr.length; a += 2) for (let b = a + 2; b < arr.length; b += 2) pair(arr[a], arr[a + 1], arr[b], arr[b + 1], h);
      const kx = Math.floor(k / 16384), ky = k - kx * 16384;
      for (const [ox, oy] of NB) {
        const other = grid.get((kx + ox) * 16384 + ky + oy);
        if (!other) continue;
        for (let a = 0; a < arr.length; a += 2) for (let b = 0; b < other.length; b += 2) pair(arr[a], arr[a + 1], other[b], other[b + 1], h);
      }
    }
  }

  function pair(pa, i, pb, k, h) {
    const A = people[pa], B = people[pb];
    const p = A.pts[i], q = B.pts[k];
    if (pa === pb && p.comp === q.comp && (p.bone !== q.bone || p.frag === q.frag)) return;
    const dx = q.x - p.x, dy = q.y - p.y;
    const rr = p.r + q.r + S;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr || d2 === 0) return;
    const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
    if (pa === pb) {
      // pieces of one body only knock gently against each other, over a smaller reach: freshly
      // broken ones start out packed together, and full-size pushes would blow them apart
      const r2 = (p.r + q.r) * 0.5;
      if (d >= r2) return;
      const push = Math.min(r2 - d, 0.3 * S) * 0.5;
      p.x -= nx * push; p.y -= ny * push; q.x += nx * push; q.y += ny * push;
      // shifted, not shoved: pieces held overlapping by a joint would otherwise gain speed every step
      p.px -= nx * push; p.py -= ny * push; q.px += nx * push; q.py += ny * push;
      return;
    }
    const rv = (p.ivx - q.ivx) * nx + (p.ivy - q.ivy) * ny;
    if (rv > 0) {
      const sp = rv / h * 0.8, mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      impact(A, i, sp, mx, my);
      impact(B, k, sp, mx, my);
    }
    const wa = isHeld(A, i) ? 0.2 : 1, wb = isHeld(B, k) ? 0.2 : 1;
    // bodies that end up inside each other ease apart over a few steps instead of
    // being kicked out at once, which would jolt their joints hard enough to tear
    const push = Math.min(rr - d, 1.2 * S) / (wa + wb);
    p.x -= nx * push * wa; p.y -= ny * push * wa;
    q.x += nx * push * wb; q.y += ny * push * wb;
  }

  function updateStates(dt) {
    let changed = false;
    updateSpawnDrag(dt);
    updateFuses(dt);
    for (const pr of props) if (pr.blood > 0) pr.blood = Math.max(0, pr.blood - dt * 0.01);
    for (const person of people) {
      if (person.dirty) topology(person);
      const P = person.pts, B = person.bones, J = person.joints;
      const heldHere = held && held.person === person;

      if (person.regen) {
        // wounds close, blood comes back, damage mends; anything torn off grows back after a moment
        person.blood = Math.min(100, person.blood + dt * 25);
        for (const b of person.bonds) if (!b.broken && b.hp < 1) b.hp = Math.min(1, b.hp + dt * 0.6);
        for (const q of P) { q.wound = Math.max(0, q.wound - dt * 2); q.stain = Math.max(0, q.stain - dt * 0.4); q.hurt = Math.max(0, q.hurt - dt * 0.6); }
        if (person.ko > 1) person.ko = 1;
        if (person.dead || person.nBroken || person.dented) {
          person.regenT += dt;
          if (person.regenT > 1.5) { heal(person); person.regenT = 0; continue; }
        } else person.regenT = 0;
      }
      // bleeding: open wounds pour, badly hurt (red and darker) flesh seeps (a body is some 230
      // particles, so each one only loses a little)
      const floor = person.immortal ? 1 : 0; // someone who can't die keeps bleeding, but never runs dry
      if (person.reform) updateReform(person, dt);
      if (person.inflate) updateInflate(person, dt);
      for (const q of P) {
        if (q.fresh > 0 && !person.inflate) q.fresh = Math.max(0, q.fresh - dt * 0.8);
        if (q.anchor || q.ghost) continue;
        if (q.wound > 0) {
          q.wound = Math.max(0, q.wound - dt * 0.1);
          if (Math.random() < q.wound * dt * 12) {
            spray(q.x, q.y, (q.x - q.px) / lastH * 0.5, (q.y - q.py) / lastH * 0.5, 1);
            person.blood = Math.max(floor, person.blood - 0.025);
          }
        }
        if (q.hurt > 0.45 && Math.random() < (q.hurt - 0.45) * dt * 6) {
          spray(q.x, q.y, (q.x - q.px) / lastH * 0.5, (q.y - q.py) / lastH * 0.5, 1);
          person.blood = Math.max(floor, person.blood - 0.012);
          q.stain = Math.min(1, q.stain + 0.08);
        }
      }
      updateBurnFrostPoison(person, dt, floor);
      updateShock(person, dt, floor);
      if (person.immortal && person.dead) { person.dead = false; changed = true; }
      if (!person.dead && !person.immortal && (!J[NECK].active || !J[WAIST].active || person.blood <= 0 || person.heartStopped)) {
        person.dead = true; changed = true;
      }

      const [nx, ny] = rowMid(P, B[CHEST].grid[0]), [px, py] = rowMid(P, B[BELLY].end);
      const up = -(ny - py) / (Math.hypot(nx - px, ny - py) || 1);
      const main = P[B[CHEST].core].comp;
      let low = -1e9, sp = 0;
      for (const q of P) {
        if (q.comp !== main || q.anchor) continue;
        if (q.y > low) low = q.y;
        sp += Math.abs(q.x - q.px) + Math.abs(q.y - q.py);
      }
      const nearGround = low > G - 14 * S;
      const feetDown = person.legsOk &&
        Math.max(rowMid(P, B[SHIN_F].end)[1], rowMid(P, B[SHIN_B].end)[1]) > G - 14 * S;
      person.grounded = person.standing ? feetDown : nearGround;

      if (person.dead || !person.legsOk) {
        person.ctrl = 0; person.standing = false; person.fallT = 0;
        if (person.ko > 0) person.ko -= dt;
      } else if (person.ko > 0) {
        person.ko -= dt;
        person.ctrl = 0; person.standing = false; person.fallT = 0;
      } else if (heldHere) {
        person.ctrl = 0; person.standing = false; person.fallT = 0;
      } else if (up > 0.6 && feetDown && (person.standing || person.ctrl > 0.5)) {
        if (!person.standing) {
          person.standX = (rowMid(P, B[SHIN_F].end)[0] + rowMid(P, B[SHIN_B].end)[0]) / 2;
        }
        person.standing = true; person.fallT = 0;
        person.ctrl = Math.min(1, person.ctrl + dt * 2);
      } else if (person.standing && up > 0.4 && feetDown) {
        // wobbling but still fighting to stay up
      } else {
        person.standing = false;
        if (nearGround && sp < 60 * S) person.fallT += dt;
        else if (!nearGround) person.fallT = 0;
        if (person.fallT > 1.6) person.ctrl = Math.min(1, (person.fallT - 1.6) / 1.4);
        else person.ctrl = 0;
        if (person.fallT > 9) person.fallT = 0.5; // give up this try, rest a bit
      }
      // frozen stiff: no control at all; badly poisoned: too weak to stand
      if (person.frozen) {
        // a statue stays up until something knocks it over (or tips it well off balance)
        if (person.statue && (person.ko > 0 || up < 0.75 || heldHere)) person.statue = false;
        person.ctrl = person.statue ? 1 : 0; person.standing = !!person.statue; person.fallT = 0; person.walkV = 0;
      }
      else if (person.poison > 0.45) person.ctrl = Math.min(person.ctrl, Math.max(0, 1.9 - person.poison * 2.2));
    }
    updateEnvironment(dt);
    updatePower(dt);
    if (changed) updateCount();
    updateMinds(dt);
    updatePanel(dt);

    for (let i = dust.length - 1; i >= 0; i--) {
      const d = dust[i];
      d.life -= dt * 2.2;
      d.vy += 500 * S * dt;
      d.x += d.vx * dt; d.y = Math.min(G - 1, d.y + d.vy * dt);
      if (d.life <= 0) dust.splice(i, 1);
    }
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.vy += 1700 * S * dt;
      d.x += d.vx * dt; d.y += d.vy * dt;
      if (d.y >= G) {
        stains.push({ x: d.x, w: d.s * (1.5 + Math.random() * 2.5), c: d.c });
        if (stains.length > 900) stains.shift();
        drops.splice(i, 1);
      } else if (d.x < 0 || d.x > W) drops.splice(i, 1);
    }
  }

  // ---------- drawing ----------
  // Bones drawn in one call share a single outline: stroking every triangle and then
  // filling them all hides the inner edges, so only the silhouette is left.
  function drawBones(person, list) {
    const P = person.pts;
    const BD = person.bonds, path = new Path2D(), used = new Set();
    for (const bi of list) {
      const t = person.bones[bi].tris;
      const whole = u => !(BD[t[u + 3]].broken || BD[t[u + 4]].broken || BD[t[u + 5]].broken || P[t[u]].ghost || P[t[u + 1]].ghost || P[t[u + 2]].ghost);
      for (let u = 0; u < t.length; u += 12) {
        const one = whole(u), two = whole(u + 6);
        if (!one && !two) continue;
        // a whole square goes in as one shape, which is much cheaper to stroke than two
        const pts = one && two ? [t[u], t[u + 1], t[u + 2], t[u + 8]] : one ? [t[u], t[u + 1], t[u + 2]] : [t[u + 6], t[u + 7], t[u + 8]];
        path.moveTo(P[pts[0]].x, P[pts[0]].y);
        for (let v = 1; v < pts.length; v++) path.lineTo(P[pts[v]].x, P[pts[v]].y);
        path.closePath();
        for (const i of pts) used.add(i);
      }
    }
    // crumbs too small to make a triangle are drawn as little lumps
    for (const bi of list) for (const i of person.bones[bi].all) {
      const q = P[i];
      if (q.anchor || q.ghost || used.has(i)) continue;
      const r = Math.max(q.r * 0.8, 2 * S);
      path.moveTo(q.x + r, q.y); path.arc(q.x, q.y, r, 0, Math.PI * 2); path.closePath();
    }
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3 * S; ctx.strokeStyle = '#000'; ctx.stroke(path);
    ctx.fillStyle = '#fff'; ctx.fill(path);
    // bruises and blood on the skin stay inside the outline
    ctx.save();
    ctx.clip(path);
    for (const bi of list) for (const i of person.bones[bi].all) {
      const q = P[i];
      if (q.anchor || q.ghost) continue;
      // soft patches that fade out, so neighbouring ones run together into one bruise
      if (q.hurt > 0.06) blot(q.x, q.y, 12 * S, hurtColor(q.hurt), Math.min(1, q.hurt * 2) * 0.9);
      if (q.burn > 0.04) blot(q.x, q.y, 10 * S, [28, 22, 18], Math.min(0.92, q.burn));
      if (q.frost > 0.04) blot(q.x, q.y, 10 * S, [165, 212, 240], Math.min(0.8, q.frost * 0.9));
      if (person.poison > 0.05) blot(q.x, q.y, 10 * S, [96, 150, 70], Math.min(0.5, person.poison * 0.55));
      if (q.fresh > 0.02) blot(q.x, q.y, 11 * S, [200, 16, 46], q.fresh * 0.85);
      if (q.stain > 0.05) blot(q.x, q.y, 8 * S, [200, 16, 46], Math.min(1, q.stain) * 0.8);
    }
    ctx.restore();
    for (const bi of list) drawMarks(person, bi);
  }

  // bruise colour: purple when light, red when bad, near-black red when worst
  const HURT_STOPS = [[0, [150, 110, 190]], [0.3, [120, 60, 160]], [0.55, [200, 16, 46]], [0.9, [60, 0, 10]]];
  function hurtColor(h) {
    let i = 0;
    while (i < HURT_STOPS.length - 2 && h > HURT_STOPS[i + 1][0]) i++;
    const [h0, c0] = HURT_STOPS[i], [h1, c1] = HURT_STOPS[i + 1];
    const t = Math.max(0, Math.min(1, (h - h0) / (h1 - h0)));
    return c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
  }

  function blot(x, y, r, [cr, cg, cb], a) {
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
    gr.addColorStop(0.5, `rgba(${cr},${cg},${cb},${a * 0.7})`);
    gr.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = gr;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // the face and the markers sit on top
  function drawMarks(person, bi) {
    const P = person.pts, bone = person.bones[bi], g = bone.grid;
    if (bi === HEAD && bone.intact) drawFace(person);
    if (bi === HEAD && (person.regen || person.immortal)) {
      // marks over the head: a plus for healing, a ring for can't-die
      const [hx, hy] = rowMid(P, g[g.length - 1]);
      const both = person.regen && person.immortal, yy = hy - 12 * S;
      ctx.fillStyle = '#000'; ctx.strokeStyle = '#000';
      if (person.regen) {
        const cx = hx - (both ? 5 * S : 0), t = 3.5 * S, w = 1.6 * S;
        ctx.fillRect(cx - t, yy - w / 2, t * 2, w);
        ctx.fillRect(cx - w / 2, yy - t, w, t * 2);
      }
      if (person.immortal) {
        const cx = hx + (both ? 5 * S : 0);
        ctx.lineWidth = 1.6 * S;
        ctx.beginPath(); ctx.arc(cx, yy, 3 * S, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  function drawFace(person) {
    const P = person.pts, g = person.bones[HEAD].grid;
    const [bx, by] = rowMid(P, g[0]), [tx, ty] = rowMid(P, g[g.length - 1]);
    const L = Math.hypot(tx - bx, ty - by) || 1, ux = (tx - bx) / L, uy = (ty - by) / L;
    const fx = -uy * person.dir, fy = ux * person.dir;
    const ex = (bx + tx) / 2 + fx * 4 * S + ux * 2 * S, ey = (by + ty) / 2 + fy * 4 * S + uy * 2 * S;
    ctx.fillStyle = '#000'; ctx.strokeStyle = '#000';
    if (person.dead || person.ko > 0) {
      const s = 2 * S;
      ctx.lineWidth = 1.6 * S; ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(ex - s, ey - s); ctx.lineTo(ex + s, ey + s); ctx.moveTo(ex + s, ey - s); ctx.lineTo(ex - s, ey + s);
      ctx.stroke();
    } else {
      ctx.fillRect(ex - 1.3 * S, ey - 1.8 * S, 2.6 * S, 3.6 * S);
    }
  }

  // flames licking up from every burning particle, a fresh shape each frame so they flicker
  function drawFlames(person) {
    const P = person.pts;
    for (let i = 0; i < P.length; i += 2) {
      const q = P[i];
      if (q.anchor || q.ghost || q.fire < 0.05) continue;
      const hgt = (7 + Math.random() * 9) * S * Math.min(1, q.fire + 0.2), w = (2.5 + Math.random() * 1.5) * S;
      ctx.globalAlpha = Math.min(0.9, q.fire + 0.2);
      ctx.fillStyle = '#ff7a1a';
      ctx.beginPath(); ctx.moveTo(q.x - w, q.y); ctx.quadraticCurveTo(q.x - w * 0.4, q.y - hgt * 0.6, q.x + (Math.random() - 0.5) * 2 * S, q.y - hgt);
      ctx.quadraticCurveTo(q.x + w * 0.4, q.y - hgt * 0.6, q.x + w, q.y); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffd23f';
      ctx.beginPath(); ctx.moveTo(q.x - w * 0.45, q.y); ctx.lineTo(q.x, q.y - hgt * 0.55); ctx.lineTo(q.x + w * 0.45, q.y); ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawPerson(person) {
    // chest and belly are one torso while the waist holds
    const torso = !person.bonds[person.joints[WAIST].bond].broken;
    for (const bi of DRAW_ORDER) {
      if (torso && bi === CHEST) continue;
      const list = (torso && bi === BELLY ? [BELLY, CHEST] : [bi]).filter(b => !person.bones[b].ghost);
      if (list.length) drawBones(person, list);
    }
    if (person.burning > 0) drawFlames(person);
    if (person.reform) {
      // round drops about as big as the particles they were, so a clot reads as one mass, with
      // a short fading trail behind
      ctx.fillStyle = BLOOD;
      const P = person.pts, flow = person.reform.flow;
      for (const [alpha, key, sc] of [[0.3, 2, 0.55], [0.55, 1, 0.8], [1, 0, 1.15]]) {
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        for (const f of flow) {
          const x = key === 2 ? f.x2 : key === 1 ? f.x1 : f.x, y = key === 2 ? f.y2 : key === 1 ? f.y1 : f.y;
          const r = Math.max(2 * S, P[f.i].r * sc);
          ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawWorld() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, G, W, H - G);
    // metre marks along the floor: 1 m ≈ body height / 1.8
    const m = 150 * S / 1.8;
    ctx.fillStyle = '#ffffff';
    ctx.font = `500 ${Math.round(10 * Math.max(0.8, S))}px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    for (let i = 0, x = 0; x < W; i++, x += m) {
      ctx.fillRect(x, G, 1, i % 5 === 0 ? 10 : 5);
      if (i % 5 === 0 && i > 0) ctx.fillText(i + ' m', x + 4, G + 6);
    }
    ctx.fillStyle = BLOOD;
    for (const s of stains) { ctx.fillStyle = s.c || BLOOD; ctx.fillRect(s.x - s.w / 2, G - 1.5 * S, s.w, 3 * S); }
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawWorld();
    drawItems();
    ctx.fillStyle = '#000000';
    for (const d of dust) {
      ctx.globalAlpha = Math.max(0, d.life) * 0.6;
      ctx.fillRect(d.x - d.s / 2, d.y - d.s / 2, d.s, d.s);
    }
    ctx.globalAlpha = 1;
    for (const p of people) if (!(held && held.person === p)) drawPerson(p);
    if (held) drawPerson(held.person);
    drawLightAndSparks();
    drawProps();
    drawWires();
    drawBlasts();
    ctx.fillStyle = BLOOD;
    for (const d of drops) { ctx.fillStyle = d.c || BLOOD; ctx.fillRect(d.x - d.s / 2, d.y - d.s / 2, d.s, d.s); }
    drawMindLabels();
    if (held) {
      const q = held.person.pts[held.idx];
      ctx.strokeStyle = '#000000'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(pointer.x, pointer.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#000000';
      ctx.fillRect(q.x - 3, q.y - 3, 6, 6);
      ctx.fillRect(pointer.x - 2, pointer.y - 2, 4, 4);
    }
  }

  // ---------- props: things to pick up, swing and throw ----------
  // A prop is one rigid body built from capsules (segments with a radius), at scale 1 with the
  // handle to the left. Blades cut the bonds they sweep through when they move fast enough across
  // their edge; a pointed blade driven in along its length stabs and stays stuck; everything
  // else knocks (bruises, dents, crushes, like any other hit).
  //   kind: grip | blunt | blade;  tip: the blade's b end is a point that stabs
  //   box: [x, y, half width, half height] makes a part a rectangle instead of a capsule
  //   fixed: stands on the floor and doesn't move (machines); fuse: seconds until it goes off
  //   pierce: the stretch of the long axis (y = 0, from..to) that goes through a body it stabs
  const PROP_KINDS = {
    sword: { name: 'Sword', pierce: [-22, 38], parts: [
      { a: [-36, 0], b: [-22, 0], r: 2.3, m: 2, kind: 'grip' },
      { a: [-22, -7], b: [-22, 7], r: 1.6, m: 1, kind: 'blunt' },
      { a: [-22, 0], b: [38, 0], r: 1.8, m: 6, kind: 'blade', tip: true },
    ] },
    knife: { name: 'Knife', pierce: [-2, 14], parts: [
      { a: [-13, 0], b: [-2, 0], r: 2.4, m: 1.2, kind: 'grip' },
      { a: [-2, 0], b: [14, 0], r: 1.6, m: 1.3, kind: 'blade', tip: true },
    ] },
    axe: { name: 'Axe', parts: [
      { a: [-32, 0], b: [22, 0], r: 2.2, m: 4, kind: 'grip' },
      { a: [16, -2], b: [24, -2], r: 5, m: 5, kind: 'blunt' },
      { a: [28, -14], b: [28, 9], r: 3, m: 4, kind: 'blade', sharp: 1.4 },
    ] },
    hammer: { name: 'Hammer', parts: [
      { a: [-26, 0], b: [18, 0], r: 2.2, m: 3, kind: 'grip' },
      { a: [22, -9], b: [22, 9], r: 5, m: 12, kind: 'blunt' },
    ] },
    bat: { name: 'Baseball bat', parts: [
      { a: [-34, 0], b: [-12, 0], r: 2.3, m: 3, kind: 'grip' },
      { a: [-12, 0], b: [36, 0], r: 4.2, m: 8, kind: 'blunt' },
    ] },
    spear: { name: 'Spear', pierce: [-52, 52], parts: [
      { a: [-52, 0], b: [34, 0], r: 1.7, m: 5, kind: 'grip' },
      { a: [34, 0], b: [52, 0], r: 2, m: 1.6, kind: 'blade', tip: true },
    ] },
    iron: { name: 'Iron block', parts: [
      { box: [0, 0, 15, 15], m: 70, kind: 'blunt', metal: true },
    ] },
    beam: { name: 'Iron beam', parts: [
      { box: [0, 0, 48, 5], m: 35, kind: 'blunt', metal: true },
    ] },
    bomb: { name: 'Bomb', fuse: 3, parts: [
      { a: [0, 0], b: [0, 0], r: 8, m: 4, kind: 'blunt', bomb: true },
    ] },
    torch: { name: 'Torch', parts: [
      { a: [-26, 0], b: [10, 0], r: 2.3, m: 2, kind: 'grip' },
      { a: [10, 0], b: [17, 0], r: 3.6, m: 0.8, kind: 'blunt', flame: true },
    ] },
    poison: { name: 'Poison flask', shatter: 'poison', parts: [
      { a: [-7, 0], b: [4, 0], r: 5.5, m: 1.2, kind: 'blunt', glass: '#6f9f4f' },
      { a: [4, 0], b: [11, 0], r: 2, m: 0.3, kind: 'blunt', glass: '#6f9f4f' },
    ] },
    nitrogen: { name: 'Liquid nitrogen', shatter: 'cold', parts: [
      { a: [-7, 0], b: [4, 0], r: 5.5, m: 1.2, kind: 'blunt', glass: '#9fd0ee' },
      { a: [4, 0], b: [11, 0], r: 2, m: 0.3, kind: 'blunt', glass: '#9fd0ee' },
    ] },
    generator: { name: 'Generator', source: true, parts: [
      { box: [0, -13, 18, 13], m: 30, kind: 'blunt', metal: true, gen: true },
      { a: [12, -26], b: [12, -33], r: 2, m: 0.5, kind: 'grip' },
    ] },
    lamp: { name: 'Lamp', lamp: true, parts: [
      { box: [0, -3, 8, 3], m: 1.5, kind: 'blunt' },
      { a: [0, -6], b: [0, -12], r: 2.2, m: 0.4, kind: 'grip' },
      { a: [0, -19], b: [0, -19], r: 7, m: 0.4, kind: 'blunt', glass: '#ffffff', bulb: true },
    ] },
    fridge: { name: 'Fridge', fixed: true, parts: [
      { box: [-43, -92, 4, 92], m: 1, kind: 'blunt' },
      { box: [0, -187, 47, 5], m: 1, kind: 'blunt' },
      { box: [43, -92, 4, 92], m: 1, kind: 'blunt', door: true },
    ] },
    press: { name: 'Press', fixed: true, parts: [
      { box: [-52, -92, 5, 92], m: 1, kind: 'blunt', metal: true },
      { box: [52, -92, 5, 92], m: 1, kind: 'blunt', metal: true },
      { box: [0, -188, 57, 7], m: 1, kind: 'blunt', metal: true },
      { a: [0, -181], b: [0, -160], r: 3, m: 1, kind: 'grip', rod: true },
      { box: [0, -155, 44, 5], m: 1, kind: 'blunt', plate: true },
    ] },
  };
  // metal things carry current to each other and to anyone touching them
  const CONDUCTIVE = new Set(['sword', 'knife', 'axe', 'hammer', 'spear', 'iron', 'beam', 'press']);
  const CUT = 380, STAB = 420;   // px/s at scale 1: how fast an edge must sweep / a point drive in
  const props = [];
  let heldProp = null;           // { prop, lx, ly, angle }
  let spawnDrag = null;          // a prop being dragged out of the props menu: no collisions yet

  function makeProp(kind, x, y, a) {
    const def = PROP_KINDS[kind];
    const ends = p => p.box ? [[p.box[0], p.box[1]], [p.box[0], p.box[1]]] : [p.a, p.b];
    let M = 0, cx = 0, cy = 0;
    for (const p of def.parts) { const [A, B] = ends(p); M += p.m; cx += p.m * (A[0] + B[0]) / 2; cy += p.m * (A[1] + B[1]) / 2; }
    cx /= M; cy /= M;
    if (def.fixed) cx = cy = 0;          // a machine's origin is the middle of its base, on the floor
    let I = 0, R = 0;
    const parts = def.parts.map(p => {
      const [A, B] = ends(p);
      const a = [(A[0] - cx) * S, (A[1] - cy) * S], b = [(B[0] - cx) * S, (B[1] - cy) * S];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const hw = p.box ? p.box[2] * S : 0, hh = p.box ? p.box[3] * S : 0, r = p.box ? 0 : p.r * S;
      I += p.m * ((p.box ? 4 * (hw * hw + hh * hh) : L * L) / 12 + mx * mx + my * my);
      R = Math.max(R, Math.hypot(a[0], a[1]) + r + Math.hypot(hw, hh), Math.hypot(b[0], b[1]) + r + Math.hypot(hw, hh));
      const onLine = !!def.pierce && !p.box && p.a[1] === 0 && p.b[1] === 0 &&
        Math.min(p.a[0], p.b[0]) >= def.pierce[0] - 0.01 && Math.max(p.a[0], p.b[0]) <= def.pierce[1] + 0.01;
      return { a, b, r, hw, hh, box: !!p.box, kind: p.kind, tip: !!p.tip, sharp: p.sharp || 1, onLine,
        metal: !!p.metal, bomb: !!p.bomb, plate: !!p.plate, rod: !!p.rod, flame: !!p.flame, glass: p.glass || null,
        door: !!p.door, gen: !!p.gen, bulb: !!p.bulb, off: false, vel: null,
        wa: [0, 0], wb: [0, 0], wc: p.box ? [[0, 0], [0, 0], [0, 0], [0, 0]] : null };
    });
    const pierce = def.pierce && { x0: (def.pierce[0] - cx) * S, x1: (def.pierce[1] - cx) * S, y: -cy * S,
      r: Math.max(...parts.filter(p => p.onLine).map(p => p.r)) };
    const pr = { kind, parts, m: M, I: I + M * S * S, R, x, y, a: a || 0, vx: 0, vy: 0, w: 0, blood: 0, pierce, skew: [], ghost: false,
      fixed: !!def.fixed, fuse: def.fuse, shatter: def.shatter,
      conductive: CONDUCTIVE.has(kind), touch: [], touchP: [], on: !!def.source, lit: false };
    if (kind === 'fridge') { pr.door = parts.findIndex(p => p.door); parts[pr.door].off = true; }   // starts open
    if (kind === 'press') {
      const plate = parts.findIndex(p => p.plate), rod = parts.findIndex(p => p.rod);
      pr.press = { on: true, phase: 'rest', t: 1, plate, rod, y: parts[plate].a[1], top: parts[plate].a[1], bottom: -17 * S };
    }
    propWorld(pr);
    return pr;
  }

  const propPoint = (pr, lx, ly) => {
    const c = Math.cos(pr.a), s = Math.sin(pr.a);
    return [pr.x + c * lx - s * ly, pr.y + s * lx + c * ly];
  };
  const propLocal = (pr, wx, wy) => {
    const c = Math.cos(pr.a), s = Math.sin(pr.a), dx = wx - pr.x, dy = wy - pr.y;
    return [c * dx + s * dy, -s * dx + c * dy];
  };
  function propWorld(pr) {
    const c = pr.c = Math.cos(pr.a), s = pr.s = Math.sin(pr.a);
    for (const p of pr.parts) {
      p.wa[0] = pr.x + c * p.a[0] - s * p.a[1]; p.wa[1] = pr.y + s * p.a[0] + c * p.a[1];
      p.wb[0] = pr.x + c * p.b[0] - s * p.b[1]; p.wb[1] = pr.y + s * p.b[0] + c * p.b[1];
      if (p.box) {
        const k = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        for (let i = 0; i < 4; i++) {
          const lx = k[i][0] * p.hw, ly = k[i][1] * p.hh;
          p.wc[i][0] = p.wa[0] + c * lx - s * ly; p.wc[i][1] = p.wa[1] + s * lx + c * ly;
        }
      }
    }
  }

  // Where a circle at (x, y) of radius rad touches a part: the contact point on the prop, the
  // normal from the prop out toward the circle, and how deep they overlap (null if they don't).
  function surface(pr, p, x, y, rad) {
    if (p.off) return null;
    if (!p.box) {
      const [cx, cy] = closestOnSeg(x, y, p.wa, p.wb);
      const dx = x - cx, dy = y - cy, d2 = dx * dx + dy * dy, rr = p.r + rad;
      if (d2 >= rr * rr || d2 < 1e-9) return null;
      const d = Math.sqrt(d2);
      return [cx, cy, dx / d, dy / d, rr - d];
    }
    const c = pr.c, s = pr.s, ox = x - p.wa[0], oy = y - p.wa[1];
    const lx = c * ox + s * oy, ly = -s * ox + c * oy;
    let px = Math.max(-p.hw, Math.min(p.hw, lx)), py = Math.max(-p.hh, Math.min(p.hh, ly)), nlx, nly, pen;
    if (px !== lx || py !== ly) {
      const dx = lx - px, dy = ly - py, d = Math.hypot(dx, dy);
      if (d >= rad || d < 1e-9) return null;
      nlx = dx / d; nly = dy / d; pen = rad - d;
    } else {
      // inside: out through the nearest side
      const ex = p.hw - Math.abs(lx), ey = p.hh - Math.abs(ly);
      if (ex < ey) { nlx = Math.sign(lx) || 1; nly = 0; pen = ex + rad; px = nlx * p.hw; }
      else { nlx = 0; nly = Math.sign(ly) || 1; pen = ey + rad; py = nly * p.hh; }
    }
    return [p.wa[0] + c * px - s * py, p.wa[1] + s * px + c * py, c * nlx - s * nly, s * nlx + c * nly, pen];
  }
  const invMass = pr => pr.fixed ? 0 : (isHeldProp(pr) ? 0.2 : 1) / pr.m;
  const invInertia = pr => pr.fixed ? 0 : (isHeldProp(pr) ? 0.2 : 1) / pr.I;
  const isHeldProp = pr => heldProp && heldProp.prop === pr;

  // the prop under a point, if any (a little slack so thin blades can be caught)
  // (grabbing: machines stay where they are, so they can't be picked up)
  function propAt(x, y, grabbing) {
    for (let k = props.length - 1; k >= 0; k--) {
      const pr = props[k];
      if (pr.ghost || (grabbing && pr.fixed) || Math.hypot(x - pr.x, y - pr.y) > pr.R + 8 * S) continue;
      for (const p of pr.parts) if (surface(pr, p, x, y, 6 * S)) return pr;
    }
    return null;
  }

  function closestOnSeg(x, y, A, B) {
    const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - A[0]) * dx + (y - A[1]) * dy) / L2)) : 0;
    return [A[0] + dx * t, A[1] + dy * t];
  }
  // do segments p1-p2 and p3-p4 cross?
  function segsCross(x1, y1, x2, y2, x3, y3, x4, y4) {
    const d1 = (x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3), d2 = (x4 - x3) * (y2 - y3) - (y4 - y3) * (x2 - x3);
    const d3 = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1), d4 = (x2 - x1) * (y4 - y1) - (y2 - y1) * (x4 - x1);
    return d1 * d2 < 0 && d3 * d4 < 0;
  }

  // every substep, after the bodies have moved
  function stepProps(h) {
    const g = GRAV();
    for (const pr of props) { pr.pvx = pr.vx; pr.pvy = pr.vy + g * h; pr.knock = 0; pr.touch.length = 0; pr.touchP.length = 0; }
    for (const pr of props) {
      if (pr.ghost) continue;
      if (pr.fixed) { if (pr.press) runPress(pr, h); }
      else if (isHeldProp(pr)) holdProp(pr, h);
      else {
        pr.vy += g * h;
        pr.vx *= 0.9995; pr.vy *= 0.9995; pr.w *= 0.998;
        pr.x += pr.vx * h; pr.y += pr.vy * h; pr.a += pr.w * h;
      }
      propWorld(pr);
    }
    for (let it = 0; it < 2; it++) {
      for (const pr of props) {
        if (pr.ghost) continue;
        propVsBodies(pr, h, it === 0);
        if (pr.skew.length) holdSkewers(pr, h);
        propWorld(pr);
      }
      propVsProps();
    }
    for (const pr of props) {
      if (pr.ghost) continue;
      cutWithProp(pr, h);
      propVsWorld(pr);
      propWorld(pr);
    }
    // glass: a hard knock (a sudden change of speed) breaks it
    for (const pr of props.slice()) {
      if (!pr.shatter || pr.ghost || isHeldProp(pr)) continue;
      if (pr.knock > 330 * S || Math.hypot(pr.vx - pr.pvx, pr.vy - pr.pvy) > 380 * S) shatterFlask(pr);
    }
  }

  function shatterFlask(pr) {
    props.splice(props.indexOf(pr), 1);
    const cold = pr.shatter === 'cold', R = (cold ? 95 : 55) * S;
    spray(pr.x, pr.y, pr.vx * 0.2, -150 * S, 10, cold ? '#bfe3f7' : '#6f9f4f');
    for (let k = 0; k < 6; k++) dust.push({ x: pr.x, y: pr.y, vx: (Math.random() - 0.5) * 300 * S, vy: -Math.random() * 200 * S, life: 1, s: (1.5 + Math.random() * 2) * S });
    if (cold) blasts.push({ x: pr.x, y: pr.y, t: 0, R, cold: true });
    for (const person of people) {
      const P = person.pts;
      let most = 0;
      for (const q of P) {
        if (q.anchor || q.ghost) continue;
        const d = Math.hypot(q.x - pr.x, q.y - pr.y);
        if (d > R) continue;
        const f = 1 - d / R;
        most = Math.max(most, f);
        if (cold) { q.frost = Math.min(1, Math.max(q.frost, 0.5 + f)); q.fire = 0; }
      }
      if (!cold && most > 0) person.poison = Math.min(1.3, (person.poison || 0) + 0.25 + most * 0.8);
      if (most > 0 && person.mind) person.mind.fear = Math.min(1, person.mind.fear + 0.3);
    }
  }

  // Fire and cold that come from things in the world: a torch sets alight whatever its flame
  // touches (and lights bomb fuses); inside a fridge, bodies slowly freeze, fast with the door shut.
  function updateEnvironment(dt) {
    for (const pr of props) {
      if (pr.ghost) continue;
      for (const p of pr.parts) {
        if (!p.flame) continue;
        const fx = p.wb[0], fy = p.wb[1], reach = 9 * S;
        for (const person of people) for (const q of person.pts) {
          if (q.anchor || q.ghost) continue;
          if (Math.hypot(q.x - fx, q.y - fy) > reach + q.r) continue;
          if (q.frost > 0.1) q.frost = Math.max(0, q.frost - dt * 1.5);
          else q.fire = Math.max(q.fire, 0.9);
        }
        for (const o of props) if (o.fuse !== undefined && o !== pr && Math.hypot(o.x - fx, o.y - fy) < reach + 10 * S) o.fuse = Math.min(o.fuse, 0.6);
      }
      if (pr.kind === 'fridge') {
        const shut = !pr.parts[pr.door].off, x0 = pr.x - 39 * S, x1 = pr.x + 39 * S, y0 = pr.y - 182 * S;
        for (const person of people) for (const q of person.pts) {
          if (q.anchor || q.ghost || q.x < x0 || q.x > x1 || q.y < y0 || q.y > pr.y) continue;
          q.fire = 0;
          q.frost = Math.min(1, q.frost + dt * (shut ? 0.2 : 0.035));
        }
      }
    }
  }

  function spreadFire(q) {
    let pick = null, n = 0;
    for (const person of people) for (const o of person.pts) {
      if (o === q || o.anchor || o.ghost || o.fire > 0.5 || o.burn > 0.95 || o.frost > 0.3) continue;
      const dx = o.x - q.x, dy = o.y - q.y;
      if (Math.abs(dx) > 8 * S || dy > 5 * S || dy < -12 * S) continue;     // reaches further up than down
      if (Math.random() * ++n < 1) pick = o;
    }
    if (pick) pick.fire = 0.9;
  }

  // Burning spreads from particle to particle, chars the skin black, weakens
  // it, and costs blood and hurts; frost thaws slowly; a body mostly frozen is frozen solid;
  // poison drains blood, makes the body shake and turn a sickly colour, and weakens it.
  function updateBurnFrostPoison(person, dt, floor) {
    const P = person.pts;
    let burning = 0, frost = 0, n = 0, hot = -1;
    for (let i = 0; i < P.length; i++) {
      const q = P[i];
      if (q.anchor || q.ghost) continue;
      n++;
      if (q.fire > 0) {
        burning++; hot = i;
        q.burn = Math.min(1, q.burn + dt * 0.3 * q.fire);
        q.frost = 0;
        for (const bi of q.bonds) {
          const b = person.bonds[bi];
          if (b.broken || b.kind !== 'in') continue;
          b.hp -= dt * 0.008 * q.fire;
          if (b.hp <= 0) breakBond(person, bi);
        }
        // now and then it catches something close by: across joints, onto someone standing
        // next to it, and more readily upward, since flames climb
        if (Math.random() < dt * 2.2 * q.fire) spreadFire(q);
        q.fire = Math.max(0, q.fire - dt * (q.burn > 0.9 ? 0.45 : 0.14));
        if (Math.random() < dt * 1.5 * q.fire) dust.push({ x: q.x, y: q.y - 6 * S, vx: (Math.random() - 0.5) * 30 * S, vy: -60 * S, life: 1, s: (2 + Math.random() * 3) * S });
      }
      if (q.frost > 0) { frost += q.frost; q.frost = Math.max(0, q.frost - dt * 0.035); }
    }
    person.burning = n ? burning / n : 0;
    if (burning) {
      person.blood = Math.max(floor, person.blood - dt * 11 * person.burning);
      if (person.mind && Math.random() < dt * 5) feel(person, hot, 700 * S + 1500 * S * person.burning, P[hot].x);
    }
    const was = person.frozen;
    person.frozen = n > 0 && frost / n > 0.55;
    // freezing locks every joint at the angle it has now
    if (person.frozen && !was) {
      for (const j of person.joints) j.lock = j.active ? rawAngle(person, j, false) : null;
      person.statue = person.standing;          // frozen on its feet, it stays up like a statue
    }
    if (person.poison > 0) {
      const pz = person.poison;
      person.blood = Math.max(floor, person.blood - dt * 2.2 * pz);
      person.poison = Math.max(0, pz - dt * 0.006);
      if (!person.dead) for (let k = 0; k < 4; k++) {
        const q = P[(Math.random() * P.length) | 0];
        if (!q.anchor && !q.ghost) { q.px += (Math.random() - 0.5) * pz * 1.4 * S; q.py += (Math.random() - 0.5) * pz * 1.4 * S; }
      }
    }
  }

  // Held: the grip point is pulled toward the pointer the way a held body is, and the prop
  // keeps its angle, which A and D turn about that point.
  function holdProp(pr, h) {
    const hp = heldProp;
    hp.angle += turnKeys() * 3.2 * h;
    const [gx, gy] = propPoint(pr, hp.lx, hp.ly);
    const nx = gx + (pointer.x - gx) * 0.35, ny = gy + (pointer.y - gy) * 0.35;
    const ox = pr.x, oy = pr.y, oa = pr.a;
    pr.a = hp.angle;
    const c = Math.cos(pr.a), s = Math.sin(pr.a);
    pr.x = nx - (c * hp.lx - s * hp.ly); pr.y = ny - (s * hp.lx + c * hp.ly);
    pr.vx = (pr.x - ox) / h; pr.vy = (pr.y - oy) / h; pr.w = wrap(pr.a - oa) / h;
    const vmax = VMAX * S / h, sp = Math.hypot(pr.vx, pr.vy);
    if (sp > vmax) { pr.vx *= vmax / sp; pr.vy *= vmax / sp; }
    pr.w = Math.max(-40, Math.min(40, pr.w));
  }

  // push a prop out of the floor or a wall at a point, and stop it moving into it
  function propContact(pr, ex, ey, nx, ny, pen) {
    if (pr.fixed) return;
    const rx = ex - pr.x, ry = ey - pr.y, rn = rx * ny - ry * nx;
    const iM = 1 / pr.m, iI = 1 / pr.I, wn = iM + rn * rn * iI;
    const d = pen / wn;
    pr.x += nx * d * iM; pr.y += ny * d * iM; pr.a += rn * d * iI;
    const vn = (pr.vx - pr.w * ry) * nx + (pr.vy + pr.w * rx) * ny;
    if (vn >= 0) return;
    pr.knock = Math.max(pr.knock || 0, -vn);
    const j = -1.15 * vn / wn;
    pr.vx += nx * j * iM; pr.vy += ny * j * iM; pr.w += rn * j * iI;
    // friction along the surface
    const tx = -ny, ty = nx, rt = rx * ty - ry * tx, wt = iM + rt * rt * iI;
    const vt = (pr.vx - pr.w * ry) * tx + (pr.vy + pr.w * rx) * ty;
    const jt = Math.max(-0.6 * j, Math.min(0.6 * j, -vt / wt));
    pr.vx += tx * jt * iM; pr.vy += ty * jt * iM; pr.w += rt * jt * iI;
  }

  function propVsWorld(pr) {
    if (pr.fixed) return;
    for (const p of pr.parts) for (const e of (p.box ? p.wc : [p.wa, p.wb])) {
      if (e[1] + p.r > G) propContact(pr, e[0], G, 0, -1, e[1] + p.r - G);
      if (e[0] - p.r < 0) propContact(pr, 0, e[1], 1, 0, p.r - e[0]);
      else if (e[0] + p.r > W) propContact(pr, W, e[1], -1, 0, e[0] + p.r - W);
    }
  }

  // Props against each other: points around one prop's outline against the other's parts, both
  // ways round, pushed apart and stopped from moving into each other like two rigid bodies.
  function outline(pr) {
    const out = [];
    pr.parts.forEach((p, pi) => {
      if (p.off) return;
      if (p.box) {
        for (let i = 0; i < 4; i++) {
          const A = p.wc[i], B = p.wc[(i + 1) % 4];
          out.push(A[0], A[1], 0, pi, (A[0] + B[0]) / 2, (A[1] + B[1]) / 2, 0, pi);
        }
      } else {
        const L = Math.hypot(p.wb[0] - p.wa[0], p.wb[1] - p.wa[1]), n = Math.max(1, Math.ceil(L / (p.r * 2 + 2 * S)));
        for (let i = 0; i <= n; i++) out.push(p.wa[0] + (p.wb[0] - p.wa[0]) * i / n, p.wa[1] + (p.wb[1] - p.wa[1]) * i / n, p.r, pi);
      }
    });
    return out;
  }
  function propVsProps() {
    for (let a = 0; a < props.length; a++) for (let b = a + 1; b < props.length; b++) {
      const A = props[a], B = props[b];
      if (A.ghost || B.ghost || (A.fixed && B.fixed)) continue;
      if (Math.hypot(A.x - B.x, A.y - B.y) > A.R + B.R) continue;
      touchProps(A, B); touchProps(B, A);
    }
  }
  function touchProps(A, B) {
    const pts = outline(A);
    const margin = 1.5 * S, wired = A.conductive || A.on || B.conductive || B.on;
    let touching = false;
    for (let k = 0; k < pts.length; k += 4) for (const p of B.parts) {
      // (looked for a little way out, so things resting against each other count as touching
      // for electricity even when the push between them has just parted them)
      const hit = surface(B, p, pts[k], pts[k + 1], pts[k + 2] + margin);
      if (!hit) continue;
      touching = true;
      const [bx, by, nx, ny, reach] = hit, rad = pts[k + 2], pen = reach - margin;
      if (pen > 0) bodyTouch(A, pts[k] - nx * rad, pts[k + 1] - ny * rad, A.parts[pts[k + 3]], B, bx, by, p, nx, ny, pen);
    }
    if (touching && wired) { A.touch.push(B); B.touch.push(A); }
  }
  function bodyTouch(A, ax, ay, pA, B, bx, by, pB, nx, ny, pen) {
    // a press plate coming down on something solid stops there (bodies it crushes; props it can't)
    if (pA.plate) A.press.blocked = true;
    if (pB.plate) B.press.blocked = true;
    const iMA = invMass(A), iIA = invInertia(A), iMB = invMass(B), iIB = invInertia(B);
    const rax = ax - A.x, ray = ay - A.y, rbx = bx - B.x, rby = by - B.y;
    const rna = rax * ny - ray * nx, rnb = rbx * ny - rby * nx;
    const w = iMA + rna * rna * iIA + iMB + rnb * rnb * iIB;
    if (w <= 0) return;
    const k = pen / w * 0.8;
    A.x += nx * k * iMA; A.y += ny * k * iMA; A.a += rna * k * iIA;
    B.x -= nx * k * iMB; B.y -= ny * k * iMB; B.a -= rnb * k * iIB;
    const vax = A.vx - A.w * ray + (pA.vel ? pA.vel[0] : 0), vay = A.vy + A.w * rax + (pA.vel ? pA.vel[1] : 0);
    const vbx = B.vx - B.w * rby + (pB.vel ? pB.vel[0] : 0), vby = B.vy + B.w * rbx + (pB.vel ? pB.vel[1] : 0);
    const vn = (vax - vbx) * nx + (vay - vby) * ny;
    if (vn >= 0) return;
    A.knock = Math.max(A.knock || 0, -vn); B.knock = Math.max(B.knock || 0, -vn);
    const j = -1.15 * vn / w;
    A.vx += nx * j * iMA; A.vy += ny * j * iMA; A.w += rna * j * iIA;
    B.vx -= nx * j * iMB; B.vy -= ny * j * iMB; B.w -= rnb * j * iIB;
    // friction along the contact
    const tx = -ny, ty = nx, rta = rax * ty - ray * tx, rtb = rbx * ty - rby * tx;
    const wt = iMA + rta * rta * iIA + iMB + rtb * rtb * iIB;
    const vt = (vax - vbx) * tx + (vay - vby) * ty;
    const jt = Math.max(-0.5 * j, Math.min(0.5 * j, -vt / wt));
    A.vx += tx * jt * iMA; A.vy += ty * jt * iMA; A.w += rta * jt * iIA;
    B.vx -= tx * jt * iMB; B.vy -= ty * jt * iMB; B.w -= rtb * jt * iIB;
  }

  // The press: its plate comes down slowly, crushing any body under it (a solid prop stops it),
  // holds, goes back up, rests.
  function runPress(pr, h) {
    const st = pr.press, plate = pr.parts[st.plate], rod = pr.parts[st.rod];
    const blocked = st.blocked;
    st.blocked = false;
    let v = 0;
    if (st.on) {
      st.t += h;
      if (st.phase === 'down') { v = 70 * S; if (st.y >= st.bottom || blocked) { v = 0; st.phase = 'hold'; st.t = 0; } }
      else if (st.phase === 'hold') { if (st.t > 0.8) { st.phase = 'up'; st.t = 0; } }
      else if (st.phase === 'up') { v = -150 * S; if (st.y <= st.top) { st.phase = 'rest'; st.t = 0; } }
      else if (st.t > 1.5) { st.phase = 'down'; st.t = 0; }
    }
    st.y = Math.max(st.top, Math.min(st.bottom, st.y + v * h));
    plate.a[1] = plate.b[1] = st.y;
    rod.b[1] = st.y - plate.hh;
    plate.vel = [0, v]; rod.vel = [0, v];
  }

  // Props and body particles push each other apart and trade momentum. A body hit hard is hurt
  // the way any hit hurts it. A blade edge sweeping fast doesn't shove, it goes through
  // (cutWithProp does the cutting).
  function propVsBodies(pr, h, first) {
    const iM = invMass(pr), iI = invInertia(pr);             // a held prop is harder to push about, a machine can't be
    for (const person of people) {
      let skewered = skewerOf(pr, person);
      const P = person.pts;
      for (let i = 0; i < P.length; i++) {
        const q = P[i];
        if (q.anchor || q.ghost) continue;
        const ddx = q.x - pr.x, ddy = q.y - pr.y, lim = pr.R + q.r;
        if (ddx * ddx + ddy * ddy > lim * lim) continue;
        for (const p of pr.parts) {
          if (skewered && p.onLine) continue;          // it runs through this body (holdSkewers)
          // (metal is looked for a little way out, so a body resting against it counts as touching
          // for electricity)
          const margin = pr.conductive ? 1.5 * S : 0;
          const hit = surface(pr, p, q.x, q.y, q.r + margin);
          if (!hit) continue;
          if (pr.conductive) pr.touchP.push(person, i);
          const [cx, cy, nx, ny] = hit, pen = hit[4] - margin;
          if (pen <= 0) continue;
          const rx = cx - pr.x, ry = cy - pr.y, rn = rx * ny - ry * nx;
          const wp = isHeld(person, i) ? 0.2 : 1, wb = iM + rn * rn * iI;
          const pvx = p.vel ? p.vel[0] : 0, pvy = p.vel ? p.vel[1] : 0;
          const rvx = (q.x - q.px) / h - (pr.vx - pr.w * ry + pvx), rvy = (q.y - q.py) / h - (pr.vy + pr.w * rx + pvy);
          const vn = rvx * nx + rvy * ny;
          // the point driven in along the blade: it goes in instead of bouncing off
          if (p.tip && pr.pierce && !skewered) {
            const bx = p.wb[0] - p.wa[0], by = p.wb[1] - p.wa[1], bl = Math.hypot(bx, by) || 1;
            const along = -(rvx * bx + rvy * by) / bl;
            if (Math.hypot(cx - p.wb[0], cy - p.wb[1]) < p.r + 1.5 * S && along > STAB * S * (isHeldProp(pr) ? 0.6 : 1)) {
              stab(pr, person, i, along);
              skewered = true;
              break;
            }
          }
          if (p.kind === 'blade') {
            const bx = p.wb[0] - p.wa[0], by = p.wb[1] - p.wa[1], bl = Math.hypot(bx, by) || 1;
            // an edge sweeping fast goes through flesh instead of shoving it (it only slows as it cuts)
            if (Math.abs((rvx * -by + rvy * bx) / bl) > CUT * S / p.sharp) continue;
          }
          // apart, without speed...
          const k = pen / (wp + wb);
          q.x += nx * k * wp; q.y += ny * k * wp; q.px += nx * k * wp; q.py += ny * k * wp;
          pr.x -= nx * k * iM; pr.y -= ny * k * iM; pr.a -= rn * k * iI;
          // ...then stop them moving into each other
          if (vn < 0) {
            pr.knock = Math.max(pr.knock || 0, -vn);
            // (a guard or handle up against a body it is stuck in stops dead, it doesn't bounce back out)
            const j = -(skewered ? 1 : 1.1) * vn / (wp + wb);
            q.px -= nx * j * wp * h; q.py -= ny * j * wp * h;
            pr.vx -= nx * j * iM; pr.vy -= ny * j * iM; pr.w -= rn * j * iI;
            if (first && -vn > 300 * S) impact(person, i, -vn * (p.kind === 'blade' ? 0.5 : 1), cx, cy);
          }
        }
      }
    }
  }

  // Blades: an edge sweeping across fast enough cuts every bond it passes through, skin, bone
  // or joint (bone takes more passes). A point driven in along the blade skewers the body.
  const cutSeen = new Set();
  function cutWithProp(pr, h) {
    for (const p of pr.parts) {
      if (p.kind !== 'blade') continue;
      const A = p.wa, B = p.wb, bx = B[0] - A[0], by = B[1] - A[1], bl = Math.hypot(bx, by) || 1;
      const ux = bx / bl, uy = by / bl;
      for (const person of people) {
        if (skewerOf(pr, person)) continue;
        const P = person.pts;
        cutSeen.clear();
        let hurtAt = -1, hurtSpeed = 0;
        for (let i = 0; i < P.length; i++) {
          const q = P[i];
          if (q.anchor || q.ghost) continue;
          const [cx, cy] = closestOnSeg(q.x, q.y, A, B);
          const dist = Math.hypot(q.x - cx, q.y - cy);
          if (dist > p.r + 7 * S) continue;
          const rx = cx - pr.x, ry = cy - pr.y;
          const rvx = (pr.vx - pr.w * ry) - (q.x - q.px) / h, rvy = (pr.vy + pr.w * rx) - (q.y - q.py) / h;
          const across = Math.abs(rvx * -uy + rvy * ux) * p.sharp;
          if (across < CUT * S) continue;
          const force = 0.5 + (across / (CUT * S) - 1) * 0.6;
          for (const ob of q.bonds) {
            if (cutSeen.has(ob)) continue;
            const b = person.bonds[ob];
            if (b.broken || b.kind === 'anchor') continue;
            const o = P[b.a === i ? b.b : b.a];
            if (!segsCross(q.x, q.y, o.x, o.y, A[0], A[1], B[0], B[1])) continue;
            cutSeen.add(ob);
            cutBond(person, ob, force);
            // each cut takes a little of the swing out of it, bone a lot more
            const drag = P[b.a].core && P[b.b].core ? 0.975 : 0.994;
            pr.vx *= drag; pr.vy *= drag; pr.w *= drag;
            pr.blood = Math.min(1, pr.blood + 0.08);
            if (across > hurtSpeed) { hurtSpeed = across; hurtAt = i; }
          }
        }
        // joints (the bonds between the invisible anchors) are cut the same way
        for (const ji of person.jointBonds) {
          const b = person.bonds[ji];
          if (b.broken) continue;
          const qa = P[b.a], qb = P[b.b];
          if (!segsCross(qa.x, qa.y, qb.x, qb.y, A[0], A[1], B[0], B[1])) continue;
          const rx = qa.x - pr.x, ry = qa.y - pr.y;
          const rvx = (pr.vx - pr.w * ry) - (qa.x - qa.px) / h, rvy = (pr.vy + pr.w * rx) - (qa.y - qa.py) / h;
          const across = Math.abs(rvx * -uy + rvy * ux) * p.sharp;
          if (across > CUT * S) cutBond(person, ji, (0.5 + (across / (CUT * S) - 1) * 0.6) * 0.5);
        }
        if (hurtAt >= 0 && person.mind) feel(person, hurtAt, hurtSpeed, P[hurtAt].x);
      }
    }
  }

  // a cut ignores the grain of the flesh; only bone holds out longer
  function cutBond(person, bi, force) {
    const b = person.bonds[bi], P = person.pts;
    if (b.broken) return;
    b.hp -= force * (P[b.a].core && P[b.b].core ? 0.35 : 1);
    if (b.hp <= 0) breakBond(person, bi);
  }

  const skewerOf = (pr, person) => pr.skew.find(k => k.person === person);

  // the point goes in: from now on the blade runs through this body (holdSkewers)
  function stab(pr, person, i, speed) {
    const q = person.pts[i];
    pr.skew.push({ person, reps: [i] });
    q.wound = 1; q.hurt = Math.max(q.hurt, 0.8);
    pr.blood = Math.min(1, pr.blood + 0.4);
    spray(q.x, q.y, pr.vx * 0.2, pr.vy * 0.2, 6);
    if (person.mind) feel(person, i, speed, q.x);
  }

  // A blade through a body. Each piece of the body it runs through (chest, arm, ...) is threaded
  // on it by one particle: that particle stays on the blade's line, so sideways the body and the
  // blade move as one, while along the blade the flesh only drags on it. So a thrust carries on
  // through and out the far side as far as its speed takes it, the guard stops at the skin, and
  // a pull along the blade draws it back out. Wrenched sideways hard, it rips free.
  const SKEWER_DRAG = 25;   // how much sliding speed (px/s at scale 1) each threaded piece takes off per substep
  function holdSkewers(pr, h) {
    const pc = pr.pierce;
    const [Ax, Ay] = propPoint(pr, pc.x0, pc.y), [Bx, By] = propPoint(pr, pc.x1, pc.y);
    const L = Math.hypot(Bx - Ax, By - Ay) || 1, ux = (Bx - Ax) / L, uy = (By - Ay) / L, nx = -uy, ny = ux;
    const soft = isHeldProp(pr) ? 0.2 : 1, iM = soft / pr.m, iI = soft / pr.I;
    for (let s = pr.skew.length - 1; s >= 0; s--) {
      const sk = pr.skew[s], person = sk.person, P = person.pts;
      if (!people.includes(person)) { pr.skew.splice(s, 1); continue; }
      // thread on each piece the point drives through (whole bones and big pieces, not crumbs);
      // only the point, and only while it is going in: a body later lying along the blade isn't
      for (let i = 0; i < P.length; i++) {
        const q = P[i];
        if (q.anchor || q.ghost || q.chip) continue;
        const dx = q.x - Ax, dy = q.y - Ay, t = dx * ux + dy * uy, d = dx * nx + dy * ny;
        if (t < L - 10 * S || t > L + q.r + pc.r || Math.abs(d) > pc.r + q.r * 0.8) continue;
        const rx = Ax + ux * t - pr.x, ry = Ay + uy * t - pr.y;
        const going = (pr.vx - pr.w * ry - (q.x - q.px) / h) * ux + (pr.vy + pr.w * rx - (q.y - q.py) / h) * uy;
        if (going < 120 * S) continue;
        if (sk.reps.some(k => P[k].bone === q.bone && P[k].frag === q.frag)) continue;
        // a short blade can only go through so much: a knife holds one part, a sword about three
        if (sk.reps.length >= Math.max(1, Math.round(L / (22 * S)))) continue;
        sk.reps.push(i);
        q.wound = 1; q.hurt = Math.max(q.hurt, 0.7); q.stain = 1;
        pr.blood = Math.min(1, pr.blood + 0.25);
      }
      for (let r = sk.reps.length - 1; r >= 0; r--) {
        const i = sk.reps[r], q = P[i];
        const dx = q.x - Ax, dy = q.y - Ay, t = dx * ux + dy * uy, d = dx * nx + dy * ny;
        // slid off the point, or back past the guard: this piece is free. Held far off the blade
        // (bent away by the rest of the body), it tears free rather than being forced back on.
        if (q.ghost || t > L + q.r + pc.r + 2 * S || t < -(q.r + pc.r + 3 * S)) { sk.reps.splice(r, 1); continue; }
        if (Math.abs(d) > 13 * S) { q.wound = 1; spray(q.x, q.y, 0, 0, 5); sk.reps.splice(r, 1); continue; }
        const cx = Ax + ux * t, cy = Ay + uy * t, rx = cx - pr.x, ry = cy - pr.y;
        // the blade acts on the whole piece it is threaded through, weighted as that piece: a lone
        // particle would only be pulled straight back into its bone's shape
        const bone = person.bones[q.bone], piece = (bone.frags[q.frag] || [q.k]).map(k => bone.all[k]);
        const wp = (isHeld(person, i) ? 0.2 : 1) / piece.length;
        const rn = rx * ny - ry * nx, wb = iM + rn * rn * iI, k = d * 0.8 / (wp + wb);
        for (const j of piece) { const o = P[j]; o.x -= nx * k * wp; o.y -= ny * k * wp; o.px -= nx * k * wp; o.py -= ny * k * wp; }
        pr.x += nx * k * iM; pr.y += ny * k * iM; pr.a += rn * k * iI;
        const rvx = (q.x - q.px) / h - (pr.vx - pr.w * ry), rvy = (q.y - q.py) / h - (pr.vy + pr.w * rx);
        const vs = rvx * nx + rvy * ny, va = rvx * ux + rvy * uy;
        if (Math.abs(vs) > 2600 * S) {
          // wrenched sideways far too hard: it rips out through the side
          for (const ob of q.bonds) if (person.bonds[ob].kind === 'in') cutBond(person, ob, 1);
          spray(q.x, q.y, 0, 0, 8);
          sk.reps.splice(r, 1);
          continue;
        }
        const ru = rx * uy - ry * ux, wu = iM + ru * ru * iI;
        // flesh grips the blade: sliding slows by a set amount each step, and a slow slide stops dead
        const js = vs / (wp + wb), ja = Math.sign(va) * Math.min(Math.abs(va), SKEWER_DRAG * S) / (wp + wu);
        const ix = (nx * js + ux * ja) * wp * h, iy = (ny * js + uy * ja) * wp * h;
        for (const j of piece) { P[j].px += ix; P[j].py += iy; }
        pr.vx += (nx * js + ux * ja) * iM; pr.vy += (ny * js + uy * ja) * iM; pr.w += (rn * js + ru * ja) * iI;
      }
      if (!sk.reps.length) pr.skew.splice(s, 1);
    }
    // held in flesh, it can't spin freely
    if (pr.skew.length) pr.w = Math.max(-10, Math.min(10, pr.w * 0.98));
  }

  // ---------- electricity ----------
  // Wires join two things: a prop (at a point on it) or a person (at a particle). Current flows
  // from a running generator along wires and through metal props that touch; a lamp on the
  // circuit lights; anyone touching something live, or with a live wire on them, is shocked.
  const wires = [];
  let pendingWire = null;        // a wire with one end attached, the other following the pointer
  const WIRE_MAX = 460;          // how far a wire stretches (at scale 1) before it snaps

  function endAt(x, y, grabbing) {
    const pr = propAt(x, y);
    if (pr) { const [lx, ly] = propLocal(pr, x, y); return { prop: pr, lx, ly }; }
    const hit = nearest(x, y, 16 * S + 6);
    return hit ? { person: hit.person, i: hit.idx } : null;
  }
  function endPos(e) {
    if (e.prop) return propPoint(e.prop, e.lx, e.ly);
    const q = e.person.pts[e.i];
    return [q.x, q.y];
  }
  const endValid = e => e.prop ? props.includes(e.prop) && !e.prop.ghost
    : people.includes(e.person) && !e.person.pts[e.i].ghost;
  const sameThing = (a, b) => (a.prop && a.prop === b.prop) || (a.person && a.person === b.person);

  function finishWire(e) {
    if (!pendingWire) return;
    if (e && !sameThing(e, pendingWire)) wires.push({ a: pendingWire, b: e, live: false });
    pendingWire = null;
  }

  // the sagging curve a wire hangs in, as points
  function wirePoints(w) {
    const [ax, ay] = endPos(w.a), [bx, by] = endPos(w.b);
    const d = Math.hypot(bx - ax, by - ay), sag = Math.min(80 * S, Math.max(0, WIRE_MAX * S - d) * 0.3);
    const pts = [];
    for (let k = 0; k <= 16; k++) {
      const t = k / 16;
      pts.push(ax + (bx - ax) * t, ay + (by - ay) * t + sag * 4 * t * (1 - t));
    }
    return pts;
  }
  function wireAt(x, y) {
    for (const w of wires) {
      const pts = wirePoints(w);
      for (let k = 0; k < pts.length - 2; k += 2) {
        const [cx, cy] = closestOnSeg(x, y, [pts[k], pts[k + 1]], [pts[k + 2], pts[k + 3]]);
        if (Math.hypot(x - cx, y - cy) < 6 * S) return w;
      }
    }
    return null;
  }

  function updatePower(dt) {
    // wires whose ends are gone go too; stretched too far, they snap
    for (let k = wires.length - 1; k >= 0; k--) {
      const w = wires[k];
      if (!endValid(w.a) || !endValid(w.b)) { wires.splice(k, 1); continue; }
      const [ax, ay] = endPos(w.a), [bx, by] = endPos(w.b);
      if (Math.hypot(bx - ax, by - ay) > WIRE_MAX * S) { puff((ax + bx) / 2, (ay + by) / 2, 4); wires.splice(k, 1); }
    }
    if (pendingWire && !endValid(pendingWire)) pendingWire = null;
    // what is live: out from running generators along wires and through touching metal
    const live = new Set(), todo = props.filter(pr => pr.on && !pr.ghost);
    for (const pr of todo) live.add(pr);
    while (todo.length) {
      const pr = todo.pop();
      const reach = o => { if (!live.has(o)) { live.add(o); todo.push(o); } };
      for (const w of wires) {
        if (w.a.prop === pr && w.b.prop) reach(w.b.prop);
        if (w.b.prop === pr && w.a.prop) reach(w.a.prop);
      }
      if (pr.conductive || pr.on) for (const o of pr.touch) if (o.conductive) reach(o);
    }
    for (const pr of props) pr.lit = !!PROP_KINDS[pr.kind].lamp && live.has(pr);
    for (const w of wires) {
      w.live = (w.a.prop && live.has(w.a.prop)) || (w.b.prop && live.has(w.b.prop));
      if (!w.live) continue;
      // a live wire's end on a person runs current through them
      for (const e of [w.a, w.b]) if (e.person) shock(e.person, e.i);
    }
    for (const pr of live) if (pr.conductive) for (let k = 0; k < pr.touchP.length; k += 2) shock(pr.touchP[k], pr.touchP[k + 1]);
  }

  function shock(person, i) {
    person.shockT = 0.15;
    person.shockAt = i;
  }

  // Current through a body: every muscle clenches and jerks, the skin burns where it goes in,
  // it hurts; kept up for long the heart stops. A short jolt to a heart that has stopped can
  // start it again, as a defibrillator does.
  function updateShock(person, dt, floor) {
    const P = person.pts, J = person.joints;
    if (person.shockT > 0) {
      person.shockT -= dt;
      const q = P[person.shockAt];
      if (q && !q.ghost) {
        q.burn = Math.min(1, q.burn + dt * 0.8);
        for (const bi of q.bonds) { const b = person.bonds[bi]; const o = P[b.a === person.shockAt ? b.b : b.a]; if (!o.anchor) o.burn = Math.min(1, o.burn + dt * 0.3); }
      }
      if (!person.dead) {
        person.shockTime = (person.shockTime || 0) + dt;
        person.ko = Math.max(person.ko, 1.2);
        for (let k = 0; k < 30; k++) {
          const o = P[(Math.random() * P.length) | 0];
          if (!o.anchor && !o.ghost) { o.px += (Math.random() - 0.5) * 2.6 * S; o.py += (Math.random() - 0.5) * 2.6 * S; }
        }
        person.blood = Math.max(floor, person.blood - dt * 1.5);
        if (person.mind && q && Math.random() < dt * 6) feel(person, person.shockAt, 1200 * S, q.x);
        if (person.shockTime > 3 && !person.immortal) person.heartStopped = true;
      } else if (person.heartStopped) person.defib = (person.defib || 0) + dt;
    } else {
      person.shockTime = Math.max(0, (person.shockTime || 0) - dt * 0.5);
      if (person.defib) {
        if (person.defib < 0.8 && person.blood > 20 && J[NECK].active && J[WAIST].active) {
          person.heartStopped = false; person.dead = false; person.ko = 4; person.shockTime = 0;
          updateCount();
        }
        person.defib = 0;
      }
    }
  }

  // light from lit lamps, as seen from a point: how bright, and from where
  function lightAt(x, y) {
    let best = 0, from = null;
    for (const pr of props) {
      if (!pr.lit) continue;
      const l = 1 / (1 + Math.hypot(pr.x - x, pr.y - y) / (180 * S));
      if (l > best) { best = l; from = pr.x; }
    }
    return { amount: best, from };
  }

  function drawWires() {
    for (const w of wires) {
      const pts = wirePoints(w);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(pts[0], pts[1]);
      for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2.2 * S; ctx.stroke();
      if (w.live) { ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 0.9 * S; ctx.stroke(); }
      ctx.fillStyle = '#000';
      for (const e of [w.a, w.b]) { const [x, y] = endPos(e); ctx.fillRect(x - 2.5 * S, y - 2.5 * S, 5 * S, 5 * S); }
    }
    if (pendingWire) {
      const [ax, ay] = endPos(pendingWire);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2 * S; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(pointer.x, pointer.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#000'; ctx.fillRect(ax - 2.5 * S, ay - 2.5 * S, 5 * S, 5 * S);
    }
  }

  // glow round lit lamps, and sparks where current goes into someone
  function drawLightAndSparks() {
    for (const pr of props) {
      if (!pr.lit) continue;
      const b = pr.parts.find(p => p.bulb), x = b.wa[0], y = b.wa[1], r = 150 * S;
      const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,226,110,0.45)'); gr.addColorStop(1, 'rgba(255,226,110,0)');
      ctx.fillStyle = gr; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (const person of people) {
      if (!(person.shockT > 0)) continue;
      const q = person.pts[person.shockAt];
      if (!q) continue;
      for (let k = 0; k < 3; k++) {
        let x = q.x, y = q.y;
        ctx.beginPath(); ctx.moveTo(x, y);
        for (let n = 0; n < 5; n++) { x += (Math.random() - 0.5) * 16 * S; y += (Math.random() - 0.5) * 16 * S; ctx.lineTo(x, y); }
        ctx.strokeStyle = k ? '#ffd23f' : '#000'; ctx.lineWidth = (k ? 1.2 : 2) * S; ctx.stroke();
      }
    }
  }

  // the wire tile in the items panel: drag it onto one thing, then click another
  function startWireDrag(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const up = ev => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const r = propsPanel.getBoundingClientRect();
      const overPanel = !propsPanel.hidden && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (ev.type === 'pointercancel' || overPanel) return;
      const q = pos(ev);
      pointer.x = q.x; pointer.y = q.y;
      pendingWire = endAt(q.x, q.y);
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && pendingWire) pendingWire = null; });

  // ---------- bombs ----------
  // A blast throws everything near it outward, hardest close in; bodies are broken, bruised
  // and scorched, knocked out, and other bombs it reaches go off a moment later.
  const blasts = [];
  function updateFuses(dt) {
    for (const pr of props.slice()) {
      if (pr.fuse === undefined || pr.ghost) continue;
      pr.fuse -= dt;
      if (pr.fuse > 0) continue;
      props.splice(props.indexOf(pr), 1);
      if (isHeldProp(pr)) heldProp = null;
      explode(pr.x, pr.y);
    }
    for (let i = blasts.length - 1; i >= 0; i--) if ((blasts[i].t += dt) > 0.45) blasts.splice(i, 1);
  }

  function explode(x, y) {
    const R = 190 * S;
    blasts.push({ x, y, t: 0, R });
    puff(x, y, 40);
    spray(x, y, 0, -200 * S, 6);
    for (const person of people) {
      const P = person.pts;
      let near = -1, best = 0;
      for (let i = 0; i < P.length; i++) {
        const q = P[i];
        if (q.anchor || q.ghost) continue;
        const dx = q.x - x, dy = q.y - y, d = Math.hypot(dx, dy);
        if (d > R) continue;
        const f = (1 - d / R) ** 2, n = d || 1, kick = f * 3200 * S * lastH;
        q.px -= dx / n * kick; q.py -= dy / n * kick;
        q.hurt = Math.max(q.hurt, Math.min(1.2, f * 1.4)); q.stain = Math.max(q.stain, f * 0.6);
        for (const bi of q.bonds) damage(person, bi, f * 2.4);
        if (f > best) { best = f; near = i; }
      }
      if (near >= 0) {
        person.ko = Math.max(person.ko, 1 + best * 6);
        if (person.mind) { feel(person, near, 400 * S + best * 3000 * S, x); person.mind.fear = 1; }
      }
    }
    for (const pr of props) {
      if (pr.fixed || pr.ghost) continue;
      const dx = pr.x - x, dy = pr.y - y, d = Math.hypot(dx, dy);
      if (d > R * 1.2) continue;
      const f = (1 - d / (R * 1.2)) ** 2, n = d || 1;
      pr.vx += dx / n * f * 14000 * S / pr.m; pr.vy += dy / n * f * 14000 * S / pr.m;
      pr.w += (Math.random() - 0.5) * f * 60;
      pr.skew.length = 0;
      if (pr.fuse !== undefined && f > 0.05) pr.fuse = Math.min(pr.fuse, 0.12);   // set the next one off
    }
  }

  function drawBlasts() {
    for (const b of blasts) {
      const u = b.t / 0.45, r = b.R * (0.25 + 0.75 * Math.sqrt(u));
      ctx.globalAlpha = (1 - u) * (b.cold ? 0.5 : 0.35);
      ctx.fillStyle = b.cold ? '#bfe3f7' : '#000';
      ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1 - u;
      ctx.strokeStyle = '#000'; ctx.lineWidth = 3 * S * (1 - u) + 1;
      ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- drawing props ----------
  // White with a black outline like the bodies; grips are solid black, blades carry the blood.
  function drawProp(g, pr, alpha) {
    g.save();
    g.globalAlpha = alpha ?? 1;
    g.lineCap = 'round'; g.lineJoin = 'round';
    const ow = 1.6 * S;
    const bladeShape = p => {
      const A = p.wa, B = p.wb, dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L * p.r * 1.3, ny = dx / L * p.r * 1.3;
      g.beginPath();
      g.moveTo(A[0] + nx, A[1] + ny); g.lineTo(A[0] - nx, A[1] - ny);
      if (p.tip) { g.lineTo(B[0] - nx, B[1] - ny); g.lineTo(B[0] + dx / L * p.r * 2, B[1] + dy / L * p.r * 2); g.lineTo(B[0] + nx * 0.2, B[1] + ny * 0.2); }
      else { g.lineTo(B[0] - nx, B[1] - ny); g.lineTo(B[0] + nx, B[1] + ny); }
      g.closePath();
    };
    // metal (blocks, beams, machine frames): solid black with a pale bevel; the press plate white
    for (const p of pr.parts) {
      if (!p.box) continue;
      g.beginPath();
      g.moveTo(p.wc[0][0], p.wc[0][1]);
      for (let i = 1; i < 4; i++) g.lineTo(p.wc[i][0], p.wc[i][1]);
      g.closePath();
      if (p.off) {
        // an open door, swung out toward us
        const top = p.wc[1], bot = p.wc[2], k = 18 * S;
        g.beginPath(); g.moveTo(top[0], top[1]); g.lineTo(top[0] + k, top[1] + 7 * S); g.lineTo(bot[0] + k, bot[1] - 7 * S); g.lineTo(bot[0], bot[1]); g.closePath();
        g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#000'; g.lineWidth = ow; g.stroke();
        continue;
      }
      g.fillStyle = p.metal ? '#111' : '#fff'; g.fill();
      g.strokeStyle = '#000'; g.lineWidth = ow; g.stroke();
      if (p.metal && p.hw > 4 * S && p.hh > 4 * S) {
        const k = 2.5 * S, c = pr.c ?? Math.cos(pr.a), s = pr.s ?? Math.sin(pr.a);
        const pt = (lx, ly) => [p.wa[0] + c * lx - s * ly, p.wa[1] + s * lx + c * ly];
        const a1 = pt(-p.hw + k, p.hh - k), a2 = pt(-p.hw + k, -p.hh + k), a3 = pt(p.hw - k, -p.hh + k);
        g.strokeStyle = '#777'; g.lineWidth = Math.max(1, 0.8 * S);
        g.beginPath(); g.moveTo(a1[0], a1[1]); g.lineTo(a2[0], a2[1]); g.lineTo(a3[0], a3[1]); g.stroke();
      }
      if (p.gen) {
        // a lightning bolt on the casing, yellow while it runs
        const c = pr.c ?? Math.cos(pr.a), sn = pr.s ?? Math.sin(pr.a), k = Math.min(p.hw, p.hh) * 0.75;
        const pt = (lx, ly) => [p.wa[0] + c * lx - sn * ly, p.wa[1] + sn * lx + c * ly];
        const bolt = [[0.15, -1], [-0.5, 0.15], [-0.05, 0.15], [-0.2, 1], [0.5, -0.2], [0.05, -0.2]].map(([u, v]) => pt(u * k, v * k));
        g.beginPath(); g.moveTo(bolt[0][0], bolt[0][1]);
        for (const b of bolt.slice(1)) g.lineTo(b[0], b[1]);
        g.closePath(); g.fillStyle = pr.on && g === ctx ? '#ffd23f' : '#fff'; g.fill();
      }
      if (p.plate) {
        g.strokeStyle = '#000'; g.lineWidth = Math.max(1, 0.8 * S);
        for (let i = -3; i <= 3; i++) {
          const x0 = p.wa[0] + i * p.hw / 3.5;
          g.beginPath(); g.moveTo(x0 - 2 * S, p.wa[1] + p.hh); g.lineTo(x0 + 2 * S, p.wa[1] - p.hh); g.stroke();
        }
      }
    }
    // outlines first, then fills, so touching parts read as one object
    for (const p of pr.parts) {
      if (p.kind === 'blade' || p.box) continue;
      g.strokeStyle = '#000'; g.lineWidth = p.r * 2 + ow * 2;
      g.beginPath(); g.moveTo(p.wa[0], p.wa[1]); g.lineTo(p.wb[0], p.wb[1]); g.stroke();
    }
    for (const p of pr.parts) {
      if (p.kind === 'blade' || p.box) continue;
      g.strokeStyle = p.bulb && pr.lit ? '#fff0a0' : p.glass || (p.kind === 'grip' || p.bomb ? '#000' : '#fff'); g.lineWidth = p.r * 2;
      g.beginPath(); g.moveTo(p.wa[0], p.wa[1]); g.lineTo(p.wb[0] + 0.01, p.wb[1]); g.stroke();
      if (p.flame) {
        // a flame that always burns straight up, whichever way the torch points
        const fx = p.wb[0], fy = p.wb[1], hgt = (14 + (g === ctx ? Math.random() * 6 : 3)) * S, w = 5 * S;
        g.fillStyle = '#ff7a1a';
        g.beginPath(); g.moveTo(fx - w, fy); g.quadraticCurveTo(fx - w * 0.6, fy - hgt * 0.6, fx, fy - hgt); g.quadraticCurveTo(fx + w * 0.6, fy - hgt * 0.6, fx + w, fy); g.closePath(); g.fill();
        g.fillStyle = '#ffd23f';
        g.beginPath(); g.moveTo(fx - w * 0.5, fy); g.lineTo(fx, fy - hgt * 0.55); g.lineTo(fx + w * 0.5, fy); g.closePath(); g.fill();
      }
      if (p.bomb) {
        // a fuse on top, a spark while it burns, and the seconds left
        const fx = p.wa[0] + p.r * 0.5, fy = p.wa[1] - p.r;
        g.strokeStyle = '#000'; g.lineWidth = 1.4 * S;
        g.beginPath(); g.moveTo(fx - p.r * 0.3, fy + p.r * 0.2); g.quadraticCurveTo(fx + p.r * 0.4, fy - p.r * 0.4, fx + p.r * 0.6, fy - p.r * 0.7); g.stroke();
        g.strokeStyle = '#fff'; g.lineWidth = 1.2 * S;
        g.beginPath(); g.arc(p.wa[0] - p.r * 0.3, p.wa[1] - p.r * 0.3, p.r * 0.35, Math.PI * 1.1, Math.PI * 1.6); g.stroke();
        if (!pr.ghost && pr.fuse !== undefined && g === ctx) {
          if ((pr.fuse * 6) % 1 < 0.5) { g.fillStyle = BLOOD; g.fillRect(fx + p.r * 0.6 - 1.5 * S, fy - p.r * 0.7 - 1.5 * S, 3 * S, 3 * S); }
          g.fillStyle = '#000';
          g.font = `600 ${Math.round(11 * Math.max(0.8, S))}px "IBM Plex Mono", ui-monospace, monospace`;
          g.textAlign = 'center'; g.textBaseline = 'bottom';
          g.fillText(Math.max(0, pr.fuse).toFixed(1), p.wa[0], p.wa[1] - p.r - 8 * S);
          g.textAlign = 'left';
        }
      }
    }
    for (const p of pr.parts) {
      if (p.kind !== 'blade') continue;
      bladeShape(p);
      g.fillStyle = '#fff'; g.fill();
      if (pr.blood > 0.02) { g.fillStyle = `rgba(200,16,46,${Math.min(0.85, pr.blood)})`; g.fill(); }
      g.strokeStyle = '#000'; g.lineWidth = ow; g.stroke();
    }
    g.restore();
  }

  function drawProps() {
    for (const pr of props) if (!pr.ghost) drawProp(ctx, pr);
    if (spawnDrag) drawProp(ctx, spawnDrag, 0.55);
    if (heldProp) {
      const [gx, gy] = propPoint(heldProp.prop, heldProp.lx, heldProp.ly);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(pointer.x, pointer.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#000'; ctx.fillRect(gx - 3, gy - 3, 6, 6);
    }
  }

  // ---------- turning with A and D ----------
  const keysDown = new Set();
  const turnKeys = () => (keysDown.has('KeyD') ? 1 : 0) - (keysDown.has('KeyA') ? 1 : 0); // D clockwise, A anticlockwise
  window.addEventListener('keydown', e => {
    if (e.code !== 'KeyA' && e.code !== 'KeyD') return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    keysDown.add(e.code);
  });
  window.addEventListener('keyup', e => keysDown.delete(e.code));
  window.addEventListener('blur', () => keysDown.clear());

  // ---------- the props menu: drag things out onto the field ----------
  const propsPanel = document.getElementById('propsPanel');
  const propsBtn = document.getElementById('propsBtn');
  function toggleProps(open) {
    propsPanel.hidden = !(open ?? propsPanel.hidden);
    propsBtn.setAttribute('aria-pressed', String(!propsPanel.hidden));
  }
  propsBtn.addEventListener('click', () => toggleProps());
  propsPanel.querySelector('[data-close]').addEventListener('click', () => toggleProps(false));

  function buildPropsPanel() {
    const grid = propsPanel.querySelector('.pp-grid');
    grid.textContent = '';
    for (const kind of Object.keys(PROP_KINDS)) {
      const tile = document.createElement('button');
      tile.type = 'button'; tile.className = 'pp-tile'; tile.dataset.kind = kind;
      tile.setAttribute('aria-label', 'Drag the ' + PROP_KINDS[kind].name.toLowerCase() + ' onto the field');
      const c = document.createElement('canvas');
      c.width = 200; c.height = 80;
      const g = c.getContext('2d');
      // draw it to fit the tile
      const pr = makeProp(kind, 0, 0, 0);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pr.parts) for (const e of (p.box ? p.wc : [p.wa, p.wb])) {
        x0 = Math.min(x0, e[0] - p.r); x1 = Math.max(x1, e[0] + p.r); y0 = Math.min(y0, e[1] - p.r); y1 = Math.max(y1, e[1] + p.r);
      }
      const fit = Math.min(180 / (x1 - x0), 64 / (y1 - y0), 2.2);
      g.translate(100, 40); g.scale(fit, fit); g.translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
      drawProp(g, pr);
      tile.append(c);
      const label = document.createElement('span');
      label.textContent = PROP_KINDS[kind].name;
      tile.append(label);
      tile.addEventListener('pointerdown', startSpawnDrag);
      grid.append(tile);
    }
    const tile = document.createElement('button');
    tile.type = 'button'; tile.className = 'pp-tile';
    tile.setAttribute('aria-label', 'Wire: drag onto one thing, then click another');
    const c = document.createElement('canvas');
    c.width = 200; c.height = 80;
    const g = c.getContext('2d');
    g.lineCap = 'round'; g.strokeStyle = '#000'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(30, 30); g.quadraticCurveTo(100, 85, 170, 30); g.stroke();
    g.fillStyle = '#000'; g.fillRect(22, 22, 14, 14); g.fillRect(164, 22, 14, 14);
    tile.append(c);
    const label = document.createElement('span');
    label.textContent = 'Wire';
    tile.append(label);
    tile.addEventListener('pointerdown', startWireDrag);
    grid.append(tile);
  }

  function startSpawnDrag(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = pos(e);
    pointer.x = p.x; pointer.y = p.y;
    const pr = spawnDrag = makeProp(e.currentTarget.dataset.kind, p.x, p.y, 0);
    pr.ghost = true;
    const move = ev => {
      const q = pos(ev);
      pointer.x = q.x; pointer.y = q.y;
      pr.x = q.x; pr.y = q.y;
      propWorld(pr);
    };
    const up = ev => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      spawnDrag = null;
      const r = propsPanel.getBoundingClientRect();
      const overPanel = !propsPanel.hidden && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (ev.type === 'pointercancel' || overPanel) return;
      // dropped: from now on it is solid, and falls from rest
      move(ev);
      pr.ghost = false; pr.vx = pr.vy = pr.w = 0;
      if (pr.fixed) { pr.y = G; pr.a = 0; propWorld(pr); }
      if (props.length >= 40) props.shift();
      props.push(pr);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // the prop being dragged out turns with A / D too, about where it is held
  function updateSpawnDrag(dt) {
    if (!spawnDrag) return;
    if (!spawnDrag.fixed) spawnDrag.a += turnKeys() * 3.2 * dt;   // machines stay upright
    propWorld(spawnDrag);
  }

  // ---------- the world: food and smells ----------
  // A smell, to a fly, is which odour receptor types (glomeruli) fire. Each item here drives
  // its own set, so the brain sees distinct smells and can learn about each separately.
  // Geosmin, the smell of mould, is picked up by DA2 receptors and flies avoid it
  // (Stensmyr et al. 2012). The fruit sets are ester-sensing glomeruli, chosen to differ.
  const ITEM_KINDS = {
    banana: { name: 'Banana', smell: ['ORN_DM1', 'ORN_DM2', 'ORN_DM4', 'ORN_VA2'], taste: 'GUS_SWEET', food: true },
    apple:  { name: 'Apple', smell: ['ORN_DP1m', 'ORN_DM3', 'ORN_VM2', 'ORN_VM3'], taste: 'GUS_SWEET', food: true },
    bitter: { name: 'Bitter pill', smell: ['ORN_DL5', 'ORN_VM7d', 'ORN_VC3'], taste: 'GUS_BITTER', food: true },
    mold:   { name: 'Mould', smell: ['ORN_DA2'], taste: null, food: false, danger: true },
    bait:   { name: 'Poison bait', smell: ['ORN_VA3', 'ORN_DM5', 'ORN_VC4'], taste: 'GUS_SWEET', food: true, poison: true },
  };
  // Stressed and injured flies give off CO2 and other flies avoid it (Suh et al. 2004); the
  // V glomerulus senses it. Hurt or frightened people here do the same.
  const CO2_SMELL = ['ORN_V'];
  const items = [];
  let heldItem = null;

  function addItem(kind, x) {
    items.push({ kind, x: Math.max(20 * S, Math.min(W - 20 * S, x)), amount: 1 });
  }

  function co2Of(p) {
    if (p.dead) return 0.25;
    return Math.min(1, Math.max(0, (100 - p.blood) / 60) + (p.mind ? p.mind.fear * 0.4 : 0));
  }

  // how strongly each smell reaches a point: concentration falls off with distance
  function smellAt(x, y, self) {
    const out = {};
    for (const it of items) {
      const c = it.amount * Math.exp(-Math.hypot(it.x - x, G - 8 * S - y) / (220 * S));
      if (c > 0.02) out[it.kind] = Math.max(out[it.kind] || 0, c);
    }
    for (const p of people) {
      if (p === self) continue;
      const st = co2Of(p);
      if (st < 0.05) continue;
      const [cx, cy] = rowMid(p.pts, p.bones[CHEST].mid);
      const c = st * Math.exp(-Math.hypot(cx - x, cy - y) / (200 * S));
      if (c > 0.02) out.co2 = Math.max(out.co2 || 0, c);
    }
    return out;
  }

  // ---------- a mind: senses, reflexes, drives, and choosing what to do ----------
  const MAX_BRAINS = 2;
  const MODE_NAMES = {
    idle: 'standing', wander: 'wandering', flee: 'fleeing', freeze: 'frozen', cower: 'cowering',
    flinch: 'flinching', seek: 'looking for food', eat: 'eating', avoid: 'avoiding', rub: 'rubbing the sore spot', rest: 'resting',
    down: 'down', ko: 'knocked out', held: 'held', dead: 'dead', burning: 'on fire', sick: 'sick', iced: 'frozen solid',
    shocked: 'electrocuted', light: 'drawn to the light',
  };

  function newMind() {
    return {
      now: 0, tickAcc: 0, fear: 0, hunger: 0.45, fatigue: 0,
      pain: 0, head: 0, touchBody: 0, touchHead: 0, hab: 0,
      threatX: null, threatT: -99, hitPart: null, hitT: -99, flinchT: 0, flinchAt: -9, hopAt: -9,
      mode: 'idle', why: '', target: null, turnCool: 0, backT: 0,
      wanderT: 0, wanderDir: 0, smell: {}, taste: null, tasteItem: null,
      odorSeen: {}, disgust: {}, punishT: 0,
    };
  }

  function brainPulse(person, inputs) { if (person.brain && person.brain.ready) person.brain.pulse(inputs); }

  function headPos(person) { return rowMid(person.pts, person.bones[HEAD].mid); }
  function chestPos(person) { return rowMid(person.pts, person.bones[CHEST].mid); }

  // A hit, felt. The quick part happens right here, the way the fly's nerve cord would do it
  // without waiting for the brain: flinch, and for a hard hit a hop away plus a kick to the
  // Giant Fiber escape neurons. Pain also drives the PPL1 punishment neurons, which is what
  // lets the brain tie whatever it was smelling to getting hurt.
  function feel(person, i, speed, x) {
    const m = person.mind, q = person.pts[i];
    let sev = (speed - 350 * S) / (1800 * S);
    if (sev <= 0 || person.dead) return;
    sev *= 1 + Math.min(1, q.hurt);             // a sore spot hurts more (sensitisation)
    if (sev < 0.3) sev *= 1 - m.hab;             // the same light knock again and again counts less
    else m.hab = 0;                              // but a real hurt wakes everything up again
    sev = Math.min(1.5, sev);
    if (q.bone === HEAD) m.head = Math.max(m.head, sev); else m.pain = Math.max(m.pain, sev);
    m.fear = Math.min(1, m.fear + sev * 0.35);
    m.threatX = x; m.threatT = m.now; m.hitPart = q.bone; m.hitT = m.now;
    if (sev > 0.12 && m.now - m.flinchAt > 0.4) {
      m.flinchAt = m.now; m.flinchT = 0.35;
      if (sev < 0.3) m.hab = Math.min(0.8, m.hab + 0.12);
      brainPulse(person, { DAN_PPL1: 1.5 + 3 * sev });
      m.punishT = Math.max(m.punishT || 0, 0.3 + 0.4 * Math.min(1, sev));   // the hurt lingers a moment
    }
    if (sev > 0.35 && person.standing && m.now - m.hopAt > 1) {
      m.hopAt = m.now;
      hopAway(person, Math.sign(chestPos(person)[0] - x) || -person.dir);
      brainPulse(person, { DN_GF: 4 });
    }
  }

  // someone grabbed them: a light touch where they were grabbed
  function feelTouch(person, i) {
    const m = person.mind;
    const t = 0.5 * (1 - m.hab);
    if (person.pts[i].bone === HEAD) m.touchHead = Math.max(m.touchHead, t); else m.touchBody = Math.max(m.touchBody, t);
    m.hab = Math.min(0.8, m.hab + 0.08);
    m.fear = Math.min(1, m.fear + 0.06 * (1 - m.hab));
  }

  // things flying at the head: how fast the nearest one closes in
  function looming(person) {
    const [hx, hy] = headPos(person);
    let best = 0, from = null;
    for (const p of people) {
      if (p === person) continue;
      const P = p.pts;
      for (let i = 0; i < P.length; i += 6) {
        const q = P[i];
        const dx = hx - q.x, dy = hy - q.y, d = Math.hypot(dx, dy);
        if (d > 260 * S || d < 1) continue;
        const closing = ((q.x - q.px) * dx + (q.y - q.py) * dy) / d / lastH;
        const l = Math.min(1, closing / (1500 * S)) * (1 - d / (260 * S));
        if (l > best) { best = l; from = q.x; }
      }
    }
    for (const pr of props) {
      if (pr.ghost || skewerOf(pr, person)) continue;
      const dx = hx - pr.x, dy = hy - pr.y, d = Math.hypot(dx, dy);
      if (d > 260 * S || d < 1) continue;
      const closing = (pr.vx * dx + pr.vy * dy) / d;
      const l = Math.min(1, closing / (1500 * S)) * (1 - d / (260 * S));
      if (l > best) { best = l; from = pr.x; }
    }
    return { amount: best, from };
  }

  function attachBrain(person) {
    if (person.brain || people.filter(p => p.brain).length >= MAX_BRAINS) return;
    person.mind = newMind();
    person.brainStatus = 'Loading the brain (13 MB)…';
    showPanel(person);
    FlyBrain.load().then(() => {
      if (!people.includes(person) || person.brain) return;
      person.brain = new FlyBrain();
      person.brainStatus = 'Wiring up 2.7 million connections…';
      updateCount();
    }).catch(err => {
      person.brainStatus = location.protocol === 'file:'
        ? 'The brain can\'t load when the page is opened straight from the file. Close this page and double-click "Play.bat" in the game folder (or run: python tools/serve.py, then open http://localhost:8000/).'
        : 'Couldn\'t load the brain (' + err.message + ').';
      person.mind = null;
    });
  }

  function detachBrain(person) {
    if (person.brain) person.brain.kill();
    person.brain = null; person.mind = null;
    person.walkV = 0; person.posture = 'stand'; person.rubT = 0;
    if (panelPerson === person) hidePanel();
    updateCount();
  }

  function updateMinds(dt) {
    for (const person of people) {
      const m = person.mind;
      if (!m) continue;
      m.now += dt;
      m.hunger = Math.min(1, m.hunger + dt * 0.004);
      const running = Math.abs(person.walkV) > 100 * S;
      m.fatigue = Math.max(0, Math.min(1, m.fatigue + dt * (running ? 0.03 : person.walkV ? 0.006 : -0.025)));
      m.fear *= Math.exp(-dt / 18);
      m.hab *= Math.exp(-dt / 25);
      m.flinchT -= dt; m.turnCool -= dt; m.backT -= dt; m.wanderT -= dt;
      if (person.rubT > 0) person.rubT -= dt;
      if (!person.brain || !person.brain.ready) { person.walkV = 0; continue; }
      if (person.frozen) { m.mode = 'iced'; m.why = 'frozen solid, can\'t move'; person.walkV = 0; continue; }
      if (person.brainStatus) person.brainStatus = '';
      m.tickAcc += dt;
      if (m.tickAcc >= 0.1) { m.tickAcc = 0; think(person); }
      act(person, dt);
    }
  }

  // how cold a body is getting (frost it carries), felt before it freezes solid
  function coldness(person) {
    let f = 0, n = 0;
    for (const q of person.pts) if (!q.anchor && !q.ghost) { f += q.frost; n++; }
    return n ? Math.min(1, f / n * 1.5) : 0;
  }

  // ten times a second: gather the senses, feed the brain, read it, pick what to do
  function think(person) {
    const m = person.mind, b = person.brain, a = b.act;
    const heldHere = held && held.person === person;
    const [hx, hy] = headPos(person), [cx, cy] = chestPos(person);
    const P = person.pts, chest = P[person.bones[CHEST].core];
    const speed = Math.hypot(chest.x - chest.px, chest.y - chest.py) / lastH;
    const alive = !person.dead;

    // senses
    m.smell = alive ? smellAt(hx, hy, person) : {};
    m.taste = null; m.tasteItem = null;
    if (alive) {
      const hands = [rowMid(P, person.bones[8].end), rowMid(P, person.bones[10].end), [hx, hy]];
      for (const it of items) {
        if (!ITEM_KINDS[it.kind].taste) continue;
        // a hand right over it and down low (bending to pick it up), or the mouth on it
        if (hands.some(([x, y]) => Math.abs(x - it.x) < 26 * S && y > G - 50 * S)) { m.taste = it.kind; m.tasteItem = it; break; }
      }
    }
    const jo = heldHere ? 0.25 + Math.min(0.75, speed / (800 * S)) : person.grounded ? 0 : Math.min(1, speed / (1000 * S));
    const loom = alive ? looming(person) : { amount: 0 };
    if (loom.amount > 0.25) { m.threatX = loom.from; m.threatT = m.now; m.fear = Math.min(1, m.fear + loom.amount * 0.08); }

    const input = {};
    if (alive) {
      input.ASC = Math.min(1, m.pain + m.touchBody) * 0.8;
      input.MECH_BRISTLE = Math.min(1, m.head + m.touchHead) * 0.8;
      input.MECH_JO = jo * 0.5;
      input.VIS_LOOM = loom.amount * 0.6;
      input.OA = m.fear * 0.3;
      input.HUNGER = m.hunger * 0.2;
      input.FATIGUE = m.fatigue * 0.2;
      // heat and cold are felt by the thermosensory neurons; burning hurts on top
      input.THERMO = Math.min(1, (person.burning || 0) * 4 + (person.frozen ? 0 : coldness(person)));
      // light falls on the photoreceptors; current through the body is pain everywhere at once
      m.light = lightAt(hx, hy);
      input.VIS_PHOTO = Math.min(0.6, m.light.amount * 0.8);
      if (person.shockT > 0) { input.ASC = 1; input.MECH_BRISTLE = 0.8; }
      if (person.burning > 0) input.ASC = Math.max(input.ASC, Math.min(1, 0.4 + person.burning * 3));
      // sick from poison: a lingering aftertaste of what was eaten, and the gut's alarm
      if (person.poison > 0.12 && m.lastAte) for (const s of ITEM_KINDS[m.lastAte].smell) input[s] = Math.max(input[s] || 0, 0.25);
      for (const k in m.smell) {
        const sets = k === 'co2' ? CO2_SMELL : ITEM_KINDS[k].smell;
        for (const s of sets) input[s] = Math.max(input[s] || 0, Math.min(0.4, 0.3 * m.smell[k] + 0.05));
      }
      if (m.taste) input[ITEM_KINDS[m.taste].taste] = 0.5;
    }
    let strongest = null, sc = 0.12;
    for (const k in m.smell) if (k !== 'co2' && ITEM_KINDS[k].food && m.smell[k] > sc) { strongest = k; sc = m.smell[k]; }
    // the malaise of poisoning punishes the taste that caused it, a while after the meal
    // (conditioned taste aversion): the aftertaste above is what the punishment lands on
    if (person.poison > 0.12 && m.lastAte && ITEM_KINDS[m.lastAte].poison) {
      if (!strongest) strongest = m.lastAte;
      if (m.now - (m.sickAt ?? -9) > 1.2) { m.sickAt = m.now; brainPulse(person, { DAN_PPL1: 3.5 }); }
    }
    // telling the brain which smell this is lets it build that smell's Kenyon cell fingerprint
    b.hold(input, strongest);
    if (strongest) m.odorSeen[strongest] = (m.odorSeen[strongest] || 0) + 1;
    if (m.punishT > 0) { m.punishT -= 0.1; brainPulse(person, { DAN_PPL1: 3 }); }
    m.pain *= 0.5; m.head *= 0.5; m.touchBody *= 0.5; m.touchHead *= 0.5;

    // rewards and punishments from eating
    if (m.mode === 'eat' && m.taste) {
      if (ITEM_KINDS[m.taste].taste === 'GUS_SWEET') brainPulse(person, { DAN_PAM: 1.2 });
      else { brainPulse(person, { DAN_PPL1: 1.5 }); m.disgust[m.taste] = m.now; m.fear = Math.min(1, m.fear + 0.05); }
    }

    decide(person, strongest);
  }

  // What the mushroom body has learned about a smell. The memory is in the Kenyon cell -> MBON
  // synapses; the brain reports how strong they still are for this smell's Kenyon cells
  // (1 = untouched). Punishment weakens the approach side, reward the avoidance side, so
  // approach minus avoidance below zero means "learned to avoid", above zero "learned to like".
  function learned(person, kind) {
    const o = person.brain && person.brain.memory.odors && person.brain.memory.odors[kind];
    return o ? o.approach - o.avoid : 0;
  }

  // Avoid a food smell when it has become clearly worse than the other food smells this brain
  // knows (as in a two-choice test), or when it is very strongly disliked. Some dislike spreads
  // to other smells through shared Kenyon cells, so comparing with them keeps that from making
  // every food repellent.
  function dislikes(person, kind) {
    const l = learned(person, kind);
    const odors = (person.brain && person.brain.memory.odors) || {};
    const others = Object.keys(odors).filter(k => k !== kind && ITEM_KINDS[k] && ITEM_KINDS[k].food);
    const ref = others.length ? others.reduce((a, k) => a + learned(person, k), 0) / others.length : 0;
    return l < -0.7 || (l < -0.35 && l < ref - 0.1);
  }

  function decide(person, food) {
    const m = person.mind, a = person.brain.act;
    const [cx] = chestPos(person);
    const pct = v => Math.round(v * 100) + '%';
    let mode = 'idle', why = '';
    if (person.dead) mode = 'dead';
    else if (held && held.person === person) { mode = 'held'; why = 'wind/gravity ' + pct(a.MECH_JO); }
    else if (person.shockT > 0) { mode = 'shocked'; why = 'current through the body · pain ' + pct(a.ASC); }
    else if (person.ko > 0) mode = 'ko';
    else if (!person.standing) mode = 'down';
    else if (person.burning > 0.02) { mode = 'burning'; why = 'on fire · heat ' + pct(a.THERMO) + ' · pain ' + pct(a.ASC); }
    else if (m.flinchT > 0) { mode = 'flinch'; why = 'pain → PPL1 ' + pct(a.DAN_PPL1); }
    else if (m.now - m.threatT < 6 && (m.fear > 0.35 || a.DN_MDN > 0.05)) {
      const away = Math.sign(cx - (m.threatX ?? cx - person.dir)) || -person.dir;
      const cornered = (away < 0 && cx < 90 * S) || (away > 0 && cx > W - 90 * S);
      if (cornered && m.fear > 0.5) { mode = 'cower'; why = 'backed into a wall, fear ' + m.fear.toFixed(2); }
      else if (a.DN_P09 > 0.05 && m.fear < 0.6) { mode = 'freeze'; why = 'DNp09 ' + pct(a.DN_P09); }
      else {
        // the MDN "moonwalker" neurons make a fly back straight away before it turns to run
        if (m.mode !== 'flee' && a.DN_MDN > 0.04) m.backT = 0.8;
        mode = 'flee'; m.target = away; why = 'fear ' + m.fear.toFixed(2) + ' · MDN ' + pct(a.DN_MDN) + ' · OA ' + pct(a.OA);
      }
    }
    else if (person.poison > 0.35) { mode = 'sick'; why = 'poisoned ' + pct(Math.min(1, person.poison)); }
    else if (m.fatigue > 0.8) { mode = 'rest'; why = 'tired ' + m.fatigue.toFixed(2); }
    else if ((m.smell.mold || 0) > 0.15 || (m.smell.co2 || 0) > 0.2) {
      const src = nearestSource(person, m.smell.mold > (m.smell.co2 || 0) ? 'mold' : 'co2');
      mode = 'avoid'; m.target = Math.sign(cx - src) || -person.dir;
      why = m.smell.mold > (m.smell.co2 || 0) ? 'smell of mould (DA2 receptors)' : 'CO2 from someone hurt (V receptors)';
    }
    else if (food && m.hunger > 0.25 && !(person.poison > 0.12)) {   // (nausea kills the appetite)
      const it = nearestItem(person, food), l = learned(person, food);
      const disgusted = m.now - (m.disgust[food] ?? -99) < 30;
      if (dislikes(person, food) || disgusted) {
        mode = 'avoid'; m.target = Math.sign(cx - it.x) || -person.dir;
        why = disgusted ? 'just tasted something bitter' : 'learned to dislike the smell of ' + ITEM_KINDS[food].name.toLowerCase() + ' (Kenyon→approach MBON weakened ' + Math.round(-l * 100) + '%)';
      } else if (m.taste === food && (a.MN_FEED > 0.005 || ITEM_KINDS[food].taste === 'GUS_SWEET')) {
        mode = 'eat'; why = (ITEM_KINDS[food].taste === 'GUS_SWEET' ? 'sweet' : 'bitter') + ' taste · feeding motor ' + pct(a.MN_FEED);
      } else if (it) {
        mode = 'seek'; m.target = Math.sign(it.x - cx) || person.dir;
        why = 'hungry ' + m.hunger.toFixed(2) + ' · smells ' + ITEM_KINDS[food].name.toLowerCase();
      }
    }
    else if (m.now - m.hitT < 8 && m.fear < 0.3 && m.hitPart !== null) { mode = 'rub'; why = 'where it was just hit'; }
    // flies are drawn to light (positive phototaxis)
    else if (m.light && m.light.amount > 0.25 && Math.abs(m.light.from - cx) > 30 * S) {
      mode = 'light'; m.target = Math.sign(m.light.from - cx); why = 'drawn to the light · photoreceptors ' + pct(a.VIS_PHOTO);
    }
    else {
      mode = 'wander';
      // mostly on the move, now and then a short pause (a fly at rest still explores)
      if (m.wanderT <= 0) {
        const pause = m.wanderDir && Math.random() < 0.3;
        m.wanderDir = pause ? 0 : Math.random() < 0.5 ? -1 : 1;
        m.wanderT = pause ? 0.8 + Math.random() * 1.5 : 3 + Math.random() * 4;
      }
    }
    m.mode = mode; m.why = why;
  }

  function nearestItem(person, kind) {
    const [cx] = chestPos(person);
    let best = null;
    for (const it of items) if (it.kind === kind && (!best || Math.abs(it.x - cx) < Math.abs(best.x - cx))) best = it;
    return best;
  }

  function nearestSource(person, kind) {
    const [cx] = chestPos(person);
    if (kind === 'co2') {
      let best = null, bs = 0;
      for (const p of people) if (p !== person && co2Of(p) > bs) { bs = co2Of(p); best = chestPos(p)[0]; }
      return best ?? cx;
    }
    const it = nearestItem(person, kind);
    return it ? it.x : cx;
  }

  // walk in a direction: turn round first, or step backwards if the MDN "back up" neurons say so
  function moveToward(person, dir, speed, backOk) {
    const m = person.mind;
    if (dir === person.dir) { person.walkV = dir * speed; return; }
    if (backOk && m.backT > 0) { person.walkV = dir * Math.min(speed, 60 * S); return; }
    person.walkV = 0;
    // turn only once both feet are down and still, never mid-stride
    if (m.turnCool <= 0 && person.posture === 'stand' && m.stillFor > 0.3) { turnAround(person); person.gait = 0; m.turnCool = 0.5; }
  }

  // every frame: turn the chosen mode into a posture and walking speed
  function act(person, dt) {
    const m = person.mind, a = person.brain.act;
    const [cx] = chestPos(person);
    let posture = 'stand', walk = 0, dir = 0, backOk = false;
    // Someone who has only just got up must stand steady for a moment first, whatever the brain
    // wants: setting off, crouching, cowering or rubbing a sore spot half-risen knocks them
    // straight back down, and they never get going. (It counts only while fully upright, but once
    // steady they stay so until they fall, so bending down to eat doesn't reset it.)
    const [, hy] = headPos(person);
    if (!person.standing) m.upT = 0;
    else if (m.upT > 0.8 || hy < G - 128 * S) m.upT = (m.upT || 0) + dt;
    const steady = m.upT > 0.8;
    switch (m.mode) {
      case 'flinch': posture = 'flinch'; break;
      case 'cower': posture = 'cower'; break;
      case 'rest': case 'sick': posture = 'crouch'; break;
      case 'burning': dir = person.dir; walk = 170 * S; break;   // running blind, flames and all
      case 'eat': {
        posture = 'crouch';
        const it = m.tasteItem;
        if (it && ITEM_KINDS[it.kind].taste === 'GUS_SWEET') {
          it.amount -= dt * 0.1; m.hunger = Math.max(0, m.hunger - dt * 0.3);
          m.lastAte = it.kind;
          if (ITEM_KINDS[it.kind].poison) person.poison = Math.min(1.3, (person.poison || 0) + dt * 0.35);
          if (it.amount <= 0) items.splice(items.indexOf(it), 1);
        }
        break;
      }
      case 'flee':
        dir = m.target; backOk = a.DN_MDN > 0.04;
        walk = Math.min(170, 90 + 80 * m.fear + 600 * a.OA) * S;
        break;
      case 'avoid': dir = m.target; walk = 60 * S; break;
      case 'seek': {
        const it = m.target && nearestItem(person, Object.keys(m.smell).find(k => ITEM_KINDS[k] && ITEM_KINDS[k].food && m.smell[k] > 0.12));
        if (it && Math.abs(it.x - cx) > 22 * S) { dir = m.target; walk = 55 * S; m.stillT = 0; }
        else if ((m.stillT = (m.stillT || 0) + dt) > 0.5) posture = 'crouch';   // there: stop, then bend down to it
        break;
      }
      case 'rub': if (steady) { person.rubT = 0.2; person.rubPart = m.hitPart; } break;
      case 'wander': if (m.wanderDir) { dir = m.wanderDir; walk = 50 * S; } break;
      case 'light': dir = m.target; walk = 45 * S; break;
    }
    // don't walk into the walls, or into someone just ahead: bumping into each other knocks
    // both over. Wandering turns back; anything else waits.
    const blocked = dir && people.some(p => {
      if (p === person) return false;
      const ahead = (chestPos(p)[0] - cx) * dir;
      return ahead > 0 && ahead < 38 * S;
    });
    if (dir && (blocked || (dir < 0 && cx < 50 * S) || (dir > 0 && cx > W - 50 * S))) { walk = 0; if (m.mode === 'wander') m.wanderDir = -m.wanderDir; }
    // straighten up fully before setting off: walking out of a crouch topples them
    const bent = person.posture !== 'stand' || (person.htCur && person.htCur[2] < 76);
    if (walk && (bent || !steady)) walk = 0, posture = 'stand';
    if (!steady && posture !== 'flinch') posture = 'stand';
    person.posture = walk ? 'stand' : posture;
    m.stillFor = person.walkV ? 0 : (m.stillFor || 0) + dt;
    if (walk && dir) moveToward(person, dir, walk, backOk); else person.walkV = 0;
  }

  // ---------- the brain panel ----------
  const panelEl = document.getElementById('brainPanel');
  let panelPerson = null, panelAcc = 0;
  const PANEL_ROWS = [
    ['Senses', ['ASC', 'MECH_BRISTLE', 'MECH_JO', 'VIS_LOOM', 'OLF_ORN', 'GUS_SWEET', 'GUS_BITTER']],
    ['Central', ['OLF_PN', 'LH', 'KC', 'MBON_AP', 'MBON_AV', 'DAN_PPL1', 'DAN_PAM', 'OA']],
    ['Motor commands', ['DN_GF', 'DN_MDN', 'DN_TURN_L', 'DN_TURN_R', 'DN_P09', 'MN_FEED']],
  ];
  const STRIP = ['ASC', 'VIS_LOOM', 'OLF_ORN', 'KC', 'DAN_PPL1', 'DAN_PAM', 'OA', 'DN_GF', 'DN_MDN', 'MN_FEED'];
  const RED_ROWS = new Set(['ASC', 'DAN_PPL1', 'DN_GF']);

  function showPanel(person) { panelPerson = person; panelEl.hidden = false; renderPanel(true); }
  function hidePanel() { panelPerson = null; panelEl.hidden = true; }
  panelEl.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) hidePanel();
    if (e.target.closest('[data-3d]')) open3D(panelPerson);
  });
  // the 3D brain; lights up with the given person's brain, or the first brain in the field
  function open3D(person) {
    Brain3D.open(() => {
      const p = person && people.includes(person) && person.brain ? person : people.find(q => q.brain);
      return p ? p.brain : null;
    });
  }

  function renderPanel(force) {
    const person = panelPerson;
    if (!person) return;
    const meta = FlyBrain.meta && FlyBrain.meta();
    const labels = {};
    if (meta) meta.groups.forEach(g => { labels[g.name] = g.label; });
    const m = person.mind, b = person.brain;
    if (!m || !b || !b.ready || !meta) {
      panelEl.querySelector('.bp-body').innerHTML = '<p class="bp-status">' + (person.brainStatus || 'No brain attached.') + '</p>';
      return;
    }
    const a = b.act;
    const bar = (v, red) => '<span class="bp-bar"><span style="width:' + Math.min(100, v * 600).toFixed(1) + '%"' + (red ? ' class="red"' : '') + '></span></span>';
    let html = '<p class="bp-mode"><b>' + MODE_NAMES[m.mode] + '</b>' + (m.why ? ' <span>— ' + m.why + '</span>' : '') + '</p>';
    html += '<div class="bp-sec"><h3>Needs</h3>' +
      [['Fear', m.fear], ['Hunger', m.hunger], ['Fatigue', m.fatigue], ['Blood', person.blood / 100]]
        .map(([n, v]) => '<div class="bp-row"><span>' + n + '</span>' + '<span class="bp-bar"><span style="width:' + (v * 100).toFixed(0) + '%"></span></span><span class="bp-num">' + v.toFixed(2) + '</span></div>').join('') + '</div>';
    for (const [title, names] of PANEL_ROWS) {
      html += '<div class="bp-sec"><h3>' + title + '</h3>' + names.map(n =>
        '<div class="bp-row" title="' + n + '"><span>' + labels[n] + '</span>' + bar(a[n], RED_ROWS.has(n)) + '<span class="bp-num">' + (a[n] * 100).toFixed(1) + '%</span></div>').join('') + '</div>';
    }
    const kinds = Object.keys((b.memory && b.memory.odors) || {}).filter(k => ITEM_KINDS[k]);
    html += '<div class="bp-sec"><h3>Smell memory (mushroom body)</h3>' + (kinds.length ? kinds.map(k => {
      const l = learned(person, k), word = dislikes(person, k) ? 'dislikes' : l > 0.35 ? 'likes' : l < -0.15 ? 'wary' : l > 0.15 ? 'fairly likes' : 'neutral';
      return '<div class="bp-row"><span>' + ITEM_KINDS[k].name + '</span><span class="bp-word">' + word + '</span><span class="bp-num">' + (l > 0 ? '+' : '') + Math.round(l * 100) + '%</span></div>';
    }).join('') : '<p class="bp-note">Hasn\'t smelled any food yet.</p>') +
      '<p class="bp-note">Kenyon → MBON synapses left: approach ' + Math.round(b.memory.approach * 100) + '% · avoidance ' + Math.round(b.memory.avoid * 100) + '%</p></div>';
    html += '<div class="bp-sec"><h3>Last 12 seconds</h3><canvas class="bp-strip" width="560" height="' + STRIP.length * 22 + '"></canvas></div>';
    html += '<p><button type="button" class="bp-btn" data-3d>View 3D model</button></p>';
    html += '<p class="bp-note">' + meta.neuron_count.toLocaleString('en-US') + ' neurons · ' + meta.edge_count.toLocaleString('en-US') + ' connections · ' + b.tickMs.toFixed(1) + ' ms/tick</p>';
    panelEl.querySelector('.bp-body').innerHTML = html;
    drawStrip(panelEl.querySelector('.bp-strip'), b, labels);
  }

  function drawStrip(c, b, labels) {
    const g = c.getContext('2d'), H2 = 22, left = 150, cols = 120, w = (c.width - left) / cols;
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.font = '500 17px "IBM Plex Mono", ui-monospace, monospace'; g.textBaseline = 'middle';
    STRIP.forEach((name, r) => {
      g.fillStyle = '#000';
      g.fillText(name.replace('DAN_', '').replace('MN_', '').replace('DN_', ''), 0, r * H2 + H2 / 2);
      const hist = b.history, start = cols - hist.length;
      for (let i = 0; i < hist.length; i++) {
        const v = Math.min(1, (hist[i][name] || 0) * 6);
        if (v < 0.02) continue;
        g.globalAlpha = v;
        g.fillStyle = RED_ROWS.has(name) ? '#c8102e' : '#000';
        g.fillRect(left + (start + i) * w, r * H2 + 3, Math.ceil(w), H2 - 6);
      }
      g.globalAlpha = 1;
    });
  }

  function updatePanel(dt) {
    if (!panelPerson) return;
    if (!people.includes(panelPerson)) { hidePanel(); return; }
    panelAcc += dt;
    if (panelAcc < 0.1) return;
    panelAcc = 0;
    renderPanel();
  }

  // ---------- drawing the world's things ----------
  function drawItems() {
    const t = performance.now() / 1000;
    for (const it of items) {
      const k = ITEM_KINDS[it.kind], sc = S * (0.55 + 0.45 * it.amount);
      // a slow ripple shows the smell drifting out
      ctx.strokeStyle = k.danger ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.13)';
      ctx.lineWidth = 1; ctx.setLineDash([2, 5]);
      for (let n = 0; n < 3; n++) {
        const r = ((t * 22 + n * 55) % 165 + 15) * S;
        ctx.globalAlpha = 1 - r / (180 * S);
        ctx.beginPath(); ctx.arc(it.x, G - 8 * S, r, Math.PI, 2 * Math.PI); ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.setLineDash([]);
      ctx.save(); ctx.translate(it.x, G); ctx.scale(sc, sc);
      ctx.lineWidth = 2; ctx.strokeStyle = '#000'; ctx.fillStyle = '#fff'; ctx.lineJoin = 'round';
      ctx.beginPath();
      if (it.kind === 'banana') {
        ctx.moveTo(-12, -9); ctx.quadraticCurveTo(0, 4, 13, -10); ctx.quadraticCurveTo(0, -1, -12, -9);
      } else if (it.kind === 'apple') {
        ctx.arc(0, -9, 8, 0, Math.PI * 2);
      } else if (it.kind === 'bitter') {
        ctx.rect(-5, -18, 10, 16); ctx.moveTo(-3, -18); ctx.lineTo(-3, -22); ctx.lineTo(3, -22); ctx.lineTo(3, -18);
      } else if (it.kind === 'bait') {
        ctx.moveTo(-13, -6); ctx.lineTo(13, -6); ctx.lineTo(10, -1); ctx.lineTo(-10, -1); ctx.closePath();
      } else {
        ctx.moveTo(-12, -2); ctx.quadraticCurveTo(-13, -12, -4, -11); ctx.quadraticCurveTo(0, -17, 6, -11);
        ctx.quadraticCurveTo(14, -10, 12, -2); ctx.closePath();
      }
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#000';
      if (it.kind === 'apple') { ctx.fillRect(-0.8, -21, 1.6, 5); }
      if (it.kind === 'bitter') { ctx.fillRect(-3, -12, 6, 1.5); ctx.fillRect(-0.75, -14.5, 1.5, 6.5); }
      if (it.kind === 'mold') for (const [x, y] of [[-6, -6], [0, -9], [5, -5], [-2, -4]]) ctx.fillRect(x, y, 2, 2);
      if (it.kind === 'bait') { ctx.fillStyle = '#6f9f4f'; for (const [x, y] of [[-8, -9], [-3, -10], [2, -9], [6, -10], [-5, -8], [4, -8]]) ctx.fillRect(x, y, 2.5, 2.5); }
      ctx.restore();
      ctx.fillStyle = '#fff';
      ctx.font = `500 ${Math.round(9 * Math.max(0.8, S))}px "IBM Plex Mono", ui-monospace, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(k.name, it.x, G + 18 * S);
      ctx.textAlign = 'left';
    }
  }

  // what a brained person is up to, over their head
  function drawMindLabels() {
    ctx.font = `500 ${Math.round(10 * Math.max(0.8, S))}px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (const p of people) {
      if (!p.mind) continue;
      const [hx, hy] = headPos(p);
      const text = p.brain && p.brain.ready ? MODE_NAMES[p.mind.mode] : 'loading brain…';
      ctx.fillStyle = '#000';
      ctx.fillText('◆ ' + text, hx, hy - 22 * S);
    }
    ctx.textAlign = 'left';
  }

  // ---------- input ----------
  function pos(e) {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function nearest(x, y, radius) {
    let best = null, bd = radius * radius;
    for (let pi = people.length - 1; pi >= 0; pi--) {
      const P = people[pi].pts;
      for (let i = 0; i < P.length; i++) {
        const q = P[i];
        if (q.anchor || q.ghost) continue;
        const d = (q.x - x) ** 2 + (q.y - y) ** 2 - q.r * q.r;
        if (d < bd) { bd = d; best = { person: people[pi], idx: i }; }
      }
    }
    return best;
  }

  const pickRadius = e => (e.pointerType === 'touch' ? 30 : 16) * S + 6;
  let press = null; // a touch waiting to become a long-press menu

  cv.addEventListener('pointerdown', e => {
    if (!menuEl.hidden) { closeMenu(); return; }
    if (e.pointerType === 'mouse' && e.button !== 0) return; // right button opens the menu instead
    const p = pos(e);
    pointer.x = p.x; pointer.y = p.y;
    if (pendingWire) { finishWire(endAt(p.x, p.y)); return; }   // the click puts the wire's other end down
    pointer.down = true;
    const grabbed = propAt(p.x, p.y, true);
    const hit = grabbed ? null : nearest(p.x, p.y, pickRadius(e));
    if (e.pointerType !== 'mouse') {
      // touch has no right button: hold still to open the menu
      press = { x: p.x, y: p.y, cx: e.clientX, cy: e.clientY, person: hit && hit.person,
        timer: setTimeout(() => {
          const pr = press;
          press = null;
          release(true);
          openMenu(pr.cx, pr.cy, pr.x, pr.y, pr.person, null, pr.prop);
        }, 550), prop: grabbed };
    }
    if (grabbed) {
      const [lx, ly] = propLocal(grabbed, p.x, p.y);
      heldProp = { prop: grabbed, lx, ly, angle: grabbed.a };
      props.splice(props.indexOf(grabbed), 1); props.push(grabbed);
      cv.setPointerCapture(e.pointerId);
      cv.style.cursor = 'grabbing';
      return;
    }
    if (!hit) {
      const it = itemAt(p.x, p.y);
      if (it) { heldItem = it; cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing'; }
    }
    if (hit) {
      held = hit;
      if (hit.person.mind) feelTouch(hit.person, hit.idx);
      const i = people.indexOf(hit.person);
      people.splice(i, 1); people.push(hit.person);
      cv.setPointerCapture(e.pointerId);
      cv.style.cursor = 'grabbing';
    }
  });
  cv.addEventListener('pointermove', e => {
    const p = pos(e);
    pointer.x = p.x; pointer.y = p.y;
    if (press && Math.hypot(p.x - press.x, p.y - press.y) > 10) { clearTimeout(press.timer); press = null; }
    if (heldItem) heldItem.x = Math.max(20 * S, Math.min(W - 20 * S, p.x));
    if (!held && !heldProp && e.pointerType === 'mouse') {
      cv.style.cursor = propAt(p.x, p.y, true) || nearest(p.x, p.y, pickRadius(e)) ? 'grab' : 'default';
    }
  });
  // `drop` lets go without a throw (used when a long-press turns into the menu)
  function release(drop) {
    if (press) { clearTimeout(press.timer); press = null; }
    if (held && drop !== true) {
      const q = held.person.pts[held.idx];
      const maxV = VMAX * S; // the fastest anything can go: hard enough to smash a body to bits
      const vx = q.x - q.px, vy = q.y - q.py, v = Math.hypot(vx, vy);
      if (v > maxV) { q.px = q.x - vx / v * maxV; q.py = q.y - vy / v * maxV; }
    }
    if (heldProp && drop === true) { heldProp.prop.vx = heldProp.prop.vy = heldProp.prop.w = 0; }
    held = null; heldItem = null; heldProp = null; pointer.down = false;
    cv.style.cursor = 'default';
  }

  function itemAt(x, y) {
    for (const it of items) if (Math.abs(it.x - x) < 18 * S && y > G - 34 * S && y < G + 8 * S) return it;
    return null;
  }
  cv.addEventListener('pointerup', release);
  cv.addEventListener('pointercancel', release);

  cv.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (press || !menuEl.hidden) return; // a long-press is already handling it
    const p = pos(e);
    if (pendingWire) { pendingWire = null; return; }               // right-click drops a wire being laid
    const pr = propAt(p.x, p.y);
    const hit = pr ? null : nearest(p.x, p.y, 16 * S + 6);
    const wire = pr || hit ? null : wireAt(p.x, p.y);
    openMenu(e.clientX, e.clientY, p.x, p.y, hit && hit.person, hit || pr || wire ? null : itemAt(p.x, p.y), pr, wire);
  });

  function spawnAt(x, y) {
    // the new person's body is centred on the cursor; close to the floor they simply stand
    let feetY = y + 75 * S;
    if (feetY > G - 40 * S) feetY = G;
    return spawn(Math.max(20 * S, Math.min(W - 20 * S, x)), feetY);
  }

  // ---------- right-click menu ----------
  function openMenu(clientX, clientY, x, y, person, item, prop, wire) {
    menuEl.textContent = '';
    const heading = text => {
      const h = document.createElement('div');
      h.className = 'head';
      h.textContent = text;
      menuEl.append(h);
    };
    const add = (label, action, state) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.append(label);
      if (state) { const st = document.createElement('span'); st.className = 'state'; st.textContent = state; b.append(st); }
      b.addEventListener('click', () => { closeMenu(); action(); });
      menuEl.append(b);
    };
    const line = () => menuEl.append(document.createElement('hr'));

    if (person) {
      const torn = person.joints.filter(j => !j.active).length;
      heading(person.dead ? 'Person · dead'
        : 'Person · blood ' + Math.round(person.blood) + '%' + (torn ? ' · torn in ' + torn + (torn === 1 ? ' place' : ' places') : '') + (person.immortal ? ' · immortal' : ''));
      add('Heal', () => heal(person));
      add('Keep healing', () => { person.regen = !person.regen; }, person.regen ? 'on' : 'off');
      add('Immortal (no healing)', () => { person.immortal = !person.immortal; }, person.immortal ? 'on' : 'off');
      add('Delete this person', () => removePerson(person));
      add('Connect a wire from here', () => { const hit = nearest(x, y, 16 * S + 6); if (hit) pendingWire = { person, i: hit.idx }; });
      line();
      if (person.brain || person.mind) {
        add('View brain', () => showPanel(person));
        add('Remove fly brain', () => detachBrain(person));
      } else if (people.filter(p => p.brain || p.mind).length < MAX_BRAINS) {
        add('Attach fly brain (139,255 neurons)', () => attachBrain(person));
      } else heading('Brain limit reached (' + MAX_BRAINS + ')');
      line();
    }
    if (prop) {
      const name = PROP_KINDS[prop.kind].name;
      heading(name + (prop.skew.length ? ' · stuck through someone' : ''));
      if (prop.skew.length) add('Pull out', () => { prop.skew.length = 0; });
      if (prop.fuse !== undefined) add('Detonate now', () => { prop.fuse = 0; });
      if (prop.press) add(prop.press.on ? 'Switch off' : 'Switch on', () => { prop.press.on = !prop.press.on; });
      if (PROP_KINDS[prop.kind].source) add(prop.on ? 'Stop the generator' : 'Start the generator', () => { prop.on = !prop.on; });
      add('Connect a wire from here', () => { const [lx, ly] = propLocal(prop, x, y); pendingWire = { prop, lx, ly }; });
      if (prop.kind === 'fridge') {
        const door = prop.parts[prop.door];
        add(door.off ? 'Close the door' : 'Open the door', () => { door.off = !door.off; });
      }
      add('Delete ' + name.toLowerCase(), () => { if (isHeldProp(prop)) heldProp = null; props.splice(props.indexOf(prop), 1); });
      line();
    }
    if (wire) {
      heading('Wire' + (wire.live ? ' · live' : ''));
      add('Cut the wire', () => wires.splice(wires.indexOf(wire), 1));
      line();
    }
    if (item) {
      heading(ITEM_KINDS[item.kind].name);
      add('Delete ' + ITEM_KINDS[item.kind].name.toLowerCase(), () => items.splice(items.indexOf(item), 1));
      line();
    }
    if (people.length < MAX_PEOPLE) add('Add a person here', () => spawnAt(x, y));
    else heading('People limit reached (' + MAX_PEOPLE + ')');
    if (people.length) {
      const allRegen = people.every(p => p.regen);
      add('Heal everyone', () => people.forEach(heal));
      add('Keep healing everyone', () => people.forEach(p => { p.regen = !allRegen; }), allRegen ? 'on' : 'off');
      const allImmortal = people.every(p => p.immortal);
      add('Everyone immortal', () => people.forEach(p => { p.immortal = !allImmortal; }), allImmortal ? 'on' : 'off');
    }
    add('Place a banana', () => addItem('banana', x));
    add('Place an apple', () => addItem('apple', x));
    add('Place a bitter pill', () => addItem('bitter', x));
    add('Place mould (a danger smell)', () => addItem('mold', x));
    add('Place poison bait', () => addItem('bait', x));
    line();
    add('View 3D fly brain', () => open3D(person));
    add('Slow motion', () => { slow = !slow; }, slow ? 'on' : 'off');
    if (props.length) add('Delete all items', () => { props.length = 0; heldProp = null; });
    if (people.length || stains.length || items.length || props.length) {
      line();
      add('Clear everything', () => {
        people.forEach(p => { if (p.brain) p.brain.kill(); });
        hidePanel();
        people.length = 0; held = null; dust.length = 0; drops.length = 0; stains.length = 0; items.length = 0; updateCount();
        props.length = 0; heldProp = null; wires.length = 0; pendingWire = null;
      });
    }

    menuEl.hidden = false;
    const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
    menuEl.style.left = Math.max(8, Math.min(clientX, innerWidth - mw - 8)) + 'px';
    menuEl.style.top = Math.max(8, Math.min(clientY, innerHeight - mh - 8)) + 'px';
    menuEl.querySelector('button').focus({ preventScroll: true });
  }

  function closeMenu() { menuEl.hidden = true; }

  menuEl.addEventListener('contextmenu', e => e.preventDefault());
  menuEl.addEventListener('keydown', e => {
    const items = [...menuEl.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { closeMenu(); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { items[(i + 1) % items.length].focus(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { items[(i - 1 + items.length) % items.length].focus(); e.preventDefault(); }
  });
  document.addEventListener('pointerdown', e => {
    if (!menuEl.hidden && !menuEl.contains(e.target) && e.target !== cv) closeMenu();
  });
  window.addEventListener('blur', closeMenu);

  // ---------- loop ----------
  function resize() {
    if (!cv.clientWidth || !cv.clientHeight) { if (!W) { W = 960; H = 640; G = 560; } return; }
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    G = H - Math.max(54, Math.round(H * 0.13));
    // move each body as a whole back inside the new floor and walls, never squash it
    for (const person of people) {
      let up = 0, left = 0;
      for (const q of person.pts) { up = Math.max(up, q.y - (G - q.r)); left = Math.max(left, q.x - (W - q.r)); }
      if (up > 0 || left > 0) for (const q of person.pts) { q.y -= up; q.py -= up; q.x -= left; q.px -= left; }
    }
    for (const pr of props) if (pr.fixed) { pr.y = G; pr.x = Math.min(pr.x, W - 60 * S); propWorld(pr); }
  }

  let last = performance.now(), acc = 0;
  const STEP = 1 / 60;
  function frame(now) {
    acc += Math.min(0.1, (now - last) / 1000);
    last = now;
    let n = 0;
    while (acc >= STEP && n < 3) {
      const scale = slow ? 0.25 : 1;
      const h = STEP * scale / SUB;
      for (let i = 0; i < SUB; i++) substep(h);
      updateStates(STEP * scale);
      acc -= STEP; n++;
    }
    if (n === 3) acc = 0;
    draw();
    requestAnimationFrame(frame);
  }

  function start() {
    resize();
    S = Math.max(0.62, Math.min(1.25, H / 640));
    buildPropsPanel();
    if (matchMedia('(pointer: coarse)').matches) {
      document.getElementById('hint').textContent = 'Press and hold: add people, food, a fly brain · drag to lift · Items: drag things onto the field';
    }
    window.addEventListener('resize', () => { closeMenu(); resize(); });
    requestAnimationFrame(t => { last = t; frame(t); });
  }

  window.claude?.hot?.ready ? window.claude.hot.ready(start) : start();
})();
