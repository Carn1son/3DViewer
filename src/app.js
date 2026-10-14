/* 3DViewer — main page: scene, model tree, selection, appearance tools, modelling commands.
   Import/export lives in io.js (same scope, appended by the build). */
/* global THREE, IC, I18N */
'use strict';
const $ = (id) => document.getElementById(id);
const VLABEL = '__VLABEL__', VDATE = '__VDATE__';
const GITHUB = 'https://github.com/Carn1son/3DViewer';
const TELEGRAM = 'https://t.me/carnison';
THREE.Object3D.DEFAULT_UP.set(0, 0, 1); // CAD convention: Z is up

// ---------------- settings ----------------
const DEF = {
  lang: 'ru', theme: 'dark', bg: 'grad', edges: true, grid: true, axes: true, quality: 'mid', persp: true, mode: 'shadedEdges',
  snapMove: 0, snapRot: 15, newColor: '#b8c0c6', recent: [], schema: 4, structure: 'part', clearFaces: true, autoPaint: true,
  lw: 300, rw: 330, right: true, tab: 'look', filter: 'body',
};
let S = Object.assign({}, DEF);
try { Object.assign(S, JSON.parse(localStorage.getItem('tdv.settings') || '{}')); } catch (e) { /* no storage */ }
function saveS() { try { localStorage.setItem('tdv.settings', JSON.stringify(S)); } catch (e) { /* no storage */ } }

function t(k) {
  const d = (I18N[S.lang] && I18N[S.lang][k]) != null ? I18N[S.lang][k] : (I18N.ru[k] != null ? I18N.ru[k] : k);
  let s = String(d);
  for (let i = 1; i < arguments.length; i++) s = s.split('{' + (i - 1) + '}').join(arguments[i]);
  return s;
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d) => { if (v == null || !isFinite(v)) return '—'; const n = Number(v); const a = Math.abs(n); const dd = d != null ? d : a >= 100 ? 1 : a >= 1 ? 2 : 3; return n.toFixed(dd).replace(/\.?0+$/, '') || '0'; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function applyStatic(root) {
  (root || document).querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  (root || document).querySelectorAll('[data-tt]').forEach((el) => { el.title = t(el.dataset.tt); el.setAttribute('aria-label', t(el.dataset.tt)); });
  (root || document).querySelectorAll('[data-ic]').forEach((el) => {
    if (el.querySelector(':scope > svg')) el.querySelector(':scope > svg').remove();
    el.insertAdjacentHTML('afterbegin', IC.svg(el.dataset.ic));
  });
  document.documentElement.lang = S.lang;
}

// ---------------- toasts, busy ----------------
function toast(msg, kind, ms) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms || (kind === 'err' ? 7000 : 3500));
}
let busyN = 0, busyTimer = 0;
function busy(on, text) {
  busyN += on ? 1 : -1;
  if (on) {
    $('busyText').textContent = text || t('working');
    clearTimeout(busyTimer);
    busyTimer = setTimeout(() => { if (busyN > 0) $('busy').hidden = false; }, 120);
  } else if (busyN <= 0) { busyN = 0; clearTimeout(busyTimer); $('busy').hidden = true; }
}
async function withBusy(text, fn) {
  busy(true, text);
  try { return await fn(); }
  catch (e) { console.error(e); toast(errMsg(e), 'err'); return null; }
  finally { busy(false); }
}
function errMsg(e) {
  const m = String((e && e.message) || e || '');
  if (m === 'KERNEL') return t('errKernel');
  return m;
}

// ---------------- CAD kernel (Web Worker) ----------------
const K = { worker: null, seq: 0, pend: new Map(), state: 'loading', readyP: null };
function setK(st) {
  K.state = st;
  const dot = $('kDot');
  dot.className = 'dot' + (st === 'ready' ? ' ok' : st === 'failed' ? ' bad' : '');
  $('kText').textContent = t(st === 'ready' ? 'kReady' : st === 'failed' ? 'kFailed' : 'kLoading');
}
function kernelStart() {
  setK('loading');
  K.readyP = new Promise((resolve, reject) => {
    const go = () => {
      const L = window.TDV_KERNEL;
      if (!L) { reject(new Error('kernel file missing')); return; }
      const url = URL.createObjectURL(new Blob([L.src], { type: 'text/javascript' }));
      K.worker = new Worker(url);
      K.worker.onmessage = (e) => {
        const m = e.data, p = K.pend.get(m.id);
        if (!p) return;
        K.pend.delete(m.id);
        if (m.ok) p.res(m.result); else p.rej(new Error(m.error));
      };
      K.worker.onerror = (e) => { console.error(e); };
      const id = ++K.seq;
      K.pend.set(id, { res: () => { resolve(true); }, rej: reject });
      K.worker.postMessage({ id, cmd: 'init', ocWasm: L.oc, oiWasm: L.oi });
      L.oc = L.oi = L.src = null; // the worker has its copy
    };
    if (window.TDV_KERNEL) { go(); return; }
    const s = document.createElement('script');
    s.src = 'kernel.js';
    s.onload = go;
    s.onerror = () => reject(new Error('kernel file missing'));
    document.head.appendChild(s);
  });
  K.readyP.then(() => setK('ready'), (e) => { console.error(e); setK('failed'); });
}
async function kcall(cmd, args, transfer) {
  if (K.state === 'loading') { $('busyText').textContent = t('kWait'); }
  await K.readyP;
  return new Promise((res, rej) => {
    const id = ++K.seq;
    K.pend.set(id, { res, rej });
    K.worker.postMessage({ id, cmd, args }, transfer || []);
  });
}

// ---------------- document state, undo ----------------
let state = { groups: [], bodies: [] };
const undoStack = [], redoStack = [];
let uid = 1;
const newId = () => uid++;
let docName = '';

function mkBody(o) {
  return Object.assign({ id: newId(), name: 'Body', group: 0, kind: 'brep', sid: 0, mesh: null, color: null, faceColors: {}, alpha: 1, metal: 0.15, rough: 0.5, visible: true, vcol: false }, o);
}
function mkGroup(name) { return { id: newId(), name, open: true, visible: true }; }
function commit(next) {
  undoStack.push(state);
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
  state = next;
  changed();
}
function undo() { if (!undoStack.length) return; redoStack.push(state); state = undoStack.pop(); changed(); }
function redo() { if (!redoStack.length) return; undoStack.push(state); state = redoStack.pop(); changed(); }
const bodyById = (id) => state.bodies.find((b) => b.id === id);
const groupById = (id) => state.groups.find((g) => g.id === id);
function withBodies(ids, fn) {
  const set = new Set(ids);
  return Object.assign({}, state, { bodies: state.bodies.map((b) => (set.has(b.id) ? fn(Object.assign({}, b, { faceColors: Object.assign({}, b.faceColors) })) || b : b)) });
}
function ensureGroup(name, st) {
  const s = st || state;
  const g = mkGroup(name);
  return { st: Object.assign({}, s, { groups: s.groups.concat([g]) }), gid: g.id };
}
function modelGroup(st) { // where newly created bodies go
  const s = st || state;
  const g = s.groups.find((x) => x.name === t('modelGroup'));
  if (g) return { st: s, gid: g.id };
  return ensureGroup(t('modelGroup'), s);
}
// free kernel shapes and GPU buffers nothing refers to any more
let gcTimer = 0;
function scheduleGC() {
  clearTimeout(gcTimer);
  gcTimer = setTimeout(() => {
    const sids = new Set(), meshes = new Set();
    [state].concat(undoStack, redoStack).forEach((s) => s.bodies.forEach((b) => { if (b.sid) sids.add(b.sid); if (b.mesh) meshes.add(b.mesh); }));
    const dead = [];
    liveSids.forEach((id) => { if (!sids.has(id)) dead.push(id); });
    dead.forEach((id) => liveSids.delete(id));
    if (dead.length && K.state === 'ready') kcall('free', { sids: dead }).catch(() => {});
    baseGeo.forEach((g, m) => { if (!meshes.has(m)) { g.dispose(); baseGeo.delete(m); const e = edgeGeo.get(m); if (e) { e.dispose(); edgeGeo.delete(m); } } });
  }, 800);
}
const liveSids = new Set();
function track(sid) { if (sid) liveSids.add(sid); return sid; }

// ---------------- three.js scene ----------------
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping || THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
stage.prepend(renderer.domElement);
renderer.domElement.tabIndex = 0;
const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.85;
const world = new THREE.Group(); scene.add(world);
const helpers = new THREE.Group(); scene.add(helpers);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445048, 0.35));
const pcam = new THREE.PerspectiveCamera(30, 1, 0.1, 10000);
const ocam = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
[pcam, ocam].forEach((c) => { const l = new THREE.DirectionalLight(0xffffff, 1.1); l.position.set(0.3, 0.6, 1); c.add(l); scene.add(c); });
let cam = S.persp ? pcam : ocam;
pcam.position.set(80, -120, 90);
const controls = new THREE.OrbitControls(cam, renderer.domElement);
controls.enableDamping = false;
controls.zoomToCursor = true;
controls.screenSpacePanning = true;
controls.rotateSpeed = 0.9;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
controls.addEventListener('change', () => req());
let orthoHeight = 100;

// grid
let grid = null;
function rebuildGrid(size) {
  if (grid) { helpers.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  const step = Math.pow(10, Math.floor(Math.log10(Math.max(size, 1) / 2)));
  const n = 20, total = step * n;
  grid = new THREE.GridHelper(total, n, 0x5c6b64, 0x3a4440);
  grid.rotation.x = Math.PI / 2;
  grid.material.transparent = true; grid.material.opacity = S.theme === 'light' ? 0.55 : 0.45; grid.material.depthWrite = false;
  grid.visible = !!S.grid;
  grid.renderOrder = -1;
  grid.userData.step = step;
  helpers.add(grid);
}
rebuildGrid(100);

// axis triad in the corner
const triScene = new THREE.Scene();
const triCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, -10, 10);
(function () {
  const mk = (dir, col, label) => {
    const a = new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, col, 0.28, 0.16);
    triScene.add(a);
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'); g.fillStyle = '#' + new THREE.Color(col).getHexString(); g.font = 'bold 44px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, 32, 34);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
    sp.position.copy(dir).multiplyScalar(1.32); sp.scale.setScalar(0.5); triScene.add(sp);
  };
  mk(new THREE.Vector3(1, 0, 0), 0xe0524a, 'X'); mk(new THREE.Vector3(0, 1, 0), 0x3fd07a, 'Y'); mk(new THREE.Vector3(0, 0, 1), 0x4a8ee0, 'Z');
})();

let rafId = 0;
function req() { if (!rafId) rafId = requestAnimationFrame(frame); }
function frame() {
  rafId = 0;
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w, h);
  renderer.render(scene, cam);
  if (S.axes) {
    const sz = 92;
    triCam.position.copy(cam.position).sub(controls.target).normalize().multiplyScalar(4);
    triCam.quaternion.copy(cam.quaternion);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.setScissorTest(true);
    renderer.setScissor(8, 8, sz, sz); renderer.setViewport(8, 8, sz, sz);
    renderer.render(triScene, triCam);
    renderer.setScissorTest(false);
    renderer.autoClear = true;
  }
  placeMeasureLabel();
  if (SK.on && skLast && SK.snapEl && !SK.snapEl.hidden) skSnapMark(skLast);
}
function resize() {
  const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
  renderer.setSize(w, h, false);
  pcam.aspect = w / h; pcam.updateProjectionMatrix();
  setOrthoFrustum();
  req();
}
function setOrthoFrustum() {
  const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight), a = w / h;
  ocam.left = -orthoHeight * a / 2; ocam.right = orthoHeight * a / 2; ocam.top = orthoHeight / 2; ocam.bottom = -orthoHeight / 2;
  ocam.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);

function setProjection(persp) {
  const dir = new THREE.Vector3().subVectors(cam.position, controls.target);
  const dist = dir.length();
  if (persp && cam === ocam) {
    const d = (orthoHeight / ocam.zoom) / 2 / Math.tan(THREE.MathUtils.degToRad(pcam.fov / 2));
    pcam.position.copy(controls.target).add(dir.normalize().multiplyScalar(d));
    pcam.up.copy(ocam.up);
    cam = pcam;
  } else if (!persp && cam === pcam) {
    orthoHeight = 2 * dist * Math.tan(THREE.MathUtils.degToRad(pcam.fov / 2));
    ocam.zoom = 1; setOrthoFrustum();
    ocam.position.copy(pcam.position); ocam.up.copy(pcam.up);
    cam = ocam;
  }
  controls.object = cam; controls.update();
  S.persp = persp; saveS();
  $('vProj').setAttribute('aria-pressed', String(!persp));
  req();
}

function sceneBox(onlySel) {
  const box = new THREE.Box3();
  const ids = onlySel ? new Set(selBodies().map((b) => b.id)) : null;
  objs.forEach((o, id) => {
    if (!o.grp.visible) return;
    if (ids && !ids.has(id)) return;
    o.grp.updateMatrixWorld(true);
    const g = o.mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    box.union(g.boundingBox.clone().applyMatrix4(o.grp.matrixWorld));
  });
  return box;
}
function fitView(dirVec, onlySel) {
  let box = sceneBox(onlySel && selBodies().length);
  if (box.isEmpty()) box = new THREE.Box3(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 50));
  const sph = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sph.radius, 0.01);
  const dir = dirVec ? dirVec.clone().normalize() : new THREE.Vector3().subVectors(cam.position, controls.target).normalize();
  if (dir.lengthSq() < 0.5) dir.set(1, -1.4, 1).normalize();
  const d = r / Math.sin(THREE.MathUtils.degToRad(pcam.fov / 2)) * 1.08;
  controls.target.copy(sph.center);
  pcam.position.copy(sph.center).add(dir.clone().multiplyScalar(d));
  ocam.position.copy(sph.center).add(dir.clone().multiplyScalar(r * 4));
  orthoHeight = r * 2.25; ocam.zoom = 1; setOrthoFrustum();
  [pcam, ocam].forEach((c) => {
    c.up.set(0, 0, 1);
    if (Math.abs(dir.z) > 0.999) c.up.set(0, dir.z > 0 ? 1 : -1, 0);
    c.near = Math.max(d / 2000, 0.001); c.far = d * 200;
  });
  pcam.updateProjectionMatrix(); ocam.updateProjectionMatrix();
  controls.update();
  if (!onlySel) rebuildGrid(Math.max(box.max.x - box.min.x, box.max.y - box.min.y, 10) * 1.6);
  req();
}
const VIEWS = {
  front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 0, 1], bottom: [0, 0, -1], iso: [1, -1, 0.8], iso2: [-1, -1, 0.8],
};
function setView(name) { fitView(new THREE.Vector3().fromArray(VIEWS[name])); }

// ---------------- bodies in the scene ----------------
const objs = new Map(); // body id -> {grp, mesh, edges, rec, overlays}
const baseGeo = new Map(); // mesh data -> BufferGeometry (attributes shared between bodies and undo steps)
const edgeGeo = new Map();
const edgeMat = new THREE.LineBasicMaterial({ color: 0x0c0f0e, transparent: true, opacity: 0.75 });
const selEdgeMat = new THREE.LineBasicMaterial({ color: 0x3fd07a });
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function base(mesh) {
  let g = baseGeo.get(mesh);
  if (g) return g;
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mesh.position, 3));
  if (mesh.index && mesh.index.length) g.setIndex(new THREE.BufferAttribute(mesh.index, 1));
  if (mesh.normal && mesh.normal.length === mesh.position.length) g.setAttribute('normal', new THREE.BufferAttribute(mesh.normal, 3));
  else if (mesh.index && mesh.index.length) g.computeVertexNormals();
  if (mesh.colors && mesh.colors.length === mesh.position.length) g.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3));
  g.computeBoundingBox(); g.computeBoundingSphere();
  baseGeo.set(mesh, g);
  return g;
}
function viewGeo(mesh) { // own groups/draw range, shared buffers
  const b = base(mesh), g = new THREE.BufferGeometry();
  for (const k in b.attributes) g.setAttribute(k, b.attributes[k]);
  g.setIndex(b.index);
  g.boundingBox = b.boundingBox; g.boundingSphere = b.boundingSphere;
  return g;
}
function edgesOf(mesh) {
  let e = edgeGeo.get(mesh);
  if (e !== undefined) return e;
  e = null;
  if (mesh.edges && mesh.edges.length) {
    e = new THREE.BufferGeometry();
    e.setAttribute('position', new THREE.BufferAttribute(mesh.edges, 3));
  } else if (mesh.index && mesh.index.length && mesh.index.length / 3 < 400000) {
    e = new THREE.EdgesGeometry(base(mesh), 35);
  }
  edgeGeo.set(mesh, e);
  return e;
}
function lookMat(color, b) {
  const op = b.alpha == null ? 1 : b.alpha;
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color), metalness: b.metal, roughness: b.rough, side: THREE.DoubleSide,
    transparent: op < 1 || S.mode === 'xray', opacity: S.mode === 'xray' ? Math.min(op, 0.3) : op, depthWrite: !(op < 1 || S.mode === 'xray'),
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, wireframe: S.mode === 'wire',
    vertexColors: !!b.vcol && !!(b.mesh && b.mesh.colors),
  });
  return m;
}
function bodyColor(b) { return b.color || S.newColor; }
function applyLook(o, b) {
  const old = Array.isArray(o.mesh.material) ? o.mesh.material : [o.mesh.material];
  old.forEach((m) => m && m.dispose());
  const g = o.mesh.geometry;
  g.clearGroups();
  if (b.kind === 'points') {
    o.mesh.material = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: !!(b.mesh && b.mesh.colors), color: b.mesh && b.mesh.colors ? 0xffffff : new THREE.Color(bodyColor(b)) });
    return;
  }
  const mats = [lookMat(bodyColor(b), b)];
  const fc = b.faceColors || {};
  const keys = Object.keys(fc);
  if (keys.length && b.mesh.groups) {
    const idxOf = new Map();
    let run = null;
    for (const gr of b.mesh.groups) {
      const c = fc[gr[2]];
      let mi = 0;
      if (c) { if (!idxOf.has(c)) { idxOf.set(c, mats.length); mats.push(lookMat(c, Object.assign({}, b, { vcol: false }))); } mi = idxOf.get(c); }
      if (run && run.mi === mi && run.end === gr[0]) run.end = gr[0] + gr[1];
      else { if (run) g.addGroup(run.start, run.end - run.start, run.mi); run = { start: gr[0], end: gr[0] + gr[1], mi }; }
    }
    if (run) g.addGroup(run.start, run.end - run.start, run.mi);
    o.mesh.material = mats;
  } else o.mesh.material = mats[0];
  if (o.edges) o.edges.visible = !!S.edges && (S.mode === 'shadedEdges' || S.mode === 'xray');
}
function buildObj(b) {
  const grp = new THREE.Group();
  grp.userData.bodyId = b.id;
  let mesh, edges = null;
  if (b.kind === 'points') {
    mesh = new THREE.Points(viewGeo(b.mesh), new THREE.PointsMaterial());
  } else {
    mesh = new THREE.Mesh(viewGeo(b.mesh), new THREE.MeshStandardMaterial());
    const eg = edgesOf(b.mesh);
    if (eg) { edges = new THREE.LineSegments(eg, edgeMat); edges.raycast = () => {}; grp.add(edges); }
  }
  mesh.userData.bodyId = b.id;
  grp.add(mesh);
  world.add(grp);
  return { grp, mesh, edges, rec: null, data: b.mesh, ov: [] };
}
function disposeObj(o) {
  world.remove(o.grp);
  const mats = Array.isArray(o.mesh.material) ? o.mesh.material : [o.mesh.material];
  mats.forEach((m) => m && m.dispose());
  clearOverlays(o);
}
function groupVisible(gid) { const g = groupById(gid); return !g || g.visible; }
function syncScene() {
  const seen = new Set();
  for (const b of state.bodies) {
    seen.add(b.id);
    let o = objs.get(b.id);
    if (o && o.data !== b.mesh) { disposeObj(o); o = null; }
    if (!o) { o = buildObj(b); objs.set(b.id, o); }
    if (o.rec !== b || o.mode !== S.mode + S.edges) { applyLook(o, b); o.mode = S.mode + S.edges; }
    o.rec = b;
    o.grp.visible = b.visible && groupVisible(b.group);
  }
  objs.forEach((o, id) => { if (!seen.has(id)) { disposeObj(o); objs.delete(id); } });
  req();
}
function refreshLooks() { objs.forEach((o) => { o.mode = ''; }); syncScene(); }

// overlays: selection (accent) and hover
const ovMat = { sel: null, hov: null };
function ovMaterials() {
  const acc = cssVar('--hl') || '#3fd07a', hov = cssVar('--hover') || '#9be7b9';
  selEdgeMat.color.set(acc);
  ovMat.sel = new THREE.MeshBasicMaterial({ color: new THREE.Color(acc), transparent: true, opacity: 0.26, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  ovMat.hov = new THREE.MeshBasicMaterial({ color: new THREE.Color(hov), transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
}
function clearOverlays(o) { o.ov.forEach((m) => { o.grp.remove(m); m.geometry.dispose(); }); o.ov = []; }
function addOverlay(o, fi, mat) {
  const g = viewGeo(o.data);
  if (fi != null && o.data.groups) {
    const gr = o.data.groups[fi];
    if (!gr) return;
    g.setDrawRange(gr[0], gr[1]);
  }
  const m = o.rec.kind === 'points' ? new THREE.Points(g, new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, color: mat.color })) : new THREE.Mesh(g, mat);
  m.raycast = () => {}; m.renderOrder = 2;
  o.grp.add(m); o.ov.push(m);
}
function updateHighlights() {
  if (!ovMat.sel) ovMaterials();
  objs.forEach((o) => { clearOverlays(o); if (o.edges) o.edges.material = edgeMat; });
  sel.forEach((s) => { const o = objs.get(s.b); if (o) { addOverlay(o, s.f, ovMat.sel); if (s.f == null && o.edges) o.edges.material = selEdgeMat; } });
  if (hover && !(sel.some((s) => s.b === hover.b && (s.f === hover.f || s.f == null)))) {
    const o = objs.get(hover.b);
    if (o) addOverlay(o, S.filter === 'face' || tool === 'paint' && S.filter === 'face' ? hover.f : null, ovMat.hov);
  }
  req();
}

// ---------------- picking ----------------
const ray = new THREE.Raycaster();
ray.params.Points.threshold = 0.5;
const ndc = new THREE.Vector2();
function pickAt(cx, cy) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, cam);
  const list = [];
  objs.forEach((o) => { if (o.grp.visible) list.push(o.mesh); });
  const hit = ray.intersectObjects(list, false)[0];
  if (!hit) return null;
  const id = hit.object.userData.bodyId, b = bodyById(id);
  let fi = null;
  if (b && b.mesh.groups && hit.faceIndex != null) {
    const at = hit.faceIndex * 3, G = b.mesh.groups;
    let lo = 0, hi = G.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (G[mid][0] + G[mid][1] <= at) lo = mid + 1; else if (G[mid][0] > at) hi = mid - 1; else { fi = mid; break; } }
  }
  return { b: id, f: fi, point: hit.point.clone(), normal: hit.face ? hit.face.normal.clone() : null };
}

// ---------------- selection ----------------
let sel = []; // [{b, f}] f = face index or null (whole body)
let hover = null;
const selBodies = () => { const ids = new Set(sel.map((s) => s.b)); return state.bodies.filter((b) => ids.has(b.id)); };
function setSel(list) {
  sel = list.filter((s) => bodyById(s.b));
  updateHighlights(); renderTree(); renderProps(); renderOps(); updateStatus();
  attachGizmo();
  if (!$('paneCreate').hidden) renderCreate();
}
function toggleSel(item, add) {
  if (!add) { setSel(item ? [item] : []); return; }
  const i = sel.findIndex((s) => s.b === item.b && s.f === item.f);
  if (i >= 0) setSel(sel.filter((_, k) => k !== i)); else setSel(sel.concat([item]));
}

// ---------------- appearance ----------------
let cur = { color: '#c0392b', alpha: 1, metal: 0.15, rough: 0.5 };
try { const c = JSON.parse(localStorage.getItem('tdv.cur') || 'null'); if (c && c.color) cur = c; } catch (e) { /* none */ }
let clip = null; // copied appearance
function lookOf(b, fi) {
  if (fi != null && b.faceColors && b.faceColors[fi]) return { color: b.faceColors[fi], alpha: b.alpha, metal: b.metal, rough: b.rough, face: true };
  return { color: bodyColor(b), alpha: b.alpha, metal: b.metal, rough: b.rough };
}
function setCur(look, quiet) {
  cur = { color: look.color, alpha: look.alpha == null ? 1 : look.alpha, metal: look.metal == null ? 0.15 : look.metal, rough: look.rough == null ? 0.5 : look.rough };
  try { localStorage.setItem('tdv.cur', JSON.stringify(cur)); } catch (e) { /* no storage */ }
  renderLookTop();
  if (!quiet) pushRecent(cur);
}
function pushRecent(l) {
  const k = l.color + '|' + l.metal + '|' + l.rough + '|' + l.alpha;
  S.recent = [l].concat((S.recent || []).filter((r) => r.color + '|' + r.metal + '|' + r.rough + '|' + r.alpha !== k)).slice(0, 14);
  saveS();
  renderRecent();
}
// apply a look: items [{b, f}]; scope 'face' writes face colours, 'body' the body look, 'group' every body in the component
function paint(items, look, scope) {
  if (!items.length) return;
  const byBody = new Map();
  items.forEach((it) => { if (!byBody.has(it.b)) byBody.set(it.b, []); byBody.get(it.b).push(it.f); });
  let ids = Array.from(byBody.keys());
  if (scope === 'group') { const gs = new Set(ids.map((id) => bodyById(id).group)); ids = state.bodies.filter((b) => gs.has(b.group)).map((b) => b.id); }
  commit(withBodies(ids, (b) => {
    const faces = byBody.get(b.id) || [];
    if (scope === 'face' && faces.some((f) => f != null)) {
      faces.forEach((f) => { if (f != null) { if (look.color.toLowerCase() === bodyColor(b).toLowerCase()) delete b.faceColors[f]; else b.faceColors[f] = look.color; } });
    } else {
      b.color = look.color; b.alpha = look.alpha; b.metal = look.metal; b.rough = look.rough; b.vcol = false;
      if (S.clearFaces) b.faceColors = {};
    }
    return b;
  }));
  pushRecent(look);
}
function copyLook() {
  const s = sel[0];
  if (!s) { toast(t('selectFirst'), 'warn'); return; }
  clip = lookOf(bodyById(s.b), s.f);
  setCur(clip, true);
  toast(t('lookCopied'));
}
function pasteLook() {
  const look = clip || cur;
  if (!sel.length) { toast(t('selectFirst'), 'warn'); return; }
  paint(sel, look, sel.some((s) => s.f != null) ? 'face' : 'body');
  toast(t('lookPasted', sel.length));
}
function replaceColour(from, look) {
  const f = from.toLowerCase();
  let n = 0;
  const ids = state.bodies.filter((b) => bodyColor(b).toLowerCase() === f || Object.values(b.faceColors || {}).some((c) => c.toLowerCase() === f)).map((b) => b.id);
  if (!ids.length) return;
  commit(withBodies(ids, (b) => {
    if (bodyColor(b).toLowerCase() === f) { b.color = look.color; b.metal = look.metal; b.rough = look.rough; b.alpha = look.alpha; n++; }
    Object.keys(b.faceColors).forEach((k) => { if (b.faceColors[k].toLowerCase() === f) { b.faceColors[k] = look.color; n++; } });
    return b;
  }));
  toast(t('replaced', n));
}

// ---------------- tools ----------------
let tool = 'select';
function setTool(tl) {
  tool = tl;
  document.querySelectorAll('#toolBar [data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tl)));
  document.querySelectorAll('[data-ltool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ltool === tl)));
  stage.classList.toggle('pick', tl === 'pick' || tl === 'measure');
  stage.classList.toggle('paint', tl === 'paint');
  if (tl !== 'measure') clearMeasure(); else renderProps();
  if ((tl === 'pick' || tl === 'paint') && S.right && S.tab !== 'look') showTab('look');
  if ((tl === 'pick' || tl === 'paint') && !S.right) { S.right = true; layout(); showTab('look'); }
  attachGizmo();
  showHint();
}
function showHint() {
  const h = $('hint');
  if (SK.on) { h.innerHTML = t('skHint_' + SK.tool); h.hidden = false; return; }
  const map = { pick: 'hintPick', paint: S.filter === 'face' ? 'hintPaintFace' : 'hintPaintBody', move: 'hintMove', rotate: 'hintRotate', measure: 'hintMeasure' };
  if (map[tool]) { h.innerHTML = t(map[tool]); h.hidden = false; } else h.hidden = true;
}
function setFilter(f) {
  S.filter = f; saveS();
  document.querySelectorAll('#filterSeg [data-f]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === f)));
  if (f === 'body') setSel(uniqBodies(sel));
  showHint(); updateHighlights();
}
const uniqBodies = (list) => { const seen = new Set(), out = []; list.forEach((s) => { if (!seen.has(s.b)) { seen.add(s.b); out.push({ b: s.b, f: null }); } }); return out; };

// gizmo (move / rotate)
const gizmo = new THREE.TransformControls(cam, renderer.domElement);
const pivot = new THREE.Object3D(); scene.add(pivot);
const gizmoHelper = gizmo.getHelper ? gizmo.getHelper() : gizmo;
scene.add(gizmoHelper);
gizmo.setSize(1.1);
let gStart = null;
gizmo.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;
  if (e.value) { pivot.updateMatrixWorld(true); gStart = pivot.matrixWorld.clone(); }
  else if (gStart) { const d = new THREE.Matrix4().multiplyMatrices(pivot.matrixWorld, gStart.clone().invert()); gStart = null; commitTransform(d); }
});
gizmo.addEventListener('objectChange', () => {
  if (!gStart) return;
  pivot.updateMatrixWorld(true);
  const d = new THREE.Matrix4().multiplyMatrices(pivot.matrixWorld, gStart.clone().invert());
  selBodies().forEach((b) => { const o = objs.get(b.id); if (o) { o.grp.matrixAutoUpdate = false; o.grp.matrix.copy(d); o.grp.matrixWorldNeedsUpdate = true; } });
  req();
});
gizmo.addEventListener('change', () => req());
function attachGizmo() {
  gizmo.camera = cam;
  const bs = selBodies().filter((b) => b.visible);
  if ((tool !== 'move' && tool !== 'rotate') || !bs.length) { gizmo.detach(); req(); return; }
  const box = sceneBox(true);
  if (box.isEmpty()) { gizmo.detach(); return; }
  pivot.position.copy(box.getCenter(new THREE.Vector3())); pivot.rotation.set(0, 0, 0); pivot.scale.set(1, 1, 1);
  pivot.updateMatrixWorld(true);
  gizmo.setMode(tool === 'move' ? 'translate' : 'rotate');
  gizmo.setTranslationSnap(S.snapMove || null);
  gizmo.setRotationSnap(S.snapRot ? THREE.MathUtils.degToRad(S.snapRot) : null);
  gizmo.attach(pivot);
  req();
}
function resetObjMatrices() { objs.forEach((o) => { o.grp.matrix.identity(); o.grp.matrixAutoUpdate = true; o.grp.position.set(0, 0, 0); o.grp.rotation.set(0, 0, 0); o.grp.scale.set(1, 1, 1); }); }

// apply a 4x4 matrix to bodies (kernel for exact bodies, arrays for meshes); copy=true keeps the originals
async function transformBodies(bodies, m, opts) {
  opts = opts || {};
  const out = [];
  for (const b of bodies) {
    let nb;
    if (b.kind === 'brep' && b.sid) {
      const r = await kcall('transform', opts.mirror ? { sid: b.sid, mirror: opts.mirror, quality: S.quality } : { sid: b.sid, matrix: Array.from(m.elements), quality: S.quality });
      nb = Object.assign({}, b, { sid: track(r.sid), mesh: r.mesh, faceColors: Object.assign({}, b.faceColors) });
    } else {
      nb = Object.assign({}, b, { mesh: transformMesh(b.mesh, opts.mirror ? mirrorMatrix(opts.mirror) : m), faceColors: Object.assign({}, b.faceColors) });
    }
    out.push(nb);
  }
  return out;
}
function mirrorMatrix(mr) {
  const n = new THREE.Vector3().fromArray(mr.n).normalize(), p = new THREE.Vector3().fromArray(mr.p);
  const R = new THREE.Matrix4().set(
    1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.z, 0,
    -2 * n.y * n.x, 1 - 2 * n.y * n.y, -2 * n.y * n.z, 0,
    -2 * n.z * n.x, -2 * n.z * n.y, 1 - 2 * n.z * n.z, 0, 0, 0, 0, 1);
  return new THREE.Matrix4().makeTranslation(p.x, p.y, p.z).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
}
function transformMesh(mesh, m) {
  const pos = new Float32Array(mesh.position), v = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 3) { v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(m); pos[i] = v.x; pos[i + 1] = v.y; pos[i + 2] = v.z; }
  let normal = null;
  if (mesh.normal && mesh.normal.length) {
    normal = new Float32Array(mesh.normal);
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    for (let i = 0; i < normal.length; i += 3) { v.set(normal[i], normal[i + 1], normal[i + 2]).applyMatrix3(nm).normalize(); normal[i] = v.x; normal[i + 1] = v.y; normal[i + 2] = v.z; }
  }
  let index = mesh.index;
  if (m.determinant() < 0 && index && index.length) { // mirrored: flip winding
    index = new Uint32Array(index);
    for (let i = 0; i < index.length; i += 3) { const a = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = a; }
  }
  let edges = mesh.edges;
  if (edges && edges.length) { edges = new Float32Array(edges); for (let i = 0; i < edges.length; i += 3) { v.set(edges[i], edges[i + 1], edges[i + 2]).applyMatrix4(m); edges[i] = v.x; edges[i + 1] = v.y; edges[i + 2] = v.z; } }
  return Object.assign({}, mesh, { position: pos, normal, index, edges });
}
async function commitTransform(m) {
  const bs = selBodies();
  if (!bs.length) { resetObjMatrices(); return; }
  const moved = await withBusy(t('working'), () => transformBodies(bs, m));
  resetObjMatrices();
  if (!moved) { req(); return; }
  const map = new Map(moved.map((b) => [b.id, b]));
  commit(Object.assign({}, state, { bodies: state.bodies.map((b) => map.get(b.id) || b) }));
  attachGizmo();
}

// ---------------- pointer handling ----------------
let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, btn: e.button, t: Date.now() }; hideMenu(); });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
  const btn = down.btn; down = null;
  if (moved || gizmo.dragging) return;
  if (btn === 0) clickAt(e);
});
renderer.domElement.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
  if (SK.on) { if (SK.cur) skFinishPath(); else sketchMenu(e.clientX, e.clientY); return; }
  const p = pickAt(e.clientX, e.clientY);
  if (p) {
    const item = { b: p.b, f: S.filter === 'face' ? p.f : null };
    if (!sel.some((s) => s.b === item.b && (s.f === item.f || item.f == null))) setSel([item]);
  }
  openBodyMenu(e.clientX, e.clientY, p);
});
renderer.domElement.addEventListener('dblclick', (e) => {
  if (SK.on) { skFinishPath(); return; }
  const p = pickAt(e.clientX, e.clientY);
  if (p) { controls.target.copy(p.point); controls.update(); toast(t('pivotSet')); }
});
let hovRaf = 0, lastMove = null;
renderer.domElement.addEventListener('pointermove', (e) => {
  lastMove = e;
  if (hovRaf) return;
  hovRaf = requestAnimationFrame(() => {
    hovRaf = 0;
    if (down && down.btn !== undefined && Math.hypot(lastMove.clientX - down.x, lastMove.clientY - down.y) > 4) return;
    if (gizmo.dragging) return;
    if (SK.on) { sketchMove(lastMove); return; }
    if (tool === 'measure') { const ms = measureMove(lastMove); $('sCoord').innerHTML = ms ? 'X <b>' + fmt(ms.p.x, 3) + '</b> Y <b>' + fmt(ms.p.y, 3) + '</b> Z <b>' + fmt(ms.p.z, 3) + '</b>' : ''; if (hover) { hover = null; updateHighlights(); } return; }
    const p = pickAt(lastMove.clientX, lastMove.clientY);
    $('sCoord').innerHTML = p ? 'X <b>' + fmt(p.point.x, 3) + '</b> Y <b>' + fmt(p.point.y, 3) + '</b> Z <b>' + fmt(p.point.z, 3) + '</b>' : '';
    const h = p ? { b: p.b, f: p.f } : null;
    if ((h && hover && h.b === hover.b && h.f === hover.f) || (!h && !hover)) return;
    hover = h;
    updateHighlights();
  });
});
renderer.domElement.addEventListener('pointerleave', () => { if (hover) { hover = null; updateHighlights(); } $('sCoord').textContent = ''; });

function clickAt(e) {
  if (SK.on) { sketchClick(e); return; }
  if (tool === 'measure') { measureClick(e); return; }
  const p = pickAt(e.clientX, e.clientY);
  const add = e.ctrlKey || e.metaKey || e.shiftKey;
  if (tool === 'pick' || (tool === 'paint' && e.altKey)) {
    if (!p) return;
    const b = bodyById(p.b);
    setCur(lookOf(b, S.filter === 'face' ? p.f : null));
    toast(t('picked', cur.color.toUpperCase()));
    if (tool === 'pick' && S.autoPaint) setTool('paint');
    return;
  }
  if (tool === 'paint') {
    if (!p) return;
    const scope = e.shiftKey ? 'group' : S.filter === 'face' ? 'face' : 'body';
    paint([{ b: p.b, f: p.f }], cur, scope);
    return;
  }
  // select / move / rotate
  if (!p) { if (!add) setSel([]); return; }
  toggleSel({ b: p.b, f: S.filter === 'face' ? p.f : null }, add);
}

// ---------------- context menu ----------------
const menu = document.createElement('div'); menu.className = 'ctxmenu'; menu.hidden = true; document.body.appendChild(menu);
function hideMenu() { menu.hidden = true; }
function showMenu(x, y, html, handlers) {
  menu.innerHTML = html; menu.hidden = false;
  menu.querySelectorAll('button[data-a]').forEach((b) => b.addEventListener('click', () => { hideMenu(); handlers[b.dataset.a](); }));
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  const f = menu.querySelector('button:not(:disabled)'); if (f) f.focus();
}
document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) hideMenu(); });
const mi = (a, ic, label, key, opts) => '<button data-a="' + a + '"' + (opts && opts.dis ? ' disabled' : '') + (opts && opts.bad ? ' class="bad"' : '') + '>' + IC.svg(ic) + '<span>' + esc(label) + '</span>' + (key ? '<kbd>' + key + '</kbd>' : '') + '</button>';
function openBodyMenu(x, y, p) {
  const bs = selBodies();
  if (!bs.length) {
    showMenu(x, y, mi('fit', 'fit', t('fit'), 'F') + mi('showAll', 'eye', t('showAll'), 'Shift+H') + mi('open', 'folder', t('open'), 'Ctrl+O'), {
      fit: () => fitView(), showAll, open: openDialog,
    });
    return;
  }
  const one = bs.length === 1 ? bs[0] : null;
  const title = one ? one.name + (sel[0].f != null ? ' · ' + t('face') + ' ' + (sel[0].f + 1) : '') : t('nSelected', bs.length);
  let h = '<div class="ttl">' + esc(title) + '</div>';
  h += mi('copyLook', 'copy', t('copyLook'), 'Ctrl+Shift+C') + mi('pasteLook', 'paste', t('pasteLook'), 'Ctrl+Shift+V', { dis: !clip });
  h += mi('pickLook', 'pipette', t('takeAsCurrent'), '') + mi('applyCur', 'brush', t('applyCurrent'), '');
  h += mi('replace', 'replace', t('replaceEverywhere'), '');
  const fsel = sel.find((x) => x.f != null);
  if (fsel) h += '<hr>' + mi('skFace', 'sketch', t('skOnFace'), 'K') + mi('pullF', 'pull', t('opPull') + '…', '');
  if (bs.some((b) => Object.keys(b.faceColors || {}).length)) h += mi('resetFaces', 'reset', t('resetFaces'), '');
  h += '<hr>' + mi('rename', 'edit', t('rename'), 'F2', { dis: !one }) + mi('dup', 'dup', t('duplicate'), 'Ctrl+D') + mi('isolate', 'isolate', t('isolate'), '') + mi('hide', 'eyeOff', t('hide'), 'H') + mi('zoom', 'fit', t('zoomTo'), '');
  h += '<hr>' + mi('del', 'trash', t('delete'), 'Del', { bad: true });
  showMenu(x, y, h, {
    copyLook, pasteLook,
    pickLook: () => { setCur(lookOf(bs[0], sel[0].f)); },
    applyCur: () => paint(sel, cur, sel.some((s) => s.f != null) ? 'face' : 'body'),
    replace: () => replaceColour(lookOf(bs[0], sel[0].f).color, cur),
    resetFaces: () => commit(withBodies(bs.map((b) => b.id), (b) => { b.faceColors = {}; return b; })),
    skFace: () => startSketch('face'), pullF: () => focusOp('pull'),
    rename: () => startRename(one.id), dup: duplicate, isolate, hide: hideSel, zoom: () => fitView(null, true), del: deleteSel,
  });
}

// ---------------- model tree ----------------
let renaming = null;
function renderTree() {
  const tree = $('tree');
  if (!state.bodies.length && !state.groups.length) {
    tree.innerHTML = '<div class="empty"><span>' + esc(t('treeEmpty')) + '</span></div>';
    $('treeCnt').textContent = '';
    return;
  }
  const selIds = new Set(sel.map((s) => s.b));
  let h = '';
  state.groups.forEach((g) => {
    const bs = state.bodies.filter((b) => b.group === g.id);
    if (!bs.length) return;
    const allSel = bs.every((b) => selIds.has(b.id));
    h += '<div class="grp' + (g.open ? '' : ' closed') + (allSel ? ' on' : '') + '" data-g="' + g.id + '"><span class="tw">' + IC.svg('chevron') + '</span>' +
      (renaming === 'g' + g.id ? '<input class="ren" value="' + esc(g.name) + '">' : '<span class="nm" title="' + esc(g.name) + '">' + esc(g.name) + '</span>') +
      '<button class="eye" data-ge="' + g.id + '" title="' + esc(t(g.visible ? 'hide' : 'show')) + '">' + IC.svg(g.visible ? 'eye' : 'eyeOff') + '</button></div>';
    if (!g.open) return;
    bs.forEach((b) => {
      const multi = Object.keys(b.faceColors || {}).length > 0;
      h += '<div class="row' + (selIds.has(b.id) ? ' on' : '') + (b.visible ? '' : ' off') + '" data-b="' + b.id + '">' +
        '<i class="sw' + (multi ? ' multi' : '') + '" style="background-color:' + esc(bodyColor(b)) + '"></i>' +
        (renaming === b.id ? '<input class="ren" value="' + esc(b.name) + '">' : '<span class="nm" title="' + esc(b.name) + '">' + esc(b.name) + '</span>') +
        '<span class="kind">' + (b.kind === 'brep' ? 'B-rep' : b.kind === 'points' ? 'pts' : 'mesh') + '</span>' +
        '<button class="eye" data-be="' + b.id + '" title="' + esc(t(b.visible ? 'hide' : 'show')) + '">' + IC.svg(b.visible ? 'eye' : 'eyeOff') + '</button></div>';
    });
  });
  tree.innerHTML = h;
  $('treeCnt').textContent = state.bodies.length ? String(state.bodies.length) : '';
  const ren = tree.querySelector('.ren');
  if (ren) {
    ren.focus(); ren.select();
    const done = (ok) => {
      if (renaming == null) return;
      const v = ren.value.trim(), key = renaming; renaming = null;
      if (ok && v) {
        if (typeof key === 'string') { const gid = Number(key.slice(1)); commit(Object.assign({}, state, { groups: state.groups.map((g) => (g.id === gid ? Object.assign({}, g, { name: v }) : g)) })); }
        else commit(withBodies([key], (b) => { b.name = v; return b; }));
      } else renderTree();
    };
    ren.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    ren.addEventListener('blur', () => done(true));
  }
}
$('tree').addEventListener('click', (e) => {
  const be = e.target.closest('[data-be]'), ge = e.target.closest('[data-ge]');
  if (be) { const id = Number(be.dataset.be); commit(withBodies([id], (b) => { b.visible = !b.visible; return b; })); return; }
  if (ge) { const id = Number(ge.dataset.ge); commit(Object.assign({}, state, { groups: state.groups.map((g) => (g.id === id ? Object.assign({}, g, { visible: !g.visible }) : g)) })); return; }
  if (e.target.closest('.ren')) return;
  const row = e.target.closest('[data-b]'), grp = e.target.closest('[data-g]');
  if (row) {
    const id = Number(row.dataset.b);
    if (tool === 'paint') { paint([{ b: id, f: null }], cur, e.shiftKey ? 'group' : 'body'); return; }
    if (tool === 'pick') { setCur(lookOf(bodyById(id), null)); if (S.autoPaint) setTool('paint'); return; }
    toggleSel({ b: id, f: null }, e.ctrlKey || e.metaKey || e.shiftKey);
    return;
  }
  if (grp) {
    const id = Number(grp.dataset.g);
    if (e.target.closest('.tw')) { state = Object.assign({}, state, { groups: state.groups.map((g) => (g.id === id ? Object.assign({}, g, { open: !g.open }) : g)) }); renderTree(); return; }
    const ids = state.bodies.filter((b) => b.group === id).map((b) => ({ b: b.id, f: null }));
    if (tool === 'paint') { paint(ids, cur, 'body'); return; }
    setSel(e.ctrlKey || e.metaKey ? sel.concat(ids) : ids);
  }
});
$('tree').addEventListener('dblclick', (e) => {
  const row = e.target.closest('[data-b]'), grp = e.target.closest('[data-g]');
  if (row) startRename(Number(row.dataset.b));
  else if (grp && !e.target.closest('.tw')) { renaming = 'g' + grp.dataset.g; renderTree(); }
});
$('tree').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('[data-b]');
  const grp = e.target.closest('[data-g]');
  if (!row && !grp) return;
  e.preventDefault();
  if (row) { const id = Number(row.dataset.b); if (!sel.some((s) => s.b === id)) setSel([{ b: id, f: null }]); openBodyMenu(e.clientX, e.clientY); return; }
  const gid = Number(grp.dataset.g), g = groupById(gid);
  showMenu(e.clientX, e.clientY, '<div class="ttl">' + esc(g.name) + '</div>' + mi('selAll', 'cursor', t('selectAll'), '') + mi('paintG', 'brush', t('applyCurrent'), '') + mi('ren', 'edit', t('rename'), '') + mi('zoom', 'fit', t('zoomTo'), '') + '<hr>' + mi('del', 'trash', t('delete'), '', { bad: true }), {
    selAll: () => setSel(state.bodies.filter((b) => b.group === gid).map((b) => ({ b: b.id, f: null }))),
    paintG: () => paint(state.bodies.filter((b) => b.group === gid).map((b) => ({ b: b.id, f: null })), cur, 'body'),
    ren: () => { renaming = 'g' + gid; renderTree(); },
    zoom: () => { setSel(state.bodies.filter((b) => b.group === gid).map((b) => ({ b: b.id, f: null }))); fitView(null, true); },
    del: () => { commit(Object.assign({}, state, { bodies: state.bodies.filter((b) => b.group !== gid), groups: state.groups.filter((x) => x.id !== gid) })); setSel([]); },
  });
});
function startRename(id) { renaming = id; renderTree(); }

// ---------------- properties card ----------------
let propsSeq = 0;
function meshStats(mesh, start, count) {
  const p = mesh.position, ix = mesh.index;
  let area = 0, vol = 0;
  const s = start || 0, n = count == null ? (ix ? ix.length : 0) : count;
  for (let i = s; i < s + n; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    area += Math.hypot(cx, cy, cz) / 2;
    vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return { area, vol: Math.abs(vol) };
}
function renderProps() {
  const el = $('props');
  if (tool === 'measure' && MS.a && MS.b) { el.innerHTML = measureCard(); return; }
  const bs = selBodies();
  if (!bs.length) { el.innerHTML = ''; return; }
  const box = sceneBox(true), size = box.isEmpty() ? null : box.getSize(new THREE.Vector3());
  const dims = size ? fmt(size.x) + ' × ' + fmt(size.y) + ' × ' + fmt(size.z) : '—';
  if (bs.length > 1) {
    el.innerHTML = '<span class="eyebrow">' + esc(t('selection')) + '</span><span class="ptitle">' + esc(t('nSelected', bs.length)) + '</span><dl class="kv"><dt>' + esc(t('size')) + '</dt><dd>' + dims + ' mm</dd></dl>';
    return;
  }
  const b = bs[0], s = sel.find((x) => x.b === b.id);
  const g = groupById(b.group);
  const tris = b.mesh.index ? b.mesh.index.length / 3 : 0;
  let h = '<span class="eyebrow">' + esc(s.f != null ? t('face') + ' ' + (s.f + 1) : t('body')) + '</span><span class="ptitle">' + esc(b.name) + '</span><dl class="kv">';
  h += '<dt>' + esc(t('component')) + '</dt><dd>' + esc(g ? g.name : '—') + '</dd>';
  h += '<dt>' + esc(t('type')) + '</dt><dd>' + esc(b.kind === 'brep' ? t('typeBrep') : b.kind === 'points' ? t('typePoints') : t('typeMesh')) + '</dd>';
  h += '<dt>' + esc(t('size')) + '</dt><dd>' + dims + ' mm</dd>';
  if (s.f != null && b.mesh.groups && b.mesh.groups[s.f]) {
    const gr = b.mesh.groups[s.f];
    h += '<dt>' + esc(t('area')) + '</dt><dd>' + fmt(meshStats(b.mesh, gr[0], gr[1]).area, 3) + ' mm²</dd>';
    h += '<dt>' + esc(t('colour')) + '</dt><dd>' + esc((b.faceColors[s.f] || bodyColor(b)).toUpperCase()) + '</dd>';
  } else {
    h += '<dt>' + esc(t('faces')) + '</dt><dd>' + (b.mesh.groups ? b.mesh.groups.length : '—') + '</dd>';
    h += '<dt>' + esc(t('triangles')) + '</dt><dd>' + tris.toLocaleString() + '</dd>';
    h += '<dt>' + esc(t('colour')) + '</dt><dd>' + esc(bodyColor(b).toUpperCase()) + (Object.keys(b.faceColors).length ? ' + ' + Object.keys(b.faceColors).length + ' ' + esc(t('facesShort')) : '') + '</dd>';
    h += '<dt>' + esc(t('volume')) + '</dt><dd id="pVol">…</dd><dt>' + esc(t('area')) + '</dt><dd id="pArea">…</dd>';
  }
  h += '</dl>';
  if (b.kind === 'mesh') h += '<span class="note">' + esc(t('meshNote')) + '</span>';
  el.innerHTML = h;
  if (s.f == null && b.kind !== 'points') {
    const seq = ++propsSeq;
    const put = (v, a) => { if (seq !== propsSeq) return; const pv = $('pVol'), pa = $('pArea'); if (pv) pv.textContent = v == null ? '—' : fmt(v, 3) + ' mm³'; if (pa) pa.textContent = a == null ? '—' : fmt(a, 3) + ' mm²'; };
    if (b.kind === 'brep' && b.sid && K.state === 'ready') kcall('props', { sid: b.sid }).then((r) => put(r.volume, r.area), () => { const st = meshStats(b.mesh); put(st.vol, st.area); });
    else { const st = meshStats(b.mesh); put(b.kind === 'mesh' ? st.vol : null, st.area); }
  }
}

function updateStatus() {
  const tris = state.bodies.reduce((n, b) => n + (b.visible && b.mesh.index ? b.mesh.index.length / 3 : 0), 0);
  $('sCount').innerHTML = state.bodies.length ? t('statBodies', '<b>' + state.bodies.length + '</b>', '<b>' + Math.round(tris).toLocaleString() + '</b>') : '';
  const bs = selBodies();
  $('sSel').innerHTML = bs.length ? t('statSel', '<b>' + (sel.length) + '</b>') : '';
  $('bUndo').disabled = !undoStack.length; $('bRedo').disabled = !redoStack.length;
  $('welcome').hidden = state.bodies.length > 0 || SK.on;
  $('fileName').textContent = docName;
}

function changed() {
  sel = sel.filter((s) => bodyById(s.b));
  syncScene(); renderTree(); renderProps(); renderOps(); renderSceneColours(); updateStatus(); updateHighlights(); attachGizmo();
  scheduleGC();
}

// ---------------- editing commands ----------------
function deleteSel() {
  const ids = new Set(selBodies().map((b) => b.id));
  if (!ids.size) return;
  const bodies = state.bodies.filter((b) => !ids.has(b.id));
  const used = new Set(bodies.map((b) => b.group));
  sel = [];
  commit(Object.assign({}, state, { bodies, groups: state.groups.filter((g) => used.has(g.id)) }));
}
function hideSel() { const bs = selBodies(); if (!bs.length) return; commit(withBodies(bs.map((b) => b.id), (b) => { b.visible = false; return b; })); setSel([]); }
function showAll() { commit(Object.assign({}, withBodies(state.bodies.map((b) => b.id), (b) => { b.visible = true; return b; }), { groups: state.groups.map((g) => Object.assign({}, g, { visible: true })) })); }
function isolate() { const ids = new Set(selBodies().map((b) => b.id)); commit(withBodies(state.bodies.map((b) => b.id), (b) => { b.visible = ids.has(b.id); return b; })); }
function duplicate() {
  const bs = selBodies(); if (!bs.length) return;
  const copies = bs.map((b) => mkBody(Object.assign({}, b, { id: undefined, name: b.name + ' ' + t('copySuffix'), faceColors: Object.assign({}, b.faceColors) })));
  copies.forEach((c) => { c.id = newId(); });
  commit(Object.assign({}, state, { bodies: state.bodies.concat(copies) }));
  setSel(copies.map((c) => ({ b: c.id, f: null })));
  if (tool !== 'move') setTool('move');
}
function selectAll() { setSel(state.bodies.filter((b) => b.visible).map((b) => ({ b: b.id, f: null }))); }
function newScene() {
  if (state.bodies.length && !confirm(t('confirmNew'))) return;
  sel = []; docName = '';
  commit({ groups: [], bodies: [] });
  clearMeasure();
}

// ---------------- right panel: appearance ----------------
const LIB = [
  ['libPlastic', [['plBlack', '#1b1b1b', 0, 0.45], ['plDark', '#3a3d40', 0, 0.45], ['plGrey', '#8a9096', 0, 0.5], ['plWhite', '#ecebe6', 0, 0.45], ['plBeige', '#d9cfb4', 0, 0.55], ['plRed', '#b3261e', 0, 0.45], ['plBlue', '#1f5fae', 0, 0.45], ['plYellow', '#e3b22a', 0, 0.45], ['plGreen', '#2e8b3e', 0, 0.45], ['plOrange', '#e86a17', 0, 0.45]]],
  ['libMetal', [['mtTin', '#c9ccce', 1, 0.32], ['mtSilver', '#dfe1e3', 1, 0.2], ['mtGold', '#d4a537', 1, 0.25], ['mtCopper', '#c06d3e', 1, 0.3], ['mtBrass', '#c9a54a', 1, 0.32], ['mtAlu', '#b9bec3', 1, 0.42], ['mtSteel', '#8c9196', 1, 0.38], ['mtNickel', '#b4b0a6', 1, 0.3], ['mtBlack', '#2a2c2e', 1, 0.45]]],
  ['libElec', [['elMask', '#0e5e2c', 0.05, 0.38], ['elMaskBlue', '#0f3a7a', 0.05, 0.38], ['elMaskBlack', '#141414', 0.05, 0.35], ['elFR4', '#b9a46a', 0, 0.6], ['elCeramic', '#e3dccb', 0, 0.55], ['elBody', '#222222', 0, 0.5], ['elLedRed', '#ff2a1a', 0, 0.15, 0.85], ['elLedGreen', '#2bff5a', 0, 0.15, 0.85], ['elLedBlue', '#2a6bff', 0, 0.15, 0.85], ['elLedWhite', '#f5f7ff', 0, 0.1, 0.8], ['elTantalum', '#d79b24', 0, 0.45], ['elFerrite', '#3b3b3b', 0, 0.75]]],
  ['libOther', [['otRubber', '#202020', 0, 0.95], ['otGlass', '#cfe8f2', 0, 0.05, 0.3], ['otGlassTint', '#5c7f8c', 0, 0.05, 0.45], ['otWood', '#9c6b3e', 0, 0.7], ['otPaintRed', '#c0392b', 0.2, 0.3]]],
];
function libLook(it) { return { color: it[1], metal: it[2], rough: it[3], alpha: it[4] == null ? 1 : it[4] }; }
function swStyle(l) { return 'background-color:' + esc(l.color) + ';--shine:' + (0.15 + (l.metal || 0) * 0.35 + (1 - (l.rough == null ? 0.5 : l.rough)) * 0.3).toFixed(2) + (l.alpha < 1 ? ';opacity:' + Math.max(0.45, l.alpha) : ''); }
function renderLook() {
  const p = $('paneLook');
  let h = '<fieldset><legend>' + esc(t('currentLook')) + '</legend>' +
    '<div class="cur"><label class="bigsw" id="curSw"><input type="color" id="curColor"></label><div style="display:grid;gap:6px;min-width:0">' +
    '<input class="txt hexin" id="curHex" maxlength="7" spellcheck="false">' +
    '<div class="btnrow"><button class="btn sm" data-ltool="pick" data-ic="pipette"><span>' + esc(t('toolPickShort')) + '</span></button><button class="btn sm" data-ltool="paint" data-ic="brush"><span>' + esc(t('toolPaintShort')) + '</span></button></div></div></div>' +
    '<div class="frow"><span>' + esc(t('metal')) + '</span><output id="oMetal"></output><input type="range" id="curMetal" min="0" max="1" step="0.01"></div>' +
    '<div class="frow"><span>' + esc(t('rough')) + '</span><output id="oRough"></output><input type="range" id="curRough" min="0" max="1" step="0.01"></div>' +
    '<div class="frow"><span>' + esc(t('opacity')) + '</span><output id="oAlpha"></output><input type="range" id="curAlpha" min="0.05" max="1" step="0.01"></div>' +
    '<div class="btnrow"><button class="btn primary" id="applySel" data-ic="brush"><span>' + esc(t('applyToSel')) + '</span></button><button class="btn" id="applyGrp"><span>' + esc(t('applyToComp')) + '</span></button></div>' +
    '<div class="modehint" id="lookHint"></div></fieldset>';
  h += '<fieldset><legend>' + esc(t('recent')) + '</legend><div class="palette" id="recent"></div></fieldset>';
  h += '<fieldset><legend>' + esc(t('sceneColours')) + '</legend><div class="lib" id="sceneCols"></div></fieldset>';
  LIB.forEach((cat) => {
    h += '<fieldset><legend>' + esc(t(cat[0])) + '</legend><div class="palette">';
    cat[1].forEach((it, i) => { h += '<button class="chipc" data-lib="' + cat[0] + ':' + i + '" title="' + esc(t(it[0])) + '" style="' + swStyle(libLook(it)) + '"></button>'; });
    h += '</div></fieldset>';
  });
  p.innerHTML = h;
  applyStatic(p);
  const curColor = $('curColor'), curHex = $('curHex');
  curColor.addEventListener('input', () => { cur.color = curColor.value; renderLookTop(true); });
  curColor.addEventListener('change', () => setCur(cur));
  curHex.addEventListener('change', () => { let v = curHex.value.trim(); if (!v.startsWith('#')) v = '#' + v; if (/^#[0-9a-f]{6}$/i.test(v)) setCur(Object.assign({}, cur, { color: v.toLowerCase() })); else renderLookTop(); });
  [['curMetal', 'metal'], ['curRough', 'rough'], ['curAlpha', 'alpha']].forEach(([id, k]) => {
    $(id).addEventListener('input', () => { cur[k] = Number($(id).value); renderLookTop(true); });
    $(id).addEventListener('change', () => setCur(cur, true));
  });
  p.querySelectorAll('[data-ltool]').forEach((b) => b.addEventListener('click', () => setTool(tool === b.dataset.ltool ? 'select' : b.dataset.ltool)));
  $('applySel').addEventListener('click', () => { if (!sel.length) { toast(t('selectFirst'), 'warn'); return; } paint(sel, cur, sel.some((s) => s.f != null) ? 'face' : 'body'); });
  $('applyGrp').addEventListener('click', () => { if (!sel.length) { toast(t('selectFirst'), 'warn'); return; } paint(sel, cur, 'group'); });
  p.querySelectorAll('[data-lib]').forEach((b) => b.addEventListener('click', () => {
    const [c, i] = b.dataset.lib.split(':');
    const it = LIB.find((x) => x[0] === c)[1][Number(i)];
    setCur(libLook(it));
    if (sel.length && tool !== 'paint') toast(t('libHint'));
  }));
  renderLookTop(); renderRecent(); renderSceneColours();
  document.querySelectorAll('[data-ltool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ltool === tool)));
}
function renderLookTop(live) {
  if (!$('curSw')) return;
  $('curSw').setAttribute('style', swStyle(cur));
  if (!live || document.activeElement !== $('curColor')) $('curColor').value = cur.color;
  if (document.activeElement !== $('curHex')) $('curHex').value = cur.color.toUpperCase();
  $('curMetal').value = cur.metal; $('curRough').value = cur.rough; $('curAlpha').value = cur.alpha;
  $('oMetal').textContent = Math.round(cur.metal * 100) + '%'; $('oRough').textContent = Math.round(cur.rough * 100) + '%'; $('oAlpha').textContent = Math.round(cur.alpha * 100) + '%';
  $('lookHint').innerHTML = t('lookHint');
}
function renderRecent() {
  const el = $('recent'); if (!el) return;
  const r = S.recent || [];
  el.innerHTML = r.length ? r.map((l, i) => '<button class="chipc" data-rc="' + i + '" title="' + esc(l.color.toUpperCase()) + '" style="' + swStyle(l) + '"></button>').join('') : '<span class="note">' + esc(t('recentEmpty')) + '</span>';
  el.querySelectorAll('[data-rc]').forEach((b) => b.addEventListener('click', () => setCur(r[Number(b.dataset.rc)], true)));
}
function renderSceneColours() {
  const el = $('sceneCols'); if (!el) return;
  const cnt = new Map();
  state.bodies.forEach((b) => {
    const k = bodyColor(b).toLowerCase(); cnt.set(k, (cnt.get(k) || 0) + 1);
    Object.values(b.faceColors || {}).forEach((c) => { const kk = c.toLowerCase(); cnt.set(kk, (cnt.get(kk) || 0) + 1); });
  });
  if (!cnt.size) { el.innerHTML = '<span class="note">' + esc(t('noModel')) + '</span>'; return; }
  const list = Array.from(cnt.entries()).sort((a, b) => b[1] - a[1]).slice(0, 24);
  el.innerHTML = list.map(([c, n]) => '<div class="libi"><i class="sw" style="background-color:' + esc(c) + '"></i><span style="flex:1;font-family:var(--f-mono);font-size:12px">' + esc(c.toUpperCase()) + ' <span class="note">×' + n + '</span></span>' +
    '<button class="btn sm" data-take="' + esc(c) + '" title="' + esc(t('takeAsCurrent')) + '">' + IC.svg('pipette') + '</button><button class="btn sm" data-rep="' + esc(c) + '" title="' + esc(t('replaceWithCurrent')) + '">' + IC.svg('replace') + '</button></div>').join('');
  el.querySelectorAll('[data-take]').forEach((b) => b.addEventListener('click', () => {
    const c = b.dataset.take, src = state.bodies.find((x) => bodyColor(x).toLowerCase() === c);
    setCur(src ? lookOf(src) : Object.assign({}, cur, { color: c }));
  }));
  el.querySelectorAll('[data-rep]').forEach((b) => b.addEventListener('click', () => replaceColour(b.dataset.rep, cur)));
}

// ---------------- right panel: create ----------------
const PRIMS = [
  ['box', 'box', [['w', 10], ['d', 10], ['h', 10]]],
  ['rbox', 'plate', [['w', 10], ['d', 6], ['h', 2], ['r', 0.5]]],
  ['cyl', 'cyl', [['r', 5], ['h', 10]]],
  ['tube', 'tube', [['r', 5], ['ri', 3], ['h', 10]]],
  ['sphere', 'sphere', [['r', 5]]],
  ['cone', 'cone', [['r1', 5], ['r2', 0], ['h', 10]]],
  ['torus', 'torus', [['R', 10], ['r', 2]]],
  ['prism', 'prism', [['r', 5], ['n', 6], ['h', 10]]],
];
let primSel = 'box';
const primVals = {};
function renderCreate() {
  const p = $('paneCreate');
  const faceSel = sel.some((x) => x.f != null);
  let h = '<fieldset><legend>' + esc(t('skStart')) + '</legend><span class="note">' + esc(t('skStartNote')) + '</span><div class="skplanes">' +
    '<button class="btn" data-skp="xy" data-ic="sketch"><span>' + esc(t('skPlaneXY')) + '</span></button><button class="btn" data-skp="xz" data-ic="sketch"><span>' + esc(t('skPlaneXZ')) + '</span></button>' +
    '<button class="btn" data-skp="yz" data-ic="sketch"><span>' + esc(t('skPlaneYZ')) + '</span></button><button class="btn' + (faceSel ? ' primary' : '') + '" data-skp="face" data-ic="target"' + (faceSel ? '' : ' disabled') + '><span>' + esc(t('skOnFaceShort')) + '</span></button></div>' +
    '<div class="frow"><span>' + esc(t('skOffset')) + '</span><input class="num" type="number" step="any" id="skOffset" value="' + (SK.offset || 0) + '"></div></fieldset>';
  h += '<fieldset><legend>' + esc(t('primitives')) + '</legend><div class="prims">' + PRIMS.map((x) => '<button class="prim" data-prim="' + x[0] + '" aria-pressed="' + (x[0] === primSel) + '">' + IC.svg(x[1]) + '<span>' + esc(t('prim_' + x[0])) + '</span></button>').join('') + '</div></fieldset>';
  const pr = PRIMS.find((x) => x[0] === primSel);
  const vals = primVals[primSel] || (primVals[primSel] = Object.fromEntries(pr[2]));
  h += '<fieldset><legend>' + esc(t('params')) + ' — ' + esc(t('prim_' + primSel)) + '</legend><div class="grid3">' +
    pr[2].map(([k]) => '<label>' + esc(t('p_' + k)) + '<input class="num" type="number" step="any" data-pk="' + k + '" value="' + vals[k] + '"></label>').join('') + '</div>' +
    '<span class="eyebrow">' + esc(t('position')) + '</span><div class="grid3">' + ['x', 'y', 'z'].map((a) => '<label>' + a.toUpperCase() + '<input class="num" type="number" step="any" data-pos="' + a + '" value="' + (vals['@' + a] || 0) + '"></label>').join('') + '</div>' +
    '<label class="frow chk"><input type="checkbox" id="primCur"' + (S.primCur !== false ? ' checked' : '') + '><span>' + esc(t('useCurrentLook')) + '</span></label>' +
    '<button class="btn primary" id="primGo" data-ic="box"><span>' + esc(t('create')) + '</span></button>' +
    '<span class="note">' + esc(t('primNote_' + primSel)) + '</span></fieldset>';
  h += '<fieldset><legend>' + esc(t('tips')) + '</legend><span class="note">' + t('createTips') + '</span></fieldset>';
  p.innerHTML = h;
  applyStatic(p);
  p.querySelectorAll('[data-prim]').forEach((b) => b.addEventListener('click', () => { primSel = b.dataset.prim; renderCreate(); }));
  p.querySelectorAll('[data-skp]').forEach((b) => b.addEventListener('click', () => startSketch(b.dataset.skp)));
  $('skOffset').addEventListener('change', () => { SK.offset = Number($('skOffset').value) || 0; });
  p.querySelectorAll('[data-pk]').forEach((i) => i.addEventListener('change', () => { vals[i.dataset.pk] = Number(i.value); }));
  p.querySelectorAll('[data-pos]').forEach((i) => i.addEventListener('change', () => { vals['@' + i.dataset.pos] = Number(i.value); }));
  $('primCur').addEventListener('change', () => { S.primCur = $('primCur').checked; saveS(); });
  $('primGo').addEventListener('click', () => {
    p.querySelectorAll('[data-pk]').forEach((i) => { vals[i.dataset.pk] = Number(i.value); });
    p.querySelectorAll('[data-pos]').forEach((i) => { vals['@' + i.dataset.pos] = Number(i.value); });
    createPrim(primSel, vals);
  });
}
async function createPrim(type, vals) {
  const r = await withBusy(t('creating'), () => kcall('primitive', { type, p: vals, at: [vals['@x'] || 0, vals['@y'] || 0, vals['@z'] || 0], quality: S.quality }));
  if (!r) return;
  const mg = modelGroup();
  const n = state.bodies.filter((b) => b.name.startsWith(t('prim_' + type))).length + 1;
  const look = S.primCur !== false ? cur : { color: S.newColor, metal: 0.15, rough: 0.5, alpha: 1 };
  const b = mkBody({ name: t('prim_' + type) + ' ' + n, group: mg.gid, kind: 'brep', sid: track(r.sid), mesh: r.mesh, color: look.color, metal: look.metal, rough: look.rough, alpha: look.alpha });
  const first = !state.bodies.length;
  commit(Object.assign({}, mg.st, { bodies: mg.st.bodies.concat([b]) }));
  setSel([{ b: b.id, f: null }]);
  if (first) fitView(new THREE.Vector3().fromArray(VIEWS.iso)); else req();
}

// ---------------- right panel: operations ----------------
const opv = { dx: 0, dy: 0, dz: 0, ax: 'z', ang: 90, copy: false, n: 3, px: 5, py: 0, pz: 0, mplane: 'yz', mcenter: 'origin', mcopy: true, k: 1, fr: 0.5, fmode: 'all', keepTools: false,
  pull: 2, cn: 6, cang: 360, cax: 'z', ccenter: 'origin', cfuse: false, pfuse: false };
function renderOps() {
  const p = $('paneOps'); if (!p || p.hidden) return;
  const bs = selBodies(), n = bs.length;
  const faceSel = sel.filter((s) => s.f != null);
  const hasMesh = bs.some((b) => b.kind === 'mesh');
  const num = (k, lab, step) => '<label>' + esc(lab) + '<input class="num" type="number" step="' + (step || 'any') + '" data-ov="' + k + '" value="' + opv[k] + '"></label>';
  const chk = (k, lab) => '<label class="frow chk"><input type="checkbox" data-ovc="' + k + '"' + (opv[k] ? ' checked' : '') + '><span>' + esc(lab) + '</span></label>';
  const btn = (op, ic, lab, ok, cls) => '<button class="btn' + (cls ? ' ' + cls : '') + '" data-op="' + op + '"' + (ok ? '' : ' disabled') + (ic ? ' data-ic="' + ic + '"' : '') + '><span>' + esc(lab) + '</span></button>';
  const sec = (id, title, body) => '<fieldset id="op-' + id + '"><legend>' + esc(title) + '</legend>' + body + '</fieldset>';
  let h = '';
  h += '<div class="modehint">' + (n ? esc(t('nSelected', n)) + (faceSel.length ? ' · ' + esc(t('nFaces', faceSel.length)) : '') : esc(t('opsSelect'))) + '</div>';
  h += sec('pull', t('opPull'), '<span class="note">' + esc(t('pullNote')) + '</span><div class="grid2">' + num('pull', t('distMm')) + '<span></span></div>' +
    '<div class="btnrow">' + btn('pull', 'pull', t('doPull'), faceSel.length > 0, 'primary') + '</div>');
  h += sec('move', t('opMove'), '<div class="grid3">' + num('dx', 'ΔX') + num('dy', 'ΔY') + num('dz', 'ΔZ') + '</div>' +
    '<div class="btnrow">' + btn('move', 'move', t('doMove'), n) + '</div>' +
    '<div class="grid2"><label>' + esc(t('axis')) + '<select class="sel" data-ov="ax"><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select></label>' + num('ang', t('angleDeg')) + '</div>' +
    '<div class="btnrow">' + btn('rot', 'rotate', t('doRotate'), n) + '</div>' + chk('copy', t('asCopy')) +
    '<div class="btnrow"><button class="btn sm" data-op="floor"' + (n ? '' : ' disabled') + '>' + esc(t('toFloor')) + '</button><button class="btn sm" data-op="center"' + (n ? '' : ' disabled') + '>' + esc(t('toCenter')) + '</button></div>');
  h += sec('pattern', t('opPattern'), '<div class="grid2">' + num('n', t('count'), 1) + '<span></span></div><div class="grid3">' + num('px', t('stepX')) + num('py', t('stepY')) + num('pz', t('stepZ')) + '</div>' + chk('pfuse', t('fuseResult')) +
    '<div class="btnrow">' + btn('pattern', 'pattern', t('makePattern'), n) + '</div>');
  h += sec('cpattern', t('opCPattern'), '<div class="grid2">' + num('cn', t('count'), 1) + num('cang', t('totalAngle')) +
    '<label>' + esc(t('axis')) + '<select class="sel" data-ov="cax"><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select></label>' +
    '<label>' + esc(t('through')) + '<select class="sel" data-ov="ccenter"><option value="origin">' + esc(t('thOrigin')) + '</option><option value="center">' + esc(t('thCenter')) + '</option></select></label></div>' + chk('cfuse', t('fuseResult')) +
    '<div class="btnrow">' + btn('cpattern', 'cpattern', t('makePattern'), n) + '</div><span class="note">' + esc(t('cpatNote')) + '</span>');
  h += sec('mirror', t('opMirror'), '<div class="grid2"><label>' + esc(t('plane')) + '<select class="sel" data-ov="mplane"><option value="yz">YZ (X→−X)</option><option value="xz">XZ (Y→−Y)</option><option value="xy">XY (Z→−Z)</option><option value="face">' + esc(t('mFace')) + '</option></select></label>' +
    '<label>' + esc(t('through')) + '<select class="sel" data-ov="mcenter"><option value="origin">' + esc(t('thOrigin')) + '</option><option value="center">' + esc(t('thCenter')) + '</option></select></label></div>' + chk('mcopy', t('asCopy')) +
    '<div class="btnrow">' + btn('mirror', 'mirror', t('doMirror'), n) + '</div><span class="note">' + esc(t('mirrorNote')) + '</span>');
  h += sec('bool', t('opBool'), '<div class="btnrow">' + btn('fuse', 'union', t('fuse'), n >= 2) + btn('cut', 'subtract', t('cut'), n >= 2) + btn('common', 'intersect', t('common'), n >= 2) + '</div>' + chk('keepTools', t('keepTools')) + '<span class="note">' + esc(t('boolNote')) + '</span>');
  h += sec('edges', t('opEdges'), '<div class="grid2">' + num('fr', t('sizeMm')) +
    '<label>' + esc(t('edges')) + '<select class="sel" data-ov="fmode"><option value="all">' + esc(t('eAll')) + '</option><option value="faces">' + esc(t('eFaces')) + '</option><option value="vertical">' + esc(t('eVert')) + '</option><option value="horizontal">' + esc(t('eHor')) + '</option></select></label></div>' +
    '<div class="btnrow">' + btn('fillet', 'fillet', t('fillet'), n === 1) + btn('chamfer', 'chamfer', t('chamfer'), n === 1) + '</div><span class="note">' + esc(t('edgeNote')) + '</span>');
  h += sec('scale', t('opScale'), '<div class="grid2">' + num('k', t('factor')) + '<span></span></div><div class="btnrow"><button class="btn sm" data-sk="25.4">inch → mm</button><button class="btn sm" data-sk="1000">m → mm</button><button class="btn sm" data-sk="10">cm → mm</button></div>' +
    '<div class="btnrow">' + btn('scale', 'scale', t('doScale'), n) + '</div>');
  h += sec('more', t('opMore'), '<div class="btnrow">' + btn('tobrep', '', t('meshToBrep'), hasMesh) + btn('dup', 'dup', t('duplicate'), n) + btn('del', 'trash', t('delete'), n, 'danger') + '</div>');
  const top = p.scrollTop;
  p.innerHTML = h;
  applyStatic(p);
  p.scrollTop = top;
  p.querySelectorAll('[data-ov]').forEach((i) => {
    if (i.tagName === 'SELECT') i.value = opv[i.dataset.ov];
    i.addEventListener('change', () => { opv[i.dataset.ov] = i.tagName === 'SELECT' ? i.value : Number(i.value); });
  });
  p.querySelectorAll('[data-ovc]').forEach((i) => i.addEventListener('change', () => { opv[i.dataset.ovc] = i.checked; }));
  p.querySelectorAll('[data-sk]').forEach((b) => b.addEventListener('click', () => { opv.k = Number(b.dataset.sk); p.querySelector('[data-ov=k]').value = opv.k; }));
  p.querySelectorAll('[data-op]').forEach((b) => b.addEventListener('click', () => runOp(b.dataset.op)));
}
function replaceBodies(old, neu, extra) {
  const map = new Map(neu.filter((b) => old.has(b.id)).map((b) => [b.id, b]));
  let bodies = state.bodies.map((b) => map.get(b.id) || b);
  bodies = bodies.concat((extra || []));
  return Object.assign({}, state, { bodies });
}
async function runOp(op) {
  const bs = selBodies();
  if (!bs.length && op !== 'none') { toast(t('selectFirst'), 'warn'); return; }
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const box = sceneBox(true), ctr = box.getCenter(new THREE.Vector3());
  const copyOf = (list) => list.map((b) => Object.assign({}, b, { id: newId(), name: b.name + ' ' + t('copySuffix') }));
  const applyM = async (m, copy) => {
    const moved = await withBusy(t('working'), () => transformBodies(bs, m));
    if (!moved) return;
    if (copy) { const c = copyOf(moved); commit(Object.assign({}, state, { bodies: state.bodies.concat(c) })); setSel(c.map((b) => ({ b: b.id, f: null }))); }
    else commit(replaceBodies(new Set(bs.map((b) => b.id)), moved));
  };
  switch (op) {
    case 'move': await applyM(new THREE.Matrix4().makeTranslation(opv.dx || 0, opv.dy || 0, opv.dz || 0), opv.copy); break;
    case 'rot': {
      const ax = { x: V(1, 0, 0), y: V(0, 1, 0), z: V(0, 0, 1) }[opv.ax];
      const m = new THREE.Matrix4().makeTranslation(ctr.x, ctr.y, ctr.z).multiply(new THREE.Matrix4().makeRotationAxis(ax, THREE.MathUtils.degToRad(opv.ang || 0))).multiply(new THREE.Matrix4().makeTranslation(-ctr.x, -ctr.y, -ctr.z));
      await applyM(m, opv.copy); break;
    }
    case 'floor': await applyM(new THREE.Matrix4().makeTranslation(0, 0, -box.min.z), false); break;
    case 'center': await applyM(new THREE.Matrix4().makeTranslation(-ctr.x, -ctr.y, 0), false); break;
    case 'scale': {
      const k = Number(opv.k); if (!(k > 0) || k === 1) return;
      await applyM(new THREE.Matrix4().makeScale(k, k, k), false); fitView(); break;
    }
    case 'pull': {
      const faces = sel.filter((x) => x.f != null);
      if (!faces.length) { toast(t('pickFacesFirst'), 'warn'); return; }
      const byB = new Map(); faces.forEach((x) => { if (!byB.has(x.b)) byB.set(x.b, []); byB.get(x.b).push(x.f); });
      const out = await withBusy(t('working'), async () => {
        const list = [];
        for (const [id, fl] of byB) {
          const b = bodyById(id);
          if (b.kind !== 'brep' || !b.sid) throw new Error(t('skFaceBrep'));
          // one face at a time: indices change after each operation, so only the first face per body
          const r = await kcall('faceExtrude', { sid: b.sid, face: fl[0], dist: Number(opv.pull) || 1, quality: S.quality });
          list.push(Object.assign({}, b, { sid: track(r.sid), mesh: r.mesh, faceColors: {} }));
        }
        return list;
      });
      if (!out) return;
      commit(replaceBodies(new Set(out.map((b) => b.id)), out));
      setSel(out.map((b) => ({ b: b.id, f: null })));
      break;
    }
    case 'cpattern': {
      const N = Math.max(2, Math.min(360, Math.round(opv.cn || 2)));
      const total = Number(opv.cang) || 360;
      const step = Math.abs(total) >= 360 ? total / N : total / (N - 1);
      const ax = { x: V(1, 0, 0), y: V(0, 1, 0), z: V(0, 0, 1) }[opv.cax];
      const c0 = opv.ccenter === 'center' ? ctr : V(0, 0, 0);
      const out = [];
      const res = await withBusy(t('working'), async () => {
        for (let i = 1; i < N; i++) {
          const m = new THREE.Matrix4().makeTranslation(c0.x, c0.y, c0.z).multiply(new THREE.Matrix4().makeRotationAxis(ax, THREE.MathUtils.degToRad(step * i))).multiply(new THREE.Matrix4().makeTranslation(-c0.x, -c0.y, -c0.z));
          const moved = await transformBodies(bs, m);
          moved.forEach((b) => out.push(Object.assign({}, b, { id: newId(), name: b.name + ' [' + (i + 1) + ']' })));
        }
        return true;
      });
      if (res) await addPattern(bs, out, opv.cfuse);
      break;
    }
    case 'pattern': {
      const N = Math.max(2, Math.min(500, Math.round(opv.n || 2)));
      const out = [];
      const res = await withBusy(t('working'), async () => {
        for (let i = 1; i < N; i++) {
          const moved = await transformBodies(bs, new THREE.Matrix4().makeTranslation((opv.px || 0) * i, (opv.py || 0) * i, (opv.pz || 0) * i));
          moved.forEach((b) => out.push(Object.assign({}, b, { id: newId(), name: b.name + ' [' + (i + 1) + ']' })));
        }
        return true;
      });
      if (res) await addPattern(bs, out, opv.pfuse);
      break;
    }
    case 'mirror': {
      let n = { yz: [1, 0, 0], xz: [0, 1, 0], xy: [0, 0, 1] }[opv.mplane];
      let pnt = opv.mcenter === 'center' ? [ctr.x, ctr.y, ctr.z] : [0, 0, 0];
      if (opv.mplane === 'face') {
        const fs = sel.find((x) => x.f != null);
        const fb = fs && bodyById(fs.b);
        if (!fb || fb.kind !== 'brep') { toast(t('mirrorPickFace'), 'warn'); return; }
        const fp = await withBusy(t('working'), () => kcall('facePlane', { sid: fb.sid, face: fs.f }));
        if (!fp || !fp.planar) { toast(t('skNotPlanar'), 'warn'); return; }
        n = fp.n; pnt = fp.o;
      }
      const mb = opv.mplane === 'face' && sel.some((x) => x.f == null) ? bs.filter((b) => sel.some((x) => x.b === b.id && x.f == null)) : bs;
      const moved = await withBusy(t('working'), () => transformBodies(mb, null, { mirror: { p: pnt, n } }));
      if (!moved) return;
      if (opv.mcopy) { const c = copyOf(moved).map((b) => Object.assign(b, { name: b.name.replace(' ' + t('copySuffix'), ' ' + t('mirrorSuffix')) })); commit(Object.assign({}, state, { bodies: state.bodies.concat(c) })); }
      else commit(replaceBodies(new Set(mb.map((b) => b.id)), moved));
      break;
    }
    case 'fuse': case 'cut': case 'common': {
      if (bs.length < 2) return;
      // the first body picked is the one that stays
      const order = uniqBodies(sel).map((s) => bodyById(s.b));
      const res = await withBusy(t('working'), async () => {
        const sids = [];
        for (const b of order) sids.push(await ensureBrep(b));
        return kcall('boolean', { op: op === 'common' ? 'common' : op, a: sids[0], b: sids.slice(1), quality: S.quality });
      });
      if (!res) return;
      const main = Object.assign({}, order[0], { kind: 'brep', sid: track(res.sid), mesh: res.mesh, faceColors: {} });
      const drop = opv.keepTools ? new Set() : new Set(order.slice(1).map((b) => b.id));
      commit(Object.assign({}, state, { bodies: state.bodies.filter((b) => !drop.has(b.id)).map((b) => (b.id === main.id ? main : b)) }));
      setSel([{ b: main.id, f: null }]);
      break;
    }
    case 'fillet': case 'chamfer': {
      const b = bs[0];
      const faces = sel.filter((s) => s.b === b.id && s.f != null).map((s) => s.f);
      let mode = opv.fmode;
      if (faces.length && mode === 'all') mode = 'faces';
      if (mode === 'faces' && !faces.length) { toast(t('pickFacesFirst'), 'warn'); return; }
      const res = await withBusy(t('working'), async () => {
        const sid = await ensureBrep(b);
        return kcall('edgeOp', { op, sid, size: Number(opv.fr) || 0.5, mode, faces, quality: S.quality });
      });
      if (!res) return;
      const nb = Object.assign({}, b, { kind: 'brep', sid: track(res.sid), mesh: res.mesh, faceColors: {} });
      commit(replaceBodies(new Set([b.id]), [nb]));
      setSel([{ b: nb.id, f: null }]);
      break;
    }
    case 'tobrep': {
      const list = bs.filter((b) => b.kind === 'mesh');
      const out = [];
      const ok = await withBusy(t('converting'), async () => {
        for (const b of list) { const sid = await ensureBrep(b, true); out.push(Object.assign({}, b, { kind: 'brep', sid, mesh: b._conv, faceColors: {} })); delete b._conv; }
        return true;
      });
      if (ok) { commit(replaceBodies(new Set(list.map((b) => b.id)), out.map((b) => { const c = Object.assign({}, b); delete c._conv; return c; }))); toast(t('converted', out.length)); }
      break;
    }
    case 'dup': duplicate(); break;
    case 'del': deleteSel(); break;
  }
}
// copies of a pattern: new bodies, or fused into the original body
async function addPattern(src, copies, fuse) {
  if (!fuse || src.length !== 1) { commit(Object.assign({}, state, { bodies: state.bodies.concat(copies) })); return; }
  const b = src[0];
  const r = await withBusy(t('working'), async () => {
    const a = await ensureBrep(b);
    const others = [];
    for (const c of copies) others.push(await ensureBrep(c));
    return kcall('boolean', { op: 'fuse', a, b: others, quality: S.quality });
  });
  if (!r) return;
  commit(replaceBodies(new Set([b.id]), [Object.assign({}, b, { kind: 'brep', sid: track(r.sid), mesh: r.mesh, faceColors: {} })]));
}
// mesh body -> exact body (faceted) when an operation needs OCCT
async function ensureBrep(b, keepMesh) {
  if (b.kind === 'brep' && b.sid) return b.sid;
  const tri = b.mesh.index.length / 3;
  if (tri > 200000) throw new Error(t('meshTooBig', tri.toLocaleString()));
  const r = await kcall('meshToBody', { position: b.mesh.position, index: b.mesh.index, quality: S.quality });
  track(r.sid);
  if (keepMesh) b._conv = r.mesh;
  return r.sid;
}

// ---------------- right panel: settings ----------------
function renderSettings() {
  const p = $('paneSet');
  const opt = (v, cur, label) => '<option value="' + v + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + esc(label) + '</option>';
  const chk = (k, label) => '<label class="frow chk"><input type="checkbox" data-sc="' + k + '"' + (S[k] ? ' checked' : '') + '><span>' + esc(label) + '</span></label>';
  const row = (label, ctl) => '<div class="frow"><span>' + esc(label) + '</span>' + ctl + '</div>';
  let h = '<fieldset><legend>' + esc(t('setUi')) + '</legend>' +
    row(t('language'), '<select class="sel" data-ss="lang">' + opt('ru', S.lang, 'Русский') + opt('en', S.lang, 'English') + '</select>') +
    row(t('theme'), '<select class="sel" data-ss="theme">' + opt('dark', S.theme, t('themeDark')) + opt('light', S.theme, t('themeLight')) + '</select>') +
    row(t('background'), '<select class="sel" data-ss="bg">' + opt('grad', S.bg, t('bgGrad')) + opt('flat', S.bg, t('bgFlat')) + '</select>') + '</fieldset>';
  h += '<fieldset><legend>' + esc(t('setView')) + '</legend>' + chk('edges', t('showEdges')) + chk('grid', t('showGrid')) + chk('axes', t('showAxes')) +
    row(t('quality'), '<select class="sel" data-ss="quality">' + opt('low', S.quality, t('qLow')) + opt('mid', S.quality, t('qMid')) + opt('high', S.quality, t('qHigh')) + '</select>') +
    '<span class="note">' + esc(t('qualityNote')) + '</span>' +
    row(t('newColour'), '<input type="color" data-ss="newColor" value="' + esc(S.newColor) + '" style="width:44px;height:26px;padding:0;border:1px solid var(--line);border-radius:4px;background:none">') + '</fieldset>';
  h += '<fieldset><legend>' + esc(t('setPaint')) + '</legend>' + chk('autoPaint', t('autoPaint')) + chk('clearFaces', t('clearFaces')) + '</fieldset>';
  h += '<fieldset><legend>' + esc(t('setSnap')) + '</legend>' +
    row(t('snapMove'), '<select class="sel" data-ss="snapMove">' + [0, 0.01, 0.05, 0.1, 0.5, 1, 5, 10].map((v) => opt(v, S.snapMove, v ? v + ' mm' : t('off'))).join('') + '</select>') +
    row(t('snapRot'), '<select class="sel" data-ss="snapRot">' + [0, 1, 5, 15, 45, 90].map((v) => opt(v, S.snapRot, v ? v + '°' : t('off'))).join('') + '</select>') + '</fieldset>';
  h += '<fieldset><legend>STEP</legend>' +
    row(t('stepSchema'), '<select class="sel" data-ss="schema">' + opt(4, S.schema, 'AP214') + opt(5, S.schema, 'AP242') + opt(3, S.schema, 'AP203') + '</select>') +
    row(t('stepStructure'), '<select class="sel" data-ss="structure">' + opt('part', S.structure, t('stPart')) + opt('assembly', S.structure, t('stAsm')) + '</select>') +
    '<span class="note">' + esc(t('stepNote')) + '</span></fieldset>';
  h += '<fieldset><legend>' + esc(t('hotkeys')) + '</legend><div class="keys">' + [
    ['Ctrl+O', 'open'], ['Ctrl+S', 'saveProject'], ['Ctrl+E', 'export'], ['Ctrl+Z / Ctrl+Y', 'undoRedo'], ['Q', 'toolSelect'], ['I', 'toolPick'], ['B', 'toolPaint'], ['Alt+' + t('click'), 'altPick'], ['Shift+' + t('click'), 'shiftPaint'],
    ['T / R', 'moveRotate'], ['M', 'toolMeasure'], ['G', 'filterToggle'], ['Ctrl+Shift+C / V', 'copyPaste'], ['F', 'fit'], ['Ctrl+1…7', 'views'], ['H / Shift+H', 'hideShow'], ['Ctrl+D', 'duplicate'], ['F2', 'rename'], ['Del', 'delete'], [t('dblclick'), 'pivotKey'],
  ].map(([k, l]) => '<kbd>' + esc(k) + '</kbd><span>' + esc(t(l)) + '</span>').join('') + '</div><span class="note">' + esc(t('mouseNote')) + '</span></fieldset>';
  h += '<fieldset><legend>' + esc(t('about')) + '</legend><div><b>3DViewer ' + esc(VLABEL) + '</b> <span class="note">' + esc(t('fromDate', VDATE)) + '</span></div>' +
    '<span class="note">' + esc(t('aboutText')) + '</span>' +
    '<div class="links"><a class="lk" href="' + GITHUB + '/releases" target="_blank" rel="noopener">' + IC.svg('github') + '<span><b>GitHub</b><small>Carn1son/3DViewer</small></span></a>' +
    '<a class="lk" href="' + TELEGRAM + '" target="_blank" rel="noopener">' + IC.svg('telegram') + '<span><b>Telegram</b><small>@carnison</small></span></a></div>' +
    '<span class="note">' + esc(t('credits')) + '</span></fieldset>';
  p.innerHTML = h;
  p.querySelectorAll('[data-sc]').forEach((i) => i.addEventListener('change', () => { S[i.dataset.sc] = i.checked; saveS(); settingChanged(i.dataset.sc); }));
  p.querySelectorAll('[data-ss]').forEach((i) => i.addEventListener('change', () => {
    const k = i.dataset.ss; let v = i.value;
    if (['snapMove', 'snapRot', 'schema'].includes(k)) v = Number(v);
    S[k] = v; saveS(); settingChanged(k);
  }));
}
async function settingChanged(k) {
  if (k === 'lang') { applyStatic(); renderAll(); setK(K.state); showHint(); renderSettings(); return; }
  if (k === 'theme' || k === 'bg') { applyTheme(); return; }
  if (k === 'edges') refreshLooks();
  if (k === 'grid' && grid) grid.visible = !!S.grid;
  if (k === 'axes') req();
  if (k === 'newColor') refreshLooks();
  if (k === 'snapMove' || k === 'snapRot') attachGizmo();
  if (k === 'quality') remeshAll();
  req();
}
async function remeshAll() {
  const list = state.bodies.filter((b) => b.kind === 'brep' && b.sid);
  if (!list.length) return;
  const r = await withBusy(t('working'), () => kcall('remesh', { sids: list.map((b) => b.sid), quality: S.quality }));
  if (!r) return;
  const m = new Map(r.map((x) => [x.sid, x.mesh]));
  // a display setting, not an edit: replace in place without an undo step
  const swap = (s) => Object.assign({}, s, { bodies: s.bodies.map((b) => (b.sid && m.has(b.sid) ? Object.assign({}, b, { mesh: m.get(b.sid) }) : b)) });
  state = swap(state);
  for (let i = 0; i < undoStack.length; i++) undoStack[i] = swap(undoStack[i]);
  for (let i = 0; i < redoStack.length; i++) redoStack[i] = swap(redoStack[i]);
  changed();
}
function applyTheme() {
  document.documentElement.dataset.ui = S.theme === 'light' ? 'light' : 'dark';
  const btn = $('bTheme'); btn.dataset.ic = S.theme === 'light' ? 'moon' : 'sun'; applyStatic(btn.parentNode);
  stage.style.background = S.bg === 'flat' ? 'var(--view-b)' : '';
  edgeMat.color.set(cssVar('--edge') || '#0c0f0e');
  ovMaterials();
  if (grid) { grid.material.opacity = S.theme === 'light' ? 0.55 : 0.45; }
  updateHighlights(); req();
}

// ---------------- panels, layout ----------------
// right panel: tabs (appearance / create / operations); settings and the sketch open on top of them, like in BoardV
const RV = { set: false };
function rightView() {
  const over = RV.set || SK.on;
  document.querySelector('.tabs').hidden = over;
  $('paneLook').hidden = over || S.tab !== 'look'; $('paneCreate').hidden = over || S.tab !== 'create'; $('paneOps').hidden = over || S.tab !== 'ops';
  $('setWrap').hidden = !RV.set; $('skWrap').hidden = !SK.on || RV.set;
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  $('bSettings').setAttribute('aria-pressed', String(RV.set));
}
function showTab(name) {
  if (name === 'sketch') { RV.set = false; if (!S.right) { S.right = true; layout(); } rightView(); return; }
  if (name === 'set') { openSettings(); return; }
  S.tab = name; saveS();
  if (RV.set) RV.set = false;
  rightView();
  if (name === 'ops') renderOps();
}
function openSettings() { RV.set = true; if (!S.right) { S.right = true; layout(); } renderSettings(); rightView(); $('paneSet').scrollTop = 0; }
function closeSettings() { RV.set = false; rightView(); }
// show one section of the operations pane (from the command bar)
function focusOp(key) {
  if (SK.on) return;
  if (!S.right) { S.right = true; layout(); }
  showTab('ops');
  const el = $('op-' + key);
  if (!el) return;
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  if (!selBodies().length) toast(t('opsSelect'), 'warn');
}
function layout() {
  const m = $('main');
  m.style.setProperty('--lw', S.lw + 'px'); m.style.setProperty('--rw', S.rw + 'px');
  m.classList.toggle('noright', !S.right);
  $('bRight').setAttribute('aria-pressed', String(!!S.right));
  saveS(); resize();
}
function splitter(el, key, sign) {
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId); el.classList.add('on');
    const x0 = e.clientX, w0 = S[key];
    const mv = (ev) => { S[key] = clamp(w0 + sign * (ev.clientX - x0), 200, 640); layout(); };
    const up = () => { el.classList.remove('on'); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  });
}
function renderAll() { renderTree(); renderProps(); renderLook(); renderCreate(); renderOps(); if (RV.set) renderSettings(); if (SK.on) renderSketchPane(); renderCmdBar(); updateStatus(); }

// views popup
function viewsMenu(x, y) {
  const v = (k, key) => mi(k, 'cube', t('v_' + k), key);
  showMenu(x, y, v('front', 'Ctrl+1') + v('back', 'Ctrl+2') + v('left', 'Ctrl+3') + v('right', 'Ctrl+4') + v('top', 'Ctrl+5') + v('bottom', 'Ctrl+6') + v('iso', 'Ctrl+7') + v('iso2', ''),
    Object.fromEntries(Object.keys(VIEWS).map((k) => [k, () => setView(k)])));
}
function modeMenu(x, y) {
  const it = (k) => '<button data-a="' + k + '">' + IC.svg(S.mode === k ? 'target' : 'layers') + '<span>' + esc(t('m_' + k)) + '</span></button>';
  showMenu(x, y, it('shadedEdges') + it('shaded') + it('wire') + it('xray'), Object.fromEntries(['shadedEdges', 'shaded', 'wire', 'xray'].map((k) => [k, () => { S.mode = k; saveS(); refreshLooks(); }])));
}

// ---------------- keyboard ----------------
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (/INPUT|SELECT|TEXTAREA/.test(tag) && e.key !== 'Escape') return;
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (k === 'escape' && !menu.hidden) { hideMenu(); e.preventDefault(); return; }
  if (SK.on) { if (sketchKey(e)) { e.preventDefault(); return; } if (!ctrl && !['f'].includes(k)) return; }
  if (k === 'escape' && RV.set) { closeSettings(); e.preventDefault(); return; }
  if (ctrl && e.shiftKey && k === 'c') { e.preventDefault(); copyLook(); return; }
  if (ctrl && e.shiftKey && k === 'v') { e.preventDefault(); pasteLook(); return; }
  if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (ctrl && k === 'o') { e.preventDefault(); openDialog(); return; }
  if (ctrl && k === 's') { e.preventDefault(); saveProject(); return; }
  if (ctrl && k === 'e') { e.preventDefault(); exportDialog(); return; }
  if (ctrl && k === 'a') { e.preventDefault(); selectAll(); return; }
  if (ctrl && k === 'd') { e.preventDefault(); duplicate(); return; }
  if (ctrl && /^[1-7]$/.test(e.key)) { e.preventDefault(); setView(['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'][Number(e.key) - 1]); return; }
  if (ctrl || e.altKey) return;
  switch (k) {
    case 'escape': hideMenu(); if (tool === 'measure' && MS.a) clearMeasure(); else if (tool !== 'select') setTool('select'); else setSel([]); break;
    case 'k': startSketchMenu(); break;
    case 'delete': case 'backspace': deleteSel(); break;
    case 'f': fitView(null, e.shiftKey); break;
    case 'q': setTool('select'); break;
    case 'i': setTool('pick'); break;
    case 'b': setTool('paint'); break;
    case 't': setTool('move'); break;
    case 'r': setTool('rotate'); break;
    case 'm': setTool('measure'); break;
    case 'g': setFilter(S.filter === 'face' ? 'body' : 'face'); break;
    case 'h': if (e.shiftKey) showAll(); else hideSel(); break;
    case 'f2': { const b = selBodies()[0]; if (b) startRename(b.id); break; }
    default: return;
  }
  e.preventDefault();
});

// ---------------- wiring ----------------
function wire() {
  $('bOpen').addEventListener('click', openDialog);
  $('wOpen').addEventListener('click', openDialog);
  $('wCreate').addEventListener('click', () => { S.right = true; layout(); showTab('create'); });
  $('bNew').addEventListener('click', newScene);
  $('bSave').addEventListener('click', saveProject);
  $('bExport').addEventListener('click', exportDialog);
  $('bUndo').addEventListener('click', undo);
  $('bRedo').addEventListener('click', redo);
  $('bRight').addEventListener('click', () => { S.right = !S.right; layout(); });
  $('bTheme').addEventListener('click', () => { S.theme = S.theme === 'light' ? 'dark' : 'light'; saveS(); applyTheme(); if (RV.set) renderSettings(); });
  $('bSettings').addEventListener('click', () => { if (RV.set) closeSettings(); else openSettings(); });
  $('setClose').addEventListener('click', closeSettings);
  $('skClose').addEventListener('click', () => { if (!SK.ents.length || confirm(t('skConfirmExit'))) endSketch(); });
  document.querySelectorAll('#toolBar [data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  document.querySelectorAll('#filterSeg [data-f]').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.f)));
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('vFit').addEventListener('click', () => fitView());
  $('vViews').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); viewsMenu(r.left - 160, r.bottom + 6); });
  $('vMode').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); modeMenu(r.left - 160, r.bottom + 6); });
  $('vProj').addEventListener('click', () => setProjection(cam !== pcam));
  $('vGrid').addEventListener('click', () => { S.grid = !S.grid; saveS(); grid.visible = S.grid; $('vGrid').setAttribute('aria-pressed', String(S.grid)); req(); });
  splitter($('splitL'), 'lw', 1); splitter($('splitR'), 'rw', -1);
}

// small hook for automated tests and the console
window.__tdv = {
  get state() { return state; }, get sel() { return sel; }, kcall, get SK() { return SK; }, get MS() { return MS; },
  skScreen(x, y) { const r = renderer.domElement.getBoundingClientRect(); const s = screenOfL([x, y]); return [r.left + s[0], r.top + s[1]]; },
  worldScreen(x, y, z) { const r = renderer.domElement.getBoundingClientRect(); const v = new THREE.Vector3(x, y, z).project(cam); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; },
  screenOf(id) { const o = objs.get(id); if (!o) return null; const c = new THREE.Box3().setFromObject(o.mesh).getCenter(new THREE.Vector3()).project(cam); const r = renderer.domElement.getBoundingClientRect(); return [r.left + (c.x + 1) / 2 * r.width, r.top + (1 - c.y) / 2 * r.height]; },
};

function boot() {
  applyStatic();
  wire();
  applyTheme();
  layout();
  renderAll();
  if (!['look', 'create', 'ops'].includes(S.tab)) S.tab = 'look';
  showTab(S.tab);
  setFilter(S.filter);
  setTool('select');
  $('vProj').setAttribute('aria-pressed', String(!S.persp));
  $('vGrid').setAttribute('aria-pressed', String(!!S.grid));
  if (!S.persp) setProjection(false);
  fitView(new THREE.Vector3().fromArray(VIEWS.iso));
  kernelStart();
  wireIO();
}
