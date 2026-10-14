/* 3DViewer — 2D sketch on a plane or a flat face, then extrude / revolve / cut (like a SolidWorks sketch + boss/cut).
   Same scope as app.js. */
/* global THREE */

const SK = {
  on: false, pl: null, ents: [], tool: 'line', cur: null, arcNext: false, grid: 1, sel: null, hover: null,
  grp: new THREE.Group(), prev: null, gridObj: null, target: [], label: null, snapEl: null, saved: null, dimBox: null,
  op: { kind: 'extrude', mode: 'new', dist: 5, dir: 'normal', axis: 'y', angle: 360, polyN: 6 },
};
let skSeq = 1;
helpers.add(SK.grp);

// ---------- plane maths ----------
function mkPlane(o, x, n) {
  const N = new THREE.Vector3().fromArray(n).normalize();
  const X = new THREE.Vector3().fromArray(x).normalize();
  const Vv = new THREE.Vector3().crossVectors(N, X).normalize();
  return { o: new THREE.Vector3().fromArray(o), x: X, v: Vv, n: N };
}
const PLANES = {
  xy: () => mkPlane([0, 0, 0], [1, 0, 0], [0, 0, 1]),
  xz: () => mkPlane([0, 0, 0], [1, 0, 0], [0, -1, 0]),
  yz: () => mkPlane([0, 0, 0], [0, 1, 0], [1, 0, 0]),
};
const toW = (p, x, y) => p.o.clone().addScaledVector(p.x, x).addScaledVector(p.v, y);
function toL(p, w) { const d = w.clone().sub(p.o); return [d.dot(p.x), d.dot(p.v)]; }
function planeMatrix(p) { return new THREE.Matrix4().makeBasis(p.x, p.v, p.n).setPosition(p.o); }

// ---------- entity outlines (2D) ----------
function arc3(a, m, b, seg) { // circle through three points, sampled from a to b through m
  const ax = a[0], ay = a[1], bx = m[0], by = m[1], cx = b[0], cy = b[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return [a, b];
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const ang = (x, y) => Math.atan2(y - uy, x - ux);
  const a0 = ang(ax, ay), a1 = ang(bx, by), a2 = ang(cx, cy);
  const norm = (t) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ccw = norm(a1 - a0) < norm(a2 - a0);
  let sweep = ccw ? norm(a2 - a0) : -norm(a0 - a2);
  const n = seg || Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
  const out = [];
  for (let i = 0; i <= n; i++) { const t = a0 + sweep * i / n; out.push([ux + r * Math.cos(t), uy + r * Math.sin(t)]); }
  return out;
}
function polyPts(e) {
  const out = [];
  for (let i = 0; i < e.n; i++) { const t = (e.a || 0) * Math.PI / 180 + i * 2 * Math.PI / e.n; out.push([e.x + e.r * Math.cos(t), e.y + e.r * Math.sin(t)]); }
  return out;
}
function rectPts(e) { return [[e.x, e.y], [e.x + e.w, e.y], [e.x + e.w, e.y + e.h], [e.x, e.y + e.h]]; }
// outline as a polyline; closed outlines repeat the first point at the end
function outline(e) {
  if (e.t === 'rect') { const p = rectPts(e); return p.concat([p[0]]); }
  if (e.t === 'poly') { const p = polyPts(e); return p.concat([p[0]]); }
  if (e.t === 'circle') { const out = []; for (let i = 0; i <= 64; i++) { const t = i / 64 * 2 * Math.PI; out.push([e.x + e.r * Math.cos(t), e.y + e.r * Math.sin(t)]); } return out; }
  const P = e.pts, out = [P[0]];
  for (let i = 1; i < P.length; i++) {
    if (e.arcs && e.arcs[i]) out.push(...arc3(P[i - 1], e.arcs[i], P[i]).slice(1)); else out.push(P[i]);
  }
  if (e.closed) { if (e.arcs && e.arcs.close) out.push(...arc3(P[P.length - 1], e.arcs.close, P[0]).slice(1)); else out.push(P[0]); }
  return out;
}
const isClosed = (e) => e.t !== 'path' || e.closed;
function keyPts(e) {
  if (e.t === 'circle') return [[e.x, e.y]];
  if (e.t === 'rect') return rectPts(e).concat([[e.x + e.w / 2, e.y + e.h / 2]]);
  if (e.t === 'poly') return polyPts(e).concat([[e.x, e.y]]);
  return e.pts.slice();
}
function area2(pts) { let a = 0; for (let i = 0; i < pts.length - 1; i++) a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1]; return a / 2; }
function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
// closed entities -> loops for the kernel, holes by nesting depth
function profileLoops() {
  const closed = SK.ents.filter(isClosed).map((e) => ({ e, o: outline(e) }));
  closed.forEach((c) => { c.area = Math.abs(area2(c.o)); });
  closed.forEach((c) => {
    const probe = c.e.t === 'circle' ? [c.e.x + c.e.r, c.e.y] : c.o[0];
    c.depth = closed.filter((d) => d !== c && d.area > c.area && inside(probe, d.o)).length;
  });
  return closed.map((c) => {
    const e = c.e, hole = c.depth % 2 === 1;
    if (e.t === 'circle') return { t: 'circle', x: e.x, y: e.y, r: e.r, hole, o: c.o };
    if (e.t === 'rect') return { t: 'path', pts: rectPts(e), hole, o: c.o };
    if (e.t === 'poly') return { t: 'path', pts: polyPts(e), hole, o: c.o };
    return { t: 'path', pts: e.pts, arcs: e.arcs, hole, o: c.o };
  });
}

// ---------- drawing the sketch ----------
const skMat = { line: null, sel: null, rub: null, pt: null };
function skMaterials() {
  const acc = cssVar('--hl') || '#3fd07a';
  skMat.line = new THREE.LineBasicMaterial({ color: S.theme === 'light' ? 0x1d2321 : 0xe8f0ec, depthTest: false });
  skMat.sel = new THREE.LineBasicMaterial({ color: new THREE.Color(acc), depthTest: false });
  skMat.rub = new THREE.LineDashedMaterial({ color: new THREE.Color(acc), depthTest: false, dashSize: 1, gapSize: 0.6 });
  skMat.open = new THREE.LineBasicMaterial({ color: 0xe0a020, depthTest: false });
}
function lineObj(pts2, mat) {
  const g = new THREE.BufferGeometry().setFromPoints(pts2.map((p) => toW(SK.pl, p[0], p[1])));
  const l = new THREE.Line(g, mat); l.renderOrder = 10; l.raycast = () => {};
  if (mat.isLineDashedMaterial) l.computeLineDistances();
  return l;
}
function skClear(g) { while (g.children.length) { const c = g.children.pop(); if (c.geometry) c.geometry.dispose(); } }
function skDraw() {
  if (!skMat.line) skMaterials();
  skClear(SK.grp);
  if (!SK.on) { req(); return; }
  SK.ents.forEach((e) => SK.grp.add(lineObj(outline(e), SK.sel === e.id ? skMat.sel : isClosed(e) ? skMat.line : skMat.open)));
  // points
  const pts = [];
  SK.ents.forEach((e) => keyPts(e).forEach((p) => pts.push(toW(SK.pl, p[0], p[1]))));
  if (pts.length) {
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const m = new THREE.Points(g, new THREE.PointsMaterial({ color: new THREE.Color(cssVar('--hl')), size: 6, sizeAttenuation: false, depthTest: false }));
    m.renderOrder = 11; m.raycast = () => {}; SK.grp.add(m);
  }
  // origin cross of the sketch plane
  const s = sketchScale() * 6;
  SK.grp.add(lineObj([[-s, 0], [s, 0]], new THREE.LineBasicMaterial({ color: 0xe0524a, depthTest: false, transparent: true, opacity: 0.7 })));
  SK.grp.add(lineObj([[0, -s], [0, s]], new THREE.LineBasicMaterial({ color: 0x3fd07a, depthTest: false, transparent: true, opacity: 0.7 })));
  skPreview();
  req();
}
function sketchScale() { // mm per ~10 px at the plane
  const h = cam === ocam ? orthoHeight / ocam.zoom : 2 * cam.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(pcam.fov / 2));
  return h / Math.max(stage.clientHeight, 1) * 10;
}
function skRubber(pts2) {
  SK.grp.children.filter((c) => c.userData.rub).forEach((c) => { SK.grp.remove(c); c.geometry.dispose(); });
  if (pts2 && pts2.length > 1) { const l = lineObj(pts2, skMat.rub); l.userData.rub = true; SK.grp.add(l); }
  req();
}
function skGrid() {
  if (SK.gridObj) { helpers.remove(SK.gridObj); SK.gridObj.geometry.dispose(); SK.gridObj = null; }
  if (!SK.on) return;
  const step = SK.grid > 0 ? SK.grid : 1;
  const span = Math.max(sketchScale() * 120, step * 20);
  const n = Math.min(400, Math.ceil(span / step / 2) * 2);
  const g = new THREE.GridHelper(n * step, n, 0x4c5a54, 0x323b37);
  g.material.transparent = true; g.material.opacity = 0.35; g.material.depthWrite = false;
  g.rotation.x = Math.PI / 2; // grid in local XY
  const holder = new THREE.Group(); holder.add(g);
  holder.matrixAutoUpdate = false; holder.matrix.copy(planeMatrix(SK.pl));
  holder.geometry = g.geometry;
  SK.gridObj = holder; helpers.add(holder);
}

// ---------- preview of the extrusion ----------
function skPreview() {
  if (SK.prev) { helpers.remove(SK.prev); SK.prev.geometry.dispose(); SK.prev = null; }
  if (!SK.on || SK.op.kind !== 'extrude') { req(); return; }
  const loops = profileLoops();
  const outers = loops.filter((l) => !l.hole);
  if (!outers.length) { req(); return; }
  const shapes = outers.map((l) => {
    const sh = new THREE.Shape(l.o.map((p) => new THREE.Vector2(p[0], p[1])));
    loops.filter((h) => h.hole && inside(h.o[0], l.o)).forEach((h) => sh.holes.push(new THREE.Path(h.o.map((p) => new THREE.Vector2(p[0], p[1])))));
    return sh;
  });
  const D = Math.abs(Number(SK.op.dist) || 0) || 0.01;
  const g = new THREE.ExtrudeGeometry(shapes, { depth: D, bevelEnabled: false, curveSegments: 24 });
  const off = SK.op.dir === 'reverse' ? -D : SK.op.dir === 'both' ? -D / 2 : 0;
  g.translate(0, 0, off);
  const col = SK.op.mode === 'cut' ? 0xe8665a : new THREE.Color(cssVar('--hl'));
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
  m.matrixAutoUpdate = false; m.matrix.copy(planeMatrix(SK.pl)); m.raycast = () => {};
  SK.prev = m; helpers.add(m); req();
}

// ---------- entering / leaving ----------
async function startSketch(which) {
  if (SK.on) return;
  let pl = null; SK.target = [];
  if (which === 'face') {
    const s = sel.find((x) => x.f != null);
    if (!s) { toast(t('skPickFace'), 'warn'); return; }
    const b = bodyById(s.b);
    if (b.kind !== 'brep' || !b.sid) { toast(t('skFaceBrep'), 'warn'); return; }
    const r = await withBusy(t('working'), () => kcall('facePlane', { sid: b.sid, face: s.f }));
    if (!r) return;
    if (!r.planar) { toast(t('skNotPlanar'), 'warn'); return; }
    pl = mkPlane(r.o, r.x, r.n); SK.target = [b.id];
  } else {
    pl = PLANES[which]();
    const off = Number(SK.offset) || 0;
    if (off) pl.o.addScaledVector(pl.n, off);
    SK.target = selBodies().map((b) => b.id);
  }
  SK.planeName = which === 'face' ? t('skOnFaceShort') : t('skPlane' + which.toUpperCase());
  SK.on = true; SK.pl = pl; SK.ents = []; SK.cur = null; SK.sel = null; SK.tool = 'line'; SK.arcNext = false;
  SK.saved = { persp: cam === pcam, pos: cam.position.clone(), up: cam.up.clone(), target: controls.target.clone(), zoom: ocam.zoom, oh: orthoHeight, buttons: Object.assign({}, controls.mouseButtons) };
  setTool('select'); setSel([]); gizmo.detach();
  // look straight at the plane
  if (cam === pcam) setProjection(false);
  const tgt = controls.target.clone();
  const onPlane = tgt.clone().sub(pl.n.clone().multiplyScalar(tgt.clone().sub(pl.o).dot(pl.n)));
  controls.target.copy(onPlane);
  ocam.position.copy(onPlane).addScaledVector(pl.n, Math.max(orthoHeight * 4, 50));
  ocam.up.copy(pl.v); ocam.lookAt(onPlane); controls.update();
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
  document.body.classList.add('sketching'); $('welcome').hidden = true;
  skMaterials(); skGrid(); skDraw(); renderCmdBar(); showTab('sketch'); renderSketchPane(); showHint();
}
function endSketch() {
  SK.on = false; SK.cur = null; SK.ents = [];
  skClear(SK.grp); skGrid(); skPreview(); skLabel(null); skSnapMark(null); closeDimBox();
  const sv = SK.saved;
  if (sv) {
    controls.mouseButtons = sv.buttons;
    ocam.zoom = sv.zoom; orthoHeight = sv.oh; setOrthoFrustum();
    if (sv.persp) { ocam.position.copy(sv.pos); ocam.up.copy(sv.up); controls.target.copy(sv.target); setProjection(true); pcam.position.copy(sv.pos); pcam.up.copy(sv.up); }
    else { ocam.position.copy(sv.pos); ocam.up.copy(sv.up); }
    controls.target.copy(sv.target); controls.update();
  }
  document.body.classList.remove('sketching'); updateStatus();
  renderCmdBar(); showTab(S.tab === 'sketch' ? 'create' : S.tab); showHint(); req();
}

// ---------- pointer in the sketch ----------
const skRay = new THREE.Raycaster();
function planeHit(cx, cy) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  skRay.setFromCamera(ndc, cam);
  const P = new THREE.Plane().setFromNormalAndCoplanarPoint(SK.pl.n, SK.pl.o);
  const w = skRay.ray.intersectPlane(P, new THREE.Vector3());
  return w ? toL(SK.pl, w) : null;
}
function screenOfL(p) {
  const w = toW(SK.pl, p[0], p[1]).project(cam), r = renderer.domElement.getBoundingClientRect();
  return [(w.x + 1) / 2 * r.width, (1 - w.y) / 2 * r.height];
}
// snapping: existing points > horizontal/vertical to the previous point > grid
function snap(p, cx, cy, prev) {
  const r = renderer.domElement.getBoundingClientRect();
  const mx = cx - r.left, my = cy - r.top;
  let best = null, bd = 11;
  const cand = [[0, 0, 'origin']];
  SK.ents.forEach((e) => keyPts(e).forEach((k) => cand.push([k[0], k[1], 'point'])));
  if (SK.cur) (SK.cur.pts || []).forEach((k, i) => cand.push([k[0], k[1], i === 0 ? 'start' : 'point']));
  cand.forEach((c) => { const s = screenOfL(c); const d = Math.hypot(s[0] - mx, s[1] - my); if (d < bd) { bd = d; best = c; } });
  if (best) return { p: [best[0], best[1]], kind: best[2] };
  let q = p.slice();
  const g = SK.grid;
  if (g > 0) q = [Math.round(q[0] / g) * g, Math.round(q[1] / g) * g];
  if (prev) {
    const sp = screenOfL(prev), sq = screenOfL(q);
    if (Math.abs(sq[1] - sp[1]) < 8) return { p: [q[0], prev[1]], kind: 'h' };
    if (Math.abs(sq[0] - sp[0]) < 8) return { p: [prev[0], q[1]], kind: 'v' };
  }
  return { p: q, kind: g > 0 ? 'grid' : 'free' };
}
function skSnapMark(s) {
  if (!SK.snapEl) { SK.snapEl = document.createElement('div'); SK.snapEl.className = 'snapmark'; stage.appendChild(SK.snapEl); }
  if (!s) { SK.snapEl.hidden = true; return; }
  const [x, y] = screenOfL(s.p);
  SK.snapEl.hidden = false; SK.snapEl.className = 'snapmark k-' + s.kind;
  SK.snapEl.style.left = x + 'px'; SK.snapEl.style.top = y + 'px';
}
function skLabel(text, p) {
  if (!SK.label) { SK.label = document.createElement('div'); SK.label.className = 'mlabel sk'; stage.appendChild(SK.label); }
  if (!text) { SK.label.hidden = true; return; }
  const [x, y] = screenOfL(p);
  SK.label.hidden = false; SK.label.textContent = text;
  SK.label.style.left = (x + 18) + 'px'; SK.label.style.top = (y + 26) + 'px';
}
let skLast = null;
function sketchMove(e) {
  const raw = planeHit(e.clientX, e.clientY);
  if (!raw) return;
  const c = SK.cur;
  const prev = c ? (c.t === 'path' ? c.pts[c.pts.length - 1] : c.a) : null;
  const s = snap(raw, e.clientX, e.clientY, prev && !(c && c.t === 'path' && c.wantMid) ? prev : null);
  skLast = s;
  skSnapMark(s);
  $('sCoord').innerHTML = 'X <b>' + fmt(s.p[0], 3) + '</b> Y <b>' + fmt(s.p[1], 3) + '</b>';
  if (!c) { skRubber(null); skLabel(null); return; }
  skRubberFor(c, s.p);
}
function skRubberFor(c, p) {
  if (c.t === 'path') {
    const last = c.pts[c.pts.length - 1];
    if (c.wantMid === 'close') { skRubber(arc3(last, p, c.pts[0])); skLabel(t('skArc'), p); return; }
    if (c.wantMid) { skRubber(arc3(c.pts[c.pts.length - 2], p, last)); skLabel(t('skArc'), p); return; }
    skRubber([last, p]);
    const L = Math.hypot(p[0] - last[0], p[1] - last[1]), A = Math.atan2(p[1] - last[1], p[0] - last[0]) * 180 / Math.PI;
    skLabel((SK.arcNext ? t('skArc') + ' ' : '') + fmt(L, 3) + ' mm  ∠' + fmt(A, 1) + '°', p);
  } else if (c.t === 'rect') {
    skRubber(outline({ t: 'rect', x: c.a[0], y: c.a[1], w: p[0] - c.a[0], h: p[1] - c.a[1] }));
    skLabel(fmt(Math.abs(p[0] - c.a[0]), 3) + ' × ' + fmt(Math.abs(p[1] - c.a[1]), 3) + ' mm', p);
  } else {
    const r = Math.hypot(p[0] - c.a[0], p[1] - c.a[1]);
    skRubber(outline(c.t === 'circle' ? { t: 'circle', x: c.a[0], y: c.a[1], r } : { t: 'poly', x: c.a[0], y: c.a[1], r, n: SK.op.polyN, a: Math.atan2(p[1] - c.a[1], p[0] - c.a[0]) * 180 / Math.PI }));
    skLabel((c.t === 'circle' ? 'R ' : 'R ') + fmt(r, 3) + ' mm' + (c.t === 'circle' ? '  Ø ' + fmt(2 * r, 3) : ''), p);
  }
}
function sketchClick(e) {
  const raw = planeHit(e.clientX, e.clientY);
  if (!raw) return;
  const c = SK.cur;
  const prev = c ? (c.t === 'path' ? c.pts[c.pts.length - 1] : c.a) : null;
  const s = snap(raw, e.clientX, e.clientY, prev && !(c && c.wantMid) ? prev : null);
  skPlace(s.p, s.kind);
}
function skPlace(p, kind) {
  const c = SK.cur;
  if (SK.tool === 'select') { skPickEnt(p); return; }
  if (SK.tool === 'line') {
    if (!c) { SK.cur = { t: 'path', pts: [p], arcs: {} }; skDrawCur(); return; }
    if (c.wantMid) { // second click of an arc: a point the arc passes through
      if (c.wantMid === 'close') { c.arcs.close = p; c.closed = true; delete c.wantMid; SK.arcNext = false; renderCmdBar(); skCommitCur(); return; }
      c.arcs[c.pts.length - 1] = p; c.wantMid = false; SK.arcNext = false; renderCmdBar(); skDrawCur(); return;
    }
    const first = c.pts[0], last = c.pts[c.pts.length - 1];
    const same = (u, w) => Math.hypot(u[0] - w[0], u[1] - w[1]) < 1e-9;
    if (same(p, last)) { skFinishPath(); return; } // a second click on the same point finishes the line
    if (c.pts.length >= 2 && same(p, first)) {
      if (SK.arcNext) { c.wantMid = 'close'; toast(t('skArcMid')); return; }
      if (c.pts.length >= 3) { c.closed = true; skCommitCur(); return; }
    }
    c.pts.push(p);
    if (SK.arcNext) { c.wantMid = true; toast(t('skArcMid')); }
    skDrawCur();
    return;
  }
  if (!c) { SK.cur = { t: SK.tool, a: p }; return; }
  if (SK.tool === 'rect') {
    const w = p[0] - c.a[0], h = p[1] - c.a[1];
    if (Math.abs(w) < 1e-6 || Math.abs(h) < 1e-6) return;
    SK.cur = { t: 'rect', x: Math.min(c.a[0], p[0]), y: Math.min(c.a[1], p[1]), w: Math.abs(w), h: Math.abs(h) };
  } else {
    const r = Math.hypot(p[0] - c.a[0], p[1] - c.a[1]);
    if (r < 1e-6) return;
    SK.cur = SK.tool === 'circle' ? { t: 'circle', x: c.a[0], y: c.a[1], r } : { t: 'poly', x: c.a[0], y: c.a[1], r, n: SK.op.polyN, a: Math.atan2(p[1] - c.a[1], p[0] - c.a[0]) * 180 / Math.PI };
  }
  skCommitCur();
}
function skDrawCur() { // the path being drawn, as solid segments
  skDraw();
  const c = SK.cur;
  if (c && c.t === 'path' && c.pts.length > 1) SK.grp.add(lineObj(outline(Object.assign({}, c, { closed: false })), skMat.sel));
  req();
}
function skCommitCur() {
  const c = SK.cur; SK.cur = null;
  if (!c) return;
  c.id = skSeq++;
  SK.ents.push(c);
  skRubber(null); skLabel(null); closeDimBox();
  skDraw(); renderSketchPane();
}
function skFinishPath() {
  const c = SK.cur;
  if (!c || c.t !== 'path') { SK.cur = null; skRubber(null); skLabel(null); return; }
  if (c.wantMid === true) c.pts.pop();
  delete c.wantMid; SK.arcNext = false;
  if (c.pts.length >= 2) { skCommitCur(); if (!c.closed) toast(t('skOpenPath'), 'warn'); }
  else { SK.cur = null; skRubber(null); skLabel(null); skDraw(); }
}
function skPickEnt(p) {
  const tol = sketchScale() * 0.8;
  let best = null, bd = tol;
  SK.ents.forEach((e) => {
    const o = outline(e);
    for (let i = 0; i < o.length - 1; i++) {
      const [ax, ay] = o[i], [bx, by] = o[i + 1];
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1;
      const tt = clamp(((p[0] - ax) * dx + (p[1] - ay) * dy) / L, 0, 1);
      const d = Math.hypot(ax + dx * tt - p[0], ay + dy * tt - p[1]);
      if (d < bd) { bd = d; best = e; }
    }
  });
  SK.sel = best ? best.id : null;
  skDraw(); renderSketchPane();
}

// typed dimensions while drawing: a number = length / radius; "w x h" for a rectangle
function openDimBox(first) {
  if (!SK.cur) return;
  closeDimBox();
  const box = document.createElement('input');
  box.className = 'dimbox txt'; box.value = first || '';
  box.placeholder = SK.cur.t === 'rect' ? t('skDimRect') : SK.cur.t === 'path' ? t('skDimLen') : 'R';
  const at = skLast ? screenOfL(skLast.p) : [stage.clientWidth / 2, stage.clientHeight / 2];
  box.style.left = (at[0] + 18) + 'px'; box.style.top = (at[1] - 34) + 'px';
  stage.appendChild(box); SK.dimBox = box; box.focus();
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { closeDimBox(); return; }
    if (e.key !== 'Enter') return;
    const nums = box.value.replace(/,/g, '.').split(/[\sx×*;]+/).map(Number).filter((v) => isFinite(v));
    applyDim(nums);
  });
}
function closeDimBox() { if (SK.dimBox) { SK.dimBox.remove(); SK.dimBox = null; } }
function applyDim(nums) {
  const c = SK.cur; if (!c || !nums.length) { closeDimBox(); return; }
  const to = skLast ? skLast.p : null;
  if (c.t === 'path') {
    const last = c.pts[c.pts.length - 1];
    let dx = 1, dy = 0;
    if (to) { const L = Math.hypot(to[0] - last[0], to[1] - last[1]); if (L > 1e-9) { dx = (to[0] - last[0]) / L; dy = (to[1] - last[1]) / L; } }
    if (nums.length > 1) { const a = nums[1] * Math.PI / 180; dx = Math.cos(a); dy = Math.sin(a); }
    closeDimBox();
    skPlace([last[0] + dx * nums[0], last[1] + dy * nums[0]], 'typed');
  } else if (c.t === 'rect') {
    const sx = to && to[0] < c.a[0] ? -1 : 1, sy = to && to[1] < c.a[1] ? -1 : 1;
    const w = nums[0], h = nums.length > 1 ? nums[1] : nums[0];
    closeDimBox();
    skPlace([c.a[0] + sx * w, c.a[1] + sy * h], 'typed');
  } else {
    const r = nums[0];
    let a = 0;
    if (to) a = Math.atan2(to[1] - c.a[1], to[0] - c.a[0]);
    closeDimBox();
    skPlace([c.a[0] + r * Math.cos(a), c.a[1] + r * Math.sin(a)], 'typed');
  }
}

function sketchKey(e) {
  if (SK.dimBox && document.activeElement === SK.dimBox) return true;
  const k = e.key.toLowerCase();
  if (/^[0-9.,-]$/.test(e.key) && SK.cur && !e.ctrlKey) { e.preventDefault(); openDimBox(e.key === ',' ? '.' : e.key); return true; }
  if (k === 'escape') { if (SK.cur) { if (SK.cur.t === 'path') skFinishPath(); else { SK.cur = null; skRubber(null); skLabel(null); } } else if (SK.sel) { SK.sel = null; skDraw(); renderSketchPane(); } else setSkTool('select'); return true; }
  if (k === 'enter') { skFinishPath(); return true; }
  if (k === 'delete' || k === 'backspace') { if (SK.sel) { SK.ents = SK.ents.filter((x) => x.id !== SK.sel); SK.sel = null; skDraw(); renderSketchPane(); } return true; }
  if (e.ctrlKey && k === 'z') { if (SK.cur && SK.cur.t === 'path' && SK.cur.pts.length > 1) { SK.cur.pts.pop(); skDrawCur(); } else if (!SK.cur && SK.ents.length) { SK.ents.pop(); skDraw(); renderSketchPane(); } return true; }
  const map = { l: 'line', r: 'rect', c: 'circle', p: 'poly', q: 'select' };
  if (map[k] && !e.ctrlKey) { setSkTool(map[k]); return true; }
  if (k === 'a' && !e.ctrlKey) { toggleArc(); return true; }
  if (k === 'f') { fitView(SK.pl.n.clone()); ocam.up.copy(SK.pl.v); controls.update(); skGrid(); return true; }
  return false;
}
function setSkTool(tl) {
  if (SK.cur && SK.cur.t === 'path') skFinishPath();
  SK.cur = null; SK.tool = tl; SK.arcNext = false; skRubber(null); skLabel(null);
  renderCmdBar(); showHint();
}
function toggleArc() { if (SK.tool !== 'line') setSkTool('line'); SK.arcNext = !SK.arcNext; renderCmdBar(); }

// ---------- making the solid ----------
async function sketchFinish(kind, mode) {
  if (SK.cur && SK.cur.t === 'path') skFinishPath();
  const loops = profileLoops();
  if (!loops.filter((l) => !l.hole).length) { toast(t('skNoProfile'), 'warn'); return; }
  SK.op.kind = kind || SK.op.kind; if (mode) SK.op.mode = mode;
  const pl = SK.pl, op = SK.op;
  const res = await withBusy(t('working'), () => kcall('sketchSolid', {
    plane: { o: pl.o.toArray(), x: pl.x.toArray(), n: pl.n.toArray() }, loops: loops.map((l) => { const c = Object.assign({}, l); delete c.o; return c; }),
    op: op.kind, dist: Math.abs(Number(op.dist) || 0), dir: op.dir, axis: op.axis, angle: op.angle, quality: S.quality,
  }));
  if (!res) return;
  track(res.sid);
  if (op.mode === 'new') {
    const mg = modelGroup();
    const n = state.bodies.filter((b) => b.name.startsWith(t('skBody'))).length + 1;
    const b = mkBody({ name: t('skBody') + ' ' + n, group: mg.gid, kind: 'brep', sid: res.sid, mesh: res.mesh, color: cur.color, metal: cur.metal, rough: cur.rough, alpha: cur.alpha });
    commit(Object.assign({}, mg.st, { bodies: mg.st.bodies.concat([b]) }));
    endSketch(); setSel([{ b: b.id, f: null }]);
    return;
  }
  // add / cut: the face's body, the bodies selected before the sketch, or every visible exact body the tool touches
  const tb = new THREE.Box3(new THREE.Vector3().fromArray(res.mesh.bbox[0]), new THREE.Vector3().fromArray(res.mesh.bbox[1]));
  let targets = SK.target.map(bodyById).filter((b) => b && b.visible);
  if (!targets.length) targets = state.bodies.filter((b) => b.visible && b.kind !== 'points' && base(b.mesh).boundingBox && base(b.mesh).boundingBox.intersectsBox(tb));
  if (op.mode === 'add') targets = targets.slice(0, 1);
  if (!targets.length) { toast(t('skNoTarget'), 'warn'); return; }
  const out = await withBusy(t('working'), async () => {
    const list = [];
    for (const b of targets) {
      const sid = await ensureBrep(b);
      try {
        const r = await kcall('boolean', { op: op.mode === 'add' ? 'fuse' : 'cut', a: sid, b: [res.sid], quality: S.quality });
        list.push(Object.assign({}, b, { kind: 'brep', sid: track(r.sid), mesh: r.mesh, faceColors: {} }));
      } catch (e) { if (op.mode === 'add' || targets.length === 1) throw e; }
    }
    return list;
  });
  if (!out || !out.length) return;
  commit(replaceBodies(new Set(out.map((b) => b.id)), out));
  endSketch(); setSel(out.map((b) => ({ b: b.id, f: null })));
}

// ---------- right panel while sketching ----------
function renderSketchPane() {
  const p = $('paneSketch'); if (!p) return;
  const op = SK.op;
  const num = (k, v, lab) => '<label>' + esc(lab) + '<input class="num" type="number" step="any" data-sk="' + k + '" value="' + v + '"></label>';
  let h = '<div class="modehint">' + t('skHelp') + '</div>';
  h += '<fieldset><legend>' + esc(t('skFeature')) + '</legend>' +
    '<div class="seg wide" id="skKind"><button data-k="extrude" aria-pressed="' + (op.kind === 'extrude') + '">' + esc(t('skExtrude')) + '</button><button data-k="revolve" aria-pressed="' + (op.kind === 'revolve') + '">' + esc(t('skRevolve')) + '</button></div>' +
    '<div class="seg wide" id="skMode"><button data-m="new" aria-pressed="' + (op.mode === 'new') + '">' + esc(t('skNew')) + '</button><button data-m="add" aria-pressed="' + (op.mode === 'add') + '">' + esc(t('skAdd')) + '</button><button data-m="cut" aria-pressed="' + (op.mode === 'cut') + '">' + esc(t('skCut')) + '</button></div>';
  if (op.kind === 'extrude') {
    h += '<div class="grid2">' + num('dist', op.dist, t('skDepth')) + '<label>' + esc(t('skDir')) + '<select class="sel" data-sk="dir"><option value="normal">' + esc(t('skDirN')) + '</option><option value="reverse">' + esc(t('skDirR')) + '</option><option value="both">' + esc(t('skDirB')) + '</option></select></label></div>';
  } else {
    h += '<div class="grid2"><label>' + esc(t('axis')) + '<select class="sel" data-sk="axis"><option value="y">' + esc(t('skAxisV')) + '</option><option value="x">' + esc(t('skAxisH')) + '</option></select></label>' + num('angle', op.angle, t('angleDeg')) + '</div>' +
      '<span class="note">' + esc(t('skRevNote')) + '</span>';
  }
  h += '<button class="btn primary" id="skGo" data-ic="' + (op.mode === 'cut' ? 'subtract' : 'box') + '"><span>' + esc(t(op.mode === 'cut' ? 'skDoCut' : op.kind === 'extrude' ? 'skDoExtrude' : 'skDoRevolve')) + '</span></button>' +
    '<span class="note">' + esc(op.mode === 'new' ? t('skNewNote') : SK.target.length ? t('skTargetNote', SK.target.map((id) => (bodyById(id) || {}).name).join(', ')) : t('skAutoTarget')) + '</span></fieldset>';
  h += '<fieldset><legend>' + esc(t('skGridL')) + '</legend><div class="grid2"><label>' + esc(t('skGridStep')) + '<select class="sel" data-sk="grid">' + [0, 0.1, 0.25, 0.5, 1, 2, 5, 10].map((v) => '<option value="' + v + '"' + (v === SK.grid ? ' selected' : '') + '>' + (v ? v + ' mm' : t('off')) + '</option>').join('') + '</select></label>' + num('polyN', op.polyN, t('skPolyN')) + '</div></fieldset>';
  // entities with editable sizes
  h += '<fieldset><legend>' + esc(t('skEntities')) + ' (' + SK.ents.length + ')</legend>';
  if (!SK.ents.length) h += '<span class="note">' + esc(t('skNoEnts')) + '</span>';
  SK.ents.forEach((e, i) => {
    const on = SK.sel === e.id;
    const field = (k, v, lab) => '<label>' + esc(lab) + '<input class="num" type="number" step="any" data-ent="' + e.id + '" data-k="' + k + '" value="' + +Number(v).toFixed(4) + '"></label>';
    h += '<div class="ent' + (on ? ' on' : '') + '" data-ei="' + e.id + '"><div class="entt"><b>' + esc(t('skE_' + e.t)) + ' ' + (i + 1) + '</b>' + (isClosed(e) ? '' : ' <span class="note warn">' + esc(t('skOpen')) + '</span>') + '<button class="eye" data-edel="' + e.id + '" title="' + esc(t('delete')) + '">' + IC.svg('trash') + '</button></div>';
    if (e.t === 'rect') h += '<div class="grid2">' + field('x', e.x, 'X') + field('y', e.y, 'Y') + field('w', e.w, t('p_w')) + field('h', e.h, t('skH')) + '</div>';
    else if (e.t === 'circle') h += '<div class="grid3">' + field('x', e.x, 'X') + field('y', e.y, 'Y') + field('r', e.r, t('p_r')) + '</div>';
    else if (e.t === 'poly') h += '<div class="grid3">' + field('x', e.x, 'X') + field('y', e.y, 'Y') + field('r', e.r, t('p_r')) + field('n', e.n, t('p_n')) + field('a', e.a || 0, t('angleDeg')) + '</div>';
    else if (on) h += '<div class="grid2">' + e.pts.map((pt, k) => field('p' + k + 'x', pt[0], 'X' + (k + 1)) + field('p' + k + 'y', pt[1], 'Y' + (k + 1))).join('') + '</div>';
    else h += '<span class="note">' + esc(t('skPoints', e.pts.length)) + '</span>';
    h += '</div>';
  });
  h += '</fieldset><div class="btnrow"><button class="btn danger" id="skCancel" data-ic="x"><span>' + esc(t('skExit')) + '</span></button></div>';
  p.innerHTML = h;
  applyStatic(p);
  const dirSel = p.querySelector('[data-sk=dir]'); if (dirSel) dirSel.value = op.dir;
  const axSel = p.querySelector('[data-sk=axis]'); if (axSel) axSel.value = op.axis;
  p.querySelectorAll('#skKind [data-k]').forEach((b) => b.addEventListener('click', () => { op.kind = b.dataset.k; renderSketchPane(); skPreview(); }));
  p.querySelectorAll('#skMode [data-m]').forEach((b) => b.addEventListener('click', () => { op.mode = b.dataset.m; renderSketchPane(); skPreview(); }));
  p.querySelectorAll('[data-sk]').forEach((i) => i.addEventListener('change', () => {
    const k = i.dataset.sk, v = i.tagName === 'SELECT' && !['grid'].includes(k) ? i.value : Number(i.value);
    if (k === 'grid') { SK.grid = v; skGrid(); req(); return; }
    op[k] = v; skPreview();
  }));
  p.querySelectorAll('[data-sk=dist]').forEach((i) => i.addEventListener('input', () => { op.dist = Number(i.value); skPreview(); }));
  p.querySelectorAll('[data-ent]').forEach((i) => i.addEventListener('change', () => {
    const e = SK.ents.find((x) => x.id === Number(i.dataset.ent)); if (!e) return;
    const k = i.dataset.k, v = Number(i.value); if (!isFinite(v)) return;
    const m = /^p(\d+)([xy])$/.exec(k);
    if (m) e.pts[Number(m[1])][m[2] === 'x' ? 0 : 1] = v;
    else if ((k === 'w' || k === 'h' || k === 'r') && !(v > 0)) return;
    else e[k] = k === 'n' ? Math.max(3, Math.round(v)) : v;
    skDraw();
  }));
  p.querySelectorAll('[data-ei]').forEach((d) => d.addEventListener('click', (ev) => { if (ev.target.closest('input,button')) return; SK.sel = Number(d.dataset.ei); skDraw(); renderSketchPane(); }));
  p.querySelectorAll('[data-edel]').forEach((b) => b.addEventListener('click', () => { SK.ents = SK.ents.filter((x) => x.id !== Number(b.dataset.edel)); skDraw(); renderSketchPane(); }));
  $('skGo').addEventListener('click', () => sketchFinish());
  $('skCancel').addEventListener('click', () => { if (!SK.ents.length || confirm(t('skConfirmExit'))) endSketch(); });
}

// ---------- command bar ----------
function renderCmdBar() {
  const bar = $('cmdBar'); if (!bar) return;
  const c = (id, ic, label, opts) => '<button class="cmd' + (opts && opts.cls ? ' ' + opts.cls : '') + '" data-cmd="' + id + '"' + (opts && opts.on ? ' aria-pressed="true"' : '') + (opts && opts.dis ? ' disabled' : '') + ' title="' + esc(opts && opts.tip || label) + '">' + IC.svg(ic) + '<span>' + esc(label) + '</span></button>';
  const sep = '<span class="cmdsep"></span>';
  let h;
  if (SK.on) {
    h = '<span class="cmdlabel">' + esc(t('sketch')) + '</span>' +
      c('sk-select', 'cursor', t('skT_select'), { on: SK.tool === 'select', tip: t('skT_select') + ' (Q)' }) +
      c('sk-line', 'line', t('skT_line'), { on: SK.tool === 'line' && !SK.arcNext, tip: t('skT_line') + ' (L)' }) +
      c('sk-arc', 'arc', t('skT_arc'), { on: SK.tool === 'line' && SK.arcNext, tip: t('skT_arcTip') }) +
      c('sk-rect', 'rect', t('skT_rect'), { on: SK.tool === 'rect', tip: t('skT_rect') + ' (R)' }) +
      c('sk-circle', 'circle', t('skT_circle'), { on: SK.tool === 'circle', tip: t('skT_circle') + ' (C)' }) +
      c('sk-poly', 'polygon', t('skT_poly'), { on: SK.tool === 'poly', tip: t('skT_poly') + ' (P)' }) + sep +
      c('sk-extrude', 'box', t('skExtrude'), { cls: 'big' }) + c('sk-revolve', 'revolve', t('skRevolve'), { cls: 'big' }) + c('sk-cut', 'subtract', t('skCutShort'), { cls: 'big' }) +
      c('sk-exit', 'exit', t('skExit'), { cls: 'exit' });
  } else {
    const n = selBodies().length;
    h = c('sketch', 'sketch', t('cmdSketch'), { cls: 'big', tip: t('cmdSketchTip') }) + c('pull', 'pull', t('cmdPull'), { tip: t('cmdPullTip') }) + sep +
      c('pattern', 'pattern', t('cmdPattern')) + c('cpattern', 'cpattern', t('cmdCPattern')) + c('mirror', 'mirror', t('opMirror')) + sep +
      c('fuse', 'union', t('fuse')) + c('cut', 'subtract', t('cut')) + c('common', 'intersect', t('common')) + sep +
      c('fillet', 'fillet', t('fillet')) + c('chamfer', 'chamfer', t('chamfer')) + sep +
      c('t-move', 'move', t('cmdMove'), { on: tool === 'move' }) + c('t-rotate', 'rotate', t('cmdRotate'), { on: tool === 'rotate' }) + c('t-measure', 'ruler', t('cmdMeasure'), { on: tool === 'measure' });
    void n;
  }
  bar.innerHTML = h;
  bar.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', (e) => runCmd(b.dataset.cmd, b, e)));
  $('skPlaneName').textContent = SK.on ? SK.planeName || '' : '';
}
function runCmd(id, el) {
  const r = el.getBoundingClientRect();
  switch (id) {
    case 'sketch': startSketchMenu(r.left, r.bottom + 4); return;
    case 'pull': focusOp('pull'); return;
    case 'pattern': focusOp('pattern'); return;
    case 'cpattern': focusOp('cpattern'); return;
    case 'mirror': focusOp('mirror'); return;
    case 'fuse': case 'cut': case 'common': if (selBodies().length >= 2) runOp(id); else focusOp('bool'); return;
    case 'fillet': case 'chamfer': focusOp('edges'); return;
    case 't-move': setTool(tool === 'move' ? 'select' : 'move'); renderCmdBar(); return;
    case 't-rotate': setTool(tool === 'rotate' ? 'select' : 'rotate'); renderCmdBar(); return;
    case 't-measure': setTool(tool === 'measure' ? 'select' : 'measure'); renderCmdBar(); return;
    case 'sk-select': setSkTool('select'); return;
    case 'sk-line': setSkTool('line'); return;
    case 'sk-arc': toggleArc(); return;
    case 'sk-rect': setSkTool('rect'); return;
    case 'sk-circle': setSkTool('circle'); return;
    case 'sk-poly': setSkTool('poly'); return;
    case 'sk-extrude': SK.op.kind = 'extrude'; if (SK.op.mode === 'cut') SK.op.mode = 'new'; renderSketchPane(); skPreview(); sketchFinish('extrude'); return;
    case 'sk-revolve': SK.op.kind = 'revolve'; if (SK.op.mode === 'cut') SK.op.mode = 'new'; renderSketchPane(); skPreview(); sketchFinish('revolve'); return;
    case 'sk-cut': SK.op.mode = 'cut'; renderSketchPane(); skPreview(); sketchFinish(SK.op.kind, 'cut'); return;
    case 'sk-exit': if (!SK.ents.length || confirm(t('skConfirmExit'))) endSketch(); return;
  }
}
function startSketchMenu(x, y) {
  if (SK.on) return;
  const face = sel.find((s) => s.f != null);
  if (x == null) { const r = $('cmdBar').getBoundingClientRect(); x = r.left + 10; y = r.bottom + 4; }
  showMenu(x, y, '<div class="ttl">' + esc(t('skWhere')) + '</div>' +
    mi('face', 'target', t('skOnFace'), '', { dis: !face }) + '<hr>' + mi('xy', 'sketch', t('skPlaneXY'), '') + mi('xz', 'sketch', t('skPlaneXZ'), '') + mi('yz', 'sketch', t('skPlaneYZ'), ''),
  { face: () => startSketch('face'), xy: () => startSketch('xy'), xz: () => startSketch('xz'), yz: () => startSketch('yz') });
}
function sketchMenu(x, y) {
  showMenu(x, y, '<div class="ttl">' + esc(t('sketch')) + '</div>' +
    mi('line', 'line', t('skT_line'), 'L') + mi('arc', 'arc', t('skT_arc'), 'A') + mi('rect', 'rect', t('skT_rect'), 'R') + mi('circle', 'circle', t('skT_circle'), 'C') + mi('poly', 'polygon', t('skT_poly'), 'P') + mi('select', 'cursor', t('skT_select'), 'Q') +
    '<hr>' + mi('del', 'trash', t('delete'), 'Del', { dis: !SK.sel }) + mi('exit', 'exit', t('skExit'), '', { bad: true }),
  { line: () => setSkTool('line'), arc: toggleArc, rect: () => setSkTool('rect'), circle: () => setSkTool('circle'), poly: () => setSkTool('poly'), select: () => setSkTool('select'),
    del: () => { SK.ents = SK.ents.filter((x2) => x2.id !== SK.sel); SK.sel = null; skDraw(); renderSketchPane(); }, exit: () => { if (!SK.ents.length || confirm(t('skConfirmExit'))) endSketch(); } });
}
