/* 3DViewer — measuring with snaps (vertex, midpoint, circle centre, edge, face) and the distance split into ΔX / ΔY / ΔZ. */
/* global THREE */

const MS = { a: null, b: null, grp: new THREE.Group(), labels: [], mark: null, snap: null };
helpers.add(MS.grp);
const kpCache = new WeakMap();
// key points of a body: edge ends, edge middles, centres of closed edges (holes, round faces); plus the edge segments
function keyPoints(mesh) {
  let k = kpCache.get(mesh);
  if (k) return k;
  const pts = [], kinds = [];
  let seg = null;
  const add = (x, y, z, kind) => { pts.push(x, y, z); kinds.push(kind); };
  if (mesh.edges && mesh.edges.length) {
    seg = mesh.edges;
    const E = mesh.edges, G = mesh.edgeGroups && mesh.edgeGroups.length ? mesh.edgeGroups : [[0, E.length / 3]];
    const seen = new Set();
    const vkey = (x, y, z) => x.toFixed(4) + ',' + y.toFixed(4) + ',' + z.toFixed(4);
    G.forEach(([st, cnt]) => {
      if (cnt < 2) return;
      const p0 = st * 3, p1 = (st + cnt - 1) * 3;
      const closed = Math.hypot(E[p0] - E[p1], E[p0 + 1] - E[p1 + 1], E[p0 + 2] - E[p1 + 2]) < 1e-6;
      [p0, p1].forEach((q) => { const kk = vkey(E[q], E[q + 1], E[q + 2]); if (!seen.has(kk)) { seen.add(kk); add(E[q], E[q + 1], E[q + 2], 'vertex'); } });
      // length along the edge, its middle, and the centre of a closed edge
      let L = 0; const lens = [];
      for (let i = st; i < st + cnt; i += 2) { const a = i * 3, b = a + 3; const l = Math.hypot(E[b] - E[a], E[b + 1] - E[a + 1], E[b + 2] - E[a + 2]); lens.push(l); L += l; }
      if (closed) {
        let cx = 0, cy = 0, cz = 0, n = 0;
        for (let i = st; i < st + cnt; i += 2) { const a = i * 3; cx += E[a]; cy += E[a + 1]; cz += E[a + 2]; n++; }
        if (n > 2) add(cx / n, cy / n, cz / n, 'centre');
      } else if (L > 0) {
        let acc = 0;
        for (let j = 0; j < lens.length; j++) {
          if (acc + lens[j] >= L / 2) { const tt = (L / 2 - acc) / (lens[j] || 1), a = (st + j * 2) * 3, b = a + 3; add(E[a] + (E[b] - E[a]) * tt, E[a + 1] + (E[b + 1] - E[a + 1]) * tt, E[a + 2] + (E[b + 2] - E[a + 2]) * tt, 'mid'); break; }
          acc += lens[j];
        }
      }
    });
  } else {
    const eg = edgesOf(mesh);
    if (eg && eg.attributes.position.count < 120000) {
      seg = eg.attributes.position.array;
      const seen = new Set();
      for (let i = 0; i < seg.length; i += 3) { const kk = seg[i].toFixed(4) + ',' + seg[i + 1].toFixed(4) + ',' + seg[i + 2].toFixed(4); if (!seen.has(kk)) { seen.add(kk); add(seg[i], seg[i + 1], seg[i + 2], 'vertex'); } }
    }
  }
  k = { pts: new Float32Array(pts), kinds, seg };
  kpCache.set(mesh, k);
  return k;
}
// planar face? -> its normal
function faceNormal(b, fi) {
  const g = b.mesh.groups && b.mesh.groups[fi], N = b.mesh.normal;
  if (!g || !N || !N.length) return null;
  const ix = b.mesh.index, n0 = new THREE.Vector3().fromArray(N, ix[g[0]] * 3);
  for (let i = g[0]; i < g[0] + g[1]; i += Math.max(1, Math.floor(g[1] / 40))) {
    const n = new THREE.Vector3().fromArray(N, ix[i] * 3);
    if (n.dot(n0) < 0.9995) return null;
  }
  return n0.normalize();
}
function measureSnap(cx, cy) {
  const r = renderer.domElement.getBoundingClientRect();
  const mx = cx - r.left, my = cy - r.top;
  const hit = pickAt(cx, cy);
  const v = new THREE.Vector3();
  const scr = (x, y, z) => { v.set(x, y, z).project(cam); return [(v.x + 1) / 2 * r.width, (1 - v.y) / 2 * r.height, v.z]; };
  // bodies to look at: the one under the cursor first, then every visible one (for vertices on the outline)
  const bodies = hit ? [bodyById(hit.b)] : [];
  state.bodies.forEach((b) => { if (b.visible && groupVisible(b.group) && (!hit || b.id !== hit.b) && b.kind !== 'points') bodies.push(b); });
  let best = null, bd = 12;
  const pri = { centre: 0, vertex: 0, mid: 1 };
  for (const b of bodies.slice(0, 60)) {
    const kp = keyPoints(b.mesh);
    for (let i = 0; i < kp.kinds.length; i++) {
      const s = scr(kp.pts[i * 3], kp.pts[i * 3 + 1], kp.pts[i * 3 + 2]);
      if (s[2] > 1) continue;
      const d = Math.hypot(s[0] - mx, s[1] - my) + pri[kp.kinds[i]] * 1.5;
      if (d < bd) { bd = d; best = { p: new THREE.Vector3(kp.pts[i * 3], kp.pts[i * 3 + 1], kp.pts[i * 3 + 2]), kind: kp.kinds[i], b: b.id }; }
    }
  }
  if (best) return best;
  // on an edge
  if (hit) {
    const b = bodyById(hit.b), kp = keyPoints(b.mesh), E = kp.seg;
    if (E) {
      let eb = 7;
      for (let i = 0; i < E.length; i += 6) {
        const s0 = scr(E[i], E[i + 1], E[i + 2]), s1 = scr(E[i + 3], E[i + 4], E[i + 5]);
        const dx = s1[0] - s0[0], dy = s1[1] - s0[1], L = dx * dx + dy * dy || 1;
        const tt = clamp(((mx - s0[0]) * dx + (my - s0[1]) * dy) / L, 0, 1);
        const d = Math.hypot(s0[0] + dx * tt - mx, s0[1] + dy * tt - my);
        if (d < eb) { eb = d; best = { p: new THREE.Vector3(E[i] + (E[i + 3] - E[i]) * tt, E[i + 1] + (E[i + 4] - E[i + 1]) * tt, E[i + 2] + (E[i + 5] - E[i + 2]) * tt), kind: 'edge', b: b.id }; }
      }
      if (best) return best;
    }
    return { p: hit.point, kind: 'face', b: hit.b, f: hit.f, n: hit.f != null ? faceNormal(b, hit.f) : null };
  }
  return null;
}
function snapMark(s) {
  if (!MS.mark) { MS.mark = document.createElement('div'); stage.appendChild(MS.mark); }
  if (!s) { MS.mark.hidden = true; return; }
  const v = s.p.clone().project(cam);
  MS.mark.hidden = false;
  MS.mark.className = 'snapmark k-' + s.kind;
  MS.mark.dataset.tip = t('snap_' + s.kind);
  MS.mark.style.left = ((v.x + 1) / 2 * stage.clientWidth) + 'px';
  MS.mark.style.top = ((1 - v.y) / 2 * stage.clientHeight) + 'px';
}
function measureMove(e) {
  const s = measureSnap(e.clientX, e.clientY);
  MS.snap = s;
  snapMark(s);
  if (MS.a && !MS.b && s) drawMeasure(MS.a, s, true);
  return s;
}
function clearMeasure() {
  while (MS.grp.children.length) { const c = MS.grp.children.pop(); c.geometry.dispose(); }
  MS.labels.forEach((l) => l.el.remove()); MS.labels = [];
  MS.a = MS.b = null;
  snapMark(null);
  if (tool === 'measure') renderProps();
  req();
}
function measureClick(e) {
  const s = measureSnap(e.clientX, e.clientY);
  if (!s) return;
  if (!MS.a || MS.b) { clearMeasure(); MS.a = s; drawMeasure(s, null); return; }
  MS.b = s;
  drawMeasure(MS.a, MS.b);
  renderProps();
}
function mLine(a, b, color, dashed) {
  const g = new THREE.BufferGeometry().setFromPoints([a, b]);
  const m = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: dashed ? 0.95 : 1 });
  const l = new THREE.Line(g, m); l.renderOrder = dashed ? 12 : 14;
  MS.grp.add(l);
}
function sketchScaleWorld() {
  const h = cam === ocam ? orthoHeight / ocam.zoom : 2 * cam.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(pcam.fov / 2));
  return h / Math.max(stage.clientHeight, 1) * 10;
}
function mLabel(text, at, cls) {
  const el = document.createElement('div'); el.className = 'mlabel ' + (cls || ''); el.textContent = text; stage.appendChild(el);
  MS.labels.push({ el, at: at.clone() });
}
function mDot(p) {
  const g = new THREE.BufferGeometry().setFromPoints([p]);
  const m = new THREE.Points(g, new THREE.PointsMaterial({ color: new THREE.Color(cssVar('--hl')), size: 9, sizeAttenuation: false, depthTest: false }));
  m.renderOrder = 13; MS.grp.add(m);
}
function measureResult(A, B) {
  const d = B.p.clone().sub(A.p);
  const out = { L: d.length(), dx: d.x, dy: d.y, dz: d.z, xy: Math.hypot(d.x, d.y), perp: null };
  const nA = A.kind === 'face' ? A.n : null, nB = B.kind === 'face' ? B.n : null;
  if (nB) out.perp = { v: Math.abs(d.dot(nB)), n: nB.clone(), from: A.p, to: B.p, parallel: !!(nA && Math.abs(nA.dot(nB)) > 0.9995) };
  else if (nA) out.perp = { v: Math.abs(d.dot(nA)), n: nA.clone(), from: B.p, to: A.p, parallel: false };
  return out;
}
function drawMeasure(A, B, live) {
  while (MS.grp.children.length) { const c = MS.grp.children.pop(); c.geometry.dispose(); }
  MS.labels.forEach((l) => l.el.remove()); MS.labels = [];
  mDot(A.p);
  if (!B) { req(); return; }
  mDot(B.p);
  const r = measureResult(A, B);
  const acc = new THREE.Color(cssVar('--hl'));
  mLine(A.p, B.p, acc, false);
  // the path along the axes: X (red), then Y (green), then Z (blue)
  const p1 = new THREE.Vector3(B.p.x, A.p.y, A.p.z), p2 = new THREE.Vector3(B.p.x, B.p.y, A.p.z);
  const eps = 1e-6;
  if (Math.abs(r.dx) > eps) { mLine(A.p, p1, 0xe0524a, true); mLabel('ΔX ' + fmt(Math.abs(r.dx), 3), A.p.clone().add(p1).multiplyScalar(0.5), 'mx'); }
  if (Math.abs(r.dy) > eps) { mLine(p1, p2, 0x3fd07a, true); mLabel('ΔY ' + fmt(Math.abs(r.dy), 3), p1.clone().add(p2).multiplyScalar(0.5), 'my'); }
  if (Math.abs(r.dz) > eps) { mLine(p2, B.p, 0x4a8ee0, true); mLabel('ΔZ ' + fmt(Math.abs(r.dz), 3), p2.clone().add(B.p).multiplyScalar(0.5), 'mz'); }
  if (r.perp && r.perp.v > eps && Math.abs(r.perp.v - r.L) > 1e-4) {
    const n = r.perp.n, from = r.perp.from;
    const foot = from.clone().addScaledVector(n, r.perp.to.clone().sub(from).dot(n));
    mLine(from, foot, 0xe0a020, true);
    mLabel('⊥ ' + fmt(r.perp.v, 3), from.clone().add(foot).multiplyScalar(0.5), 'mp');
  }
  mLabel(fmt(r.L, 3) + ' mm', A.p.clone().add(B.p).multiplyScalar(0.5), 'mt');
  if (!live) $('sSel').innerHTML = t('distance') + ' <b>' + fmt(r.L, 3) + ' mm</b>  ΔX <b>' + fmt(r.dx, 3) + '</b> ΔY <b>' + fmt(r.dy, 3) + '</b> ΔZ <b>' + fmt(r.dz, 3) + '</b>';
  req();
}
function placeMeasureLabel() {
  MS.labels.forEach((l) => {
    const v = l.at.clone().project(cam);
    l.el.style.left = ((v.x + 1) / 2 * stage.clientWidth) + 'px';
    l.el.style.top = ((1 - v.y) / 2 * stage.clientHeight) + 'px';
    l.el.hidden = v.z > 1;
  });
  if (MS.snap && MS.mark && !MS.mark.hidden) snapMark(MS.snap);
}
function measureCard() {
  const A = MS.a, B = MS.b;
  const r = measureResult(A, B);
  const pt = (p) => fmt(p.x, 3) + '; ' + fmt(p.y, 3) + '; ' + fmt(p.z, 3);
  let h = '<span class="eyebrow">' + esc(t('measureT')) + '</span><span class="ptitle">' + fmt(r.L, 3) + ' mm</span><dl class="kv">' +
    '<dt><i class="axd x"></i>ΔX</dt><dd>' + fmt(Math.abs(r.dx), 3) + ' mm</dd><dt><i class="axd y"></i>ΔY</dt><dd>' + fmt(Math.abs(r.dy), 3) + ' mm</dd><dt><i class="axd z"></i>ΔZ</dt><dd>' + fmt(Math.abs(r.dz), 3) + ' mm</dd>' +
    '<dt>' + esc(t('inXY')) + '</dt><dd>' + fmt(r.xy, 3) + ' mm</dd>';
  if (r.perp) h += '<dt><i class="axd p"></i>' + esc(r.perp.parallel ? t('betweenFaces') : t('toPlane')) + '</dt><dd>' + fmt(r.perp.v, 3) + ' mm</dd>';
  h += '<dt>A · ' + esc(t('snap_' + A.kind)) + '</dt><dd>' + pt(A.p) + '</dd><dt>B · ' + esc(t('snap_' + B.kind)) + '</dt><dd>' + pt(B.p) + '</dd></dl><span class="note">' + esc(t('measureNote')) + '</span>';
  return h;
}
