/* 3DViewer — opening files of every kind, export, project files (.3dv). Same scope as app.js. */
/* global THREE */

const EXT_MAIN = ['step', 'stp', 'p21', 'iges', 'igs', 'brep', 'brp', 'stl', 'obj', 'gltf', 'glb', 'fbx', 'dae', '3ds', 'ply', '3mf', 'amf', 'wrl', 'vrml', 'vtk', 'vtp', 'pcd', 'xyz', 'usdz', 'lwo', 'kmz', 'off', '3dv'];
const EXT_AUX = ['mtl', 'bin', 'png', 'jpg', 'jpeg', 'tga', 'bmp', 'gif', 'webp', 'ktx2', 'dds', 'tif', 'tiff', 'hdr'];
const EXT_CLOSED = {
  sldprt: 'SolidWorks', sldasm: 'SolidWorks', slddrw: 'SolidWorks', x_t: 'Parasolid', x_b: 'Parasolid', xmt_txt: 'Parasolid', xmt_bin: 'Parasolid',
  ipt: 'Autodesk Inventor', iam: 'Autodesk Inventor', catpart: 'CATIA', catproduct: 'CATIA', prt: 'Creo / NX', asm: 'Creo / NX', par: 'Solid Edge', psm: 'Solid Edge',
  jt: 'JT', '3dm': 'Rhino', skp: 'SketchUp', f3d: 'Fusion 360', f3z: 'Fusion 360', dwg: 'AutoCAD', dxf: 'AutoCAD', blend: 'Blender', max: '3ds Max', c4d: 'Cinema 4D', ma: 'Maya', mb: 'Maya', sat: 'ACIS', sab: 'ACIS', pcbdoc: 'Altium',
};
const extOf = (n) => { const m = /\.([^./\\]+)$/.exec(n || ''); return m ? m[1].toLowerCase() : ''; };
const baseOf = (n) => String(n || '').split(/[\\/]/).pop();
const stem = (n) => baseOf(n).replace(/\.[^.]+$/, '');

function openDialog() {
  const inp = $('fileIn');
  inp.accept = EXT_MAIN.concat(EXT_AUX, Object.keys(EXT_CLOSED)).map((e) => '.' + e).join(',');
  inp.value = '';
  inp.click();
}

async function openFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const byName = new Map(files.map((f) => [baseOf(f.name).toLowerCase(), f]));
  const mains = files.filter((f) => EXT_MAIN.includes(extOf(f.name)));
  const closed = files.filter((f) => EXT_CLOSED[extOf(f.name)]);
  const unknown = files.filter((f) => !EXT_MAIN.includes(extOf(f.name)) && !EXT_AUX.includes(extOf(f.name)) && !EXT_CLOSED[extOf(f.name)]);
  if (closed.length) closedFormatDialog(closed);
  if (unknown.length) toast(t('unknownFormat', unknown.map((f) => f.name).join(', ')), 'warn', 6000);
  if (!mains.length) { if (!closed.length && !unknown.length) toast(t('auxOnly'), 'warn'); return; }
  const first = !state.bodies.length;
  let added = 0;
  for (const f of mains) {
    const r = await withBusy(t('opening', f.name), () => importOne(f, byName));
    if (r) added += r;
  }
  if (added) {
    if (!docName) docName = stem(mains[0].name);
    updateStatus();
    fitView(first ? new THREE.Vector3().fromArray(VIEWS.iso) : null);
    const box = new THREE.Box3();
    state.bodies.slice(-added).forEach((b) => { const g = base(b.mesh); if (g.boundingBox) box.union(g.boundingBox); });
    if (!box.isEmpty()) { const s = box.getSize(new THREE.Vector3()); toast(t('opened', added, fmt(s.x) + ' × ' + fmt(s.y) + ' × ' + fmt(s.z))); }
  }
}

async function importOne(file, byName) {
  const ext = extOf(file.name), name = stem(file.name);
  if (ext === '3dv') { await loadProject(file); return state.bodies.length; }
  let bodies = [];
  if (ext === 'step' || ext === 'stp' || ext === 'p21') {
    const bytes = await file.arrayBuffer();
    let r;
    try { r = await kcall('importStep', { bytes, quality: S.quality }, []); }
    catch (e) { // exact read failed: fall back to the mesh reader
      console.warn(e);
      r = await kcall('importMeshOcct', { bytes: await file.arrayBuffer(), kind: 'step' });
      r.bodies.forEach((b) => { b.kind = 'mesh'; });
      toast(t('stepFallback'), 'warn');
    }
    bodies = r.bodies.map((b) => Object.assign(b, { kind: b.sid ? 'brep' : 'mesh' }));
    bodies.forEach((b) => track(b.sid));
  } else if (ext === 'iges' || ext === 'igs') {
    const r = await kcall('importMeshOcct', { bytes: await file.arrayBuffer(), kind: 'iges' });
    bodies = r.bodies.map((b) => Object.assign(b, { kind: 'mesh' }));
    toast(t('igesNote'), '', 5000);
  } else if (ext === 'brep' || ext === 'brp') {
    const r = await kcall('importBrep', { text: await file.text(), quality: S.quality });
    bodies = r.bodies.map((b) => Object.assign(b, { kind: 'brep' }));
    bodies.forEach((b) => track(b.sid));
  } else if (ext === 'off') {
    bodies = [parseOFF(await file.text(), name)];
  } else {
    const obj = await loadWithThree(file, ext, byName);
    const scale = ['gltf', 'glb', 'usdz', 'kmz'].includes(ext) ? 1000 : 1; // these formats are in metres
    bodies = objectToBodies(obj, name, scale, scale !== 1); // and Y-up
  }
  bodies = bodies.filter((b) => b.mesh && b.mesh.position && b.mesh.position.length);
  if (!bodies.length) throw new Error(t('nothingInFile', file.name));
  const g = mkGroup(name);
  const list = bodies.map((b) => mkBody({
    name: b.name || name, group: g.id, kind: b.kind || 'mesh', sid: b.sid || 0, mesh: normMesh(b.mesh), color: b.color || null,
    faceColors: b.faceColors || {}, alpha: b.alpha == null ? 1 : b.alpha, metal: b.metal == null ? 0.1 : b.metal, rough: b.rough == null ? 0.5 : b.rough, vcol: !!b.vcol,
  }));
  commit(Object.assign({}, state, { groups: state.groups.concat([g]), bodies: state.bodies.concat(list) }));
  return list.length;
}
function normMesh(m) {
  if (!m.groups || !m.groups.length) m.groups = m.index && m.index.length ? [[0, m.index.length, 0]] : [];
  return m;
}

// --- three.js loaders ---
function urlManager(byName) {
  const urls = [];
  const mgr = new THREE.LoadingManager();
  mgr.setURLModifier((url) => {
    if (/^(data|blob):/.test(url)) return url;
    const f = byName.get(baseOf(decodeURIComponent(url)).toLowerCase());
    if (!f) return url;
    const u = URL.createObjectURL(f); urls.push(u); return u;
  });
  mgr.cleanup = () => setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 5000);
  return mgr;
}
async function loadWithThree(file, ext, byName) {
  const mgr = urlManager(byName);
  try {
    const ab = () => file.arrayBuffer(), txt = () => file.text();
    switch (ext) {
      case 'stl': { const g = new THREE.STLLoader(mgr).parse(await ab()); return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: g.hasColors ? 0xffffff : 0xb8c0c6, vertexColors: !!g.hasColors })); }
      case 'ply': { const g = new THREE.PLYLoader(mgr).parse(await ab()); return g.index || (g.attributes.position.count % 3 === 0 && !g.userData.pointCloud) ? new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: !!g.attributes.color })) : new THREE.Points(g, new THREE.PointsMaterial({ vertexColors: !!g.attributes.color })); }
      case 'obj': {
        const text = await txt();
        const loader = new THREE.OBJLoader(mgr);
        const lib = /^\s*mtllib\s+(.+?)\s*$/m.exec(text);
        const mtlFile = lib ? byName.get(baseOf(lib[1]).toLowerCase()) : Array.from(byName.values()).find((f) => extOf(f.name) === 'mtl');
        if (mtlFile) { const mats = new THREE.MTLLoader(mgr).parse(await mtlFile.text(), ''); mats.preload(); loader.setMaterials(mats); }
        else if (lib) toast(t('mtlMissing', lib[1]), 'warn', 6000);
        return loader.parse(text);
      }
      case 'gltf': case 'glb': return await gltf(file, ext, mgr);
      case 'fbx': return new THREE.FBXLoader(mgr).parse(await ab(), '');
      case 'dae': return new THREE.ColladaLoader(mgr).parse(await txt(), '').scene;
      case '3ds': return new THREE.TDSLoader(mgr).parse(await ab(), '');
      case '3mf': return new THREE.ThreeMFLoader(mgr).parse(await ab());
      case 'amf': return new THREE.AMFLoader(mgr).parse(await ab());
      case 'wrl': case 'vrml': return new THREE.VRMLLoader(mgr).parse(await txt(), '');
      case 'vtk': case 'vtp': { const g = new THREE.VTKLoader(mgr).parse(await ab(), ''); return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: !!g.attributes.color })); }
      case 'pcd': return new THREE.PCDLoader(mgr).parse(await ab());
      case 'xyz': { const g = new THREE.XYZLoader(mgr).parse(await txt()); return new THREE.Points(g, new THREE.PointsMaterial({ vertexColors: !!g.attributes.color })); }
      case 'usdz': return new THREE.USDZLoader(mgr).parse(await ab());
      case 'lwo': { const r = new THREE.LWOLoader(mgr).parse(await ab(), '', file.name); const g = new THREE.Group(); r.meshes.forEach((m) => g.add(m)); return g; }
      case 'kmz': return new THREE.KMZLoader(mgr).parse(await ab()).scene;
      default: throw new Error(t('unknownFormat', file.name));
    }
  } finally { mgr.cleanup(); }
}
async function gltf(file, ext, mgr) {
  const data = ext === 'glb' ? await file.arrayBuffer() : await file.text();
  return new Promise((res, rej) => {
    new THREE.GLTFLoader(mgr).parse(data, '', (g) => res(g.scene), (e) => rej(new Error(/draco/i.test(String(e && e.message)) ? t('dracoNote') : String((e && e.message) || e))));
  });
}

// three.js object tree -> bodies (world transforms baked in, one body per mesh, material groups become faces)
function objectToBodies(root, name, scale, yUp) {
  const out = [];
  if (!root) return out;
  root.updateMatrixWorld(true);
  const S0 = new THREE.Matrix4().makeScale(scale, scale, scale);
  if (yUp) S0.premultiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  root.traverse((o) => {
    if (!(o.isMesh || o.isPoints) || !o.geometry || !o.geometry.attributes.position) return;
    let g = o.geometry;
    if (g.attributes.position.isInterleavedBufferAttribute || g.morphAttributes && Object.keys(g.morphAttributes).length) g = g.clone();
    const m = new THREE.Matrix4().multiplyMatrices(S0, o.matrixWorld);
    const P = g.attributes.position, n = P.count;
    const position = new Float32Array(n * 3), v = new THREE.Vector3();
    for (let i = 0; i < n; i++) { v.fromBufferAttribute(P, i).applyMatrix4(m); position[i * 3] = v.x; position[i * 3 + 1] = v.y; position[i * 3 + 2] = v.z; }
    let normal = null;
    if (o.isMesh && g.attributes.normal) {
      const N = g.attributes.normal, nm = new THREE.Matrix3().getNormalMatrix(m);
      normal = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); normal[i * 3] = v.x; normal[i * 3 + 1] = v.y; normal[i * 3 + 2] = v.z; }
    }
    let colors = null;
    if (g.attributes.color) {
      const C = g.attributes.color; colors = new Float32Array(n * 3);
      const c = new THREE.Color();
      for (let i = 0; i < n; i++) { c.fromBufferAttribute(C, i); colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b; }
    }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const hex = (mt) => {
      if (!mt || !mt.color) return null;
      const avg = texAverage(mt.map);
      return '#' + (avg ? avg.multiply(mt.color) : mt.color).getHexString();
    };
    const metal = (mt) => (mt && mt.metalness != null ? mt.metalness : 0.1);
    const rough = (mt) => (mt && mt.roughness != null ? mt.roughness : 0.5);
    const op = (mt) => (mt && mt.transparent ? (mt.opacity == null ? 1 : mt.opacity) : 1);
    const bname = o.name || (o.parent && o.parent !== root && o.parent.name) || (mats[0] && mats[0].name) || name;
    if (o.isPoints) {
      out.push({ name: bname, kind: 'points', mesh: { position, colors, index: new Uint32Array(0), groups: [] }, color: hex(mats[0]) });
      return;
    }
    let index;
    if (g.index) index = Uint32Array.from(g.index.array);
    else { index = new Uint32Array(n - (n % 3)); for (let i = 0; i < index.length; i++) index[i] = i; }
    if (m.determinant() < 0) for (let i = 0; i < index.length; i += 3) { const a = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = a; }
    let groups, faceColors = {};
    const bodyMat = mats[0];
    if (g.groups && g.groups.length > 1 && mats.length > 1) {
      groups = [];
      g.groups.slice().sort((a, b) => a.start - b.start).forEach((gr, i) => {
        const cnt = Math.min(gr.count, index.length - gr.start);
        if (cnt <= 0) return;
        groups.push([gr.start, cnt - (cnt % 3), groups.length]);
        const c = hex(mats[gr.materialIndex]);
        if (c && c !== hex(bodyMat)) faceColors[groups.length - 1] = c;
      });
    } else groups = [[0, index.length, 0]];
    const vcol = !!(colors && bodyMat && bodyMat.vertexColors);
    out.push({ name: bname, kind: 'mesh', mesh: { position, normal, index, groups, colors: vcol ? colors : null }, color: vcol ? '#ffffff' : hex(bodyMat), faceColors, metal: metal(bodyMat), rough: rough(bodyMat), alpha: op(bodyMat), vcol });
  });
  return out;
}

// textures are not kept: a textured material is shown in the texture's average colour
const texCache = new WeakMap();
function texAverage(tex) {
  const img = tex && tex.image;
  if (!img || !(img.width > 0)) return null;
  if (texCache.has(img)) return texCache.get(img).clone();
  let c = null;
  try {
    const cv = document.createElement('canvas'); cv.width = cv.height = 16;
    const g = cv.getContext('2d'); g.drawImage(img, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 16) continue; r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
    if (n) c = new THREE.Color().setRGB(r / n / 255, gg / n / 255, b / n / 255, THREE.SRGBColorSpace);
  } catch (e) { c = null; }
  texCache.set(img, c || new THREE.Color(1, 1, 1));
  return c ? c.clone() : null;
}

function parseOFF(text, name) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  let i = 0;
  if (/^C?N?OFF/i.test(lines[0])) { const rest = lines[0].replace(/^C?N?OFF/i, '').trim(); if (rest) lines[0] = rest; else i = 1; }
  const [nv, nf] = lines[i++].split(/\s+/).map(Number);
  const position = new Float32Array(nv * 3);
  for (let k = 0; k < nv; k++) { const p = lines[i++].split(/\s+/).map(Number); position[k * 3] = p[0]; position[k * 3 + 1] = p[1]; position[k * 3 + 2] = p[2]; }
  const idx = [];
  for (let k = 0; k < nf; k++) { const f = lines[i++].split(/\s+/).map(Number); const c = f[0]; for (let j = 2; j < c; j++) idx.push(f[1], f[j], f[j + 1]); }
  const index = Uint32Array.from(idx);
  return { name, kind: 'mesh', mesh: { position, index, groups: [[0, index.length, 0]] } };
}

function closedFormatDialog(files) {
  const kinds = Array.from(new Set(files.map((f) => EXT_CLOSED[extOf(f.name)])));
  const sw = kinds.includes('SolidWorks');
  const body = '<p>' + esc(t('closedIntro', files.map((f) => f.name).join(', '), kinds.join(', '))) + '</p>' +
    (sw ? '<div class="modehint">' + t('closedSW') + '</div>' : '') +
    '<p class="note">' + t('closedOther') + '</p>';
  modal(t('closedTitle'), body, [[t('ok'), 'primary', () => true]]);
}

function modal(title, bodyHtml, buttons, onMount) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = '<div class="dlg" role="dialog" aria-modal="true"><div class="dh"><b>' + esc(title) + '</b><button class="btn ico" data-x data-ic="x"></button></div><div class="db">' + bodyHtml + '</div><div class="df"></div></div>';
  const foot = m.querySelector('.df');
  const close = () => { m.remove(); document.removeEventListener('keydown', onKey, true); };
  buttons.forEach(([label, cls, fn]) => {
    const b = document.createElement('button'); b.className = 'btn ' + (cls || ''); b.textContent = label;
    b.addEventListener('click', async () => { const r = await fn(m); if (r !== false) close(); });
    foot.appendChild(b);
  });
  m.querySelector('[data-x]').addEventListener('click', close);
  m.addEventListener('pointerdown', (e) => { if (e.target === m) close(); });
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(m);
  applyStatic(m);
  if (onMount) onMount(m);
  return m;
}

// ---------------- export ----------------
const FORMATS = [
  { id: 'step', ext: 'step', tag: 'fmtRec', desc: 'fmtStep' },
  { id: 'stl', ext: 'stl', desc: 'fmtStl' },
  { id: '3mf', ext: '3mf', desc: 'fmt3mf' },
  { id: 'obj', ext: 'zip', label: 'OBJ + MTL', desc: 'fmtObj' },
  { id: 'glb', ext: 'glb', desc: 'fmtGlb' },
  { id: 'ply', ext: 'ply', desc: 'fmtPly' },
  { id: 'brep', ext: 'brep', desc: 'fmtBrep' },
  { id: '3dv', ext: '3dv', label: '3DV', desc: 'fmt3dv' },
];
let expFmt = 'step';
function exportDialog() {
  if (!state.bodies.length) { toast(t('noModel'), 'warn'); return; }
  const hasSel = selBodies().length > 0;
  const body = '<div class="fmtgrid">' + FORMATS.map((f) => '<button class="fmt" data-fmt="' + f.id + '" aria-pressed="' + (f.id === expFmt) + '">' + (f.tag ? '<span class="tag">' + esc(t(f.tag)) + '</span>' : '') + '<b>' + esc(f.label || f.id.toUpperCase()) + '</b><small>' + esc(t(f.desc)) + '</small></button>').join('') + '</div>' +
    '<fieldset><legend>' + esc(t('expOptions')) + '</legend>' +
    '<div class="frow"><span>' + esc(t('expWhat')) + '</span><select class="sel" id="eWhat"><option value="vis">' + esc(t('expVisible')) + '</option><option value="sel"' + (hasSel ? '' : ' disabled') + '>' + esc(t('expSelected')) + '</option><option value="all">' + esc(t('expAll')) + '</option></select></div>' +
    '<div class="frow" data-only="step"><span>' + esc(t('stepSchema')) + '</span><select class="sel" id="eSchema"><option value="4">AP214</option><option value="5">AP242</option><option value="3">AP203</option></select></div>' +
    '<div class="frow" data-only="step"><span>' + esc(t('stepStructure')) + '</span><select class="sel" id="eStruct"><option value="part">' + esc(t('stPart')) + '</option><option value="assembly">' + esc(t('stAsm')) + '</option></select></div>' +
    '<label class="frow chk" data-only="mesh"><input type="checkbox" id="eHigh"><span>' + esc(t('expHigh')) + '</span></label>' +
    '<div class="frow"><span>' + esc(t('fileNameL')) + '</span><input class="txt" id="eName" style="width:220px"></div>' +
    '<span class="note" id="eNote"></span></fieldset>';
  modal(t('exportTitle'), body, [[t('cancel'), '', () => true], [t('save'), 'primary', async (m) => {
    const opts = { what: m.querySelector('#eWhat').value, schema: Number(m.querySelector('#eSchema').value), structure: m.querySelector('#eStruct').value, high: m.querySelector('#eHigh').checked, name: m.querySelector('#eName').value.trim() || 'model' };
    S.schema = opts.schema; S.structure = opts.structure; saveS();
    const ok = await withBusy(t('exporting'), () => doExport(expFmt, opts));
    return ok !== null;
  }]], (m) => {
    m.querySelector('#eSchema').value = String(S.schema); m.querySelector('#eStruct').value = S.structure;
    m.querySelector('#eName').value = docName || (state.groups[0] && state.groups[0].name) || 'model';
    const upd = () => {
      m.querySelectorAll('.fmt').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fmt === expFmt)));
      m.querySelectorAll('[data-only=step]').forEach((el) => { el.hidden = expFmt !== 'step'; });
      m.querySelectorAll('[data-only=mesh]').forEach((el) => { el.hidden = !['stl', '3mf', 'obj', 'glb', 'ply'].includes(expFmt); });
      const meshN = state.bodies.filter((b) => b.kind !== 'brep').length;
      m.querySelector('#eNote').textContent = expFmt === 'step' && meshN ? t('stepMeshNote', meshN) : expFmt === 'step' ? t('stepColourNote') : '';
    };
    m.querySelectorAll('.fmt').forEach((b) => b.addEventListener('click', () => { expFmt = b.dataset.fmt; upd(); }));
    upd();
  });
}
function exportBodies(what) {
  if (what === 'sel') return selBodies();
  if (what === 'all') return state.bodies.slice();
  return state.bodies.filter((b) => b.visible && groupVisible(b.group));
}
async function doExport(fmtId, o) {
  let bodies = exportBodies(o.what).filter((b) => b.kind !== 'points' || fmtId === 'ply' || fmtId === '3dv');
  if (!bodies.length) throw new Error(t('nothingToExport'));
  const name = o.name.replace(/[\\/:*?"<>|]+/g, '_');
  if (fmtId === '3dv') { await saveProject(name, bodies); return true; }
  if (fmtId === 'step' || fmtId === 'brep') {
    const items = bodies.filter((b) => b.kind !== 'points').map((b) => {
      const g = groupById(b.group);
      const it = { name: b.name, group: g ? g.name : '', color: bodyColor(b), alpha: b.alpha, faceColors: b.faceColors };
      if (b.kind === 'brep' && b.sid) it.sid = b.sid;
      else it.mesh = { position: b.mesh.position, index: b.mesh.index, groups: b.mesh.groups };
      return it;
    });
    if (fmtId === 'step') {
      const r = await kcall('exportStep', { items, schema: o.schema, structure: o.structure, docName: name });
      await saveBlob(new Blob([r.bytes], { type: 'application/step' }), name + '.step');
    } else {
      const r = await kcall('exportBrep', { items });
      await saveBlob(new Blob([r.text], { type: 'text/plain' }), name + '.brep');
    }
    toast(t('saved', name + '.' + fmtId));
    return true;
  }
  // mesh formats: current display tessellation, or a finer one for exact bodies
  if (o.high) {
    const ex = bodies.filter((b) => b.kind === 'brep' && b.sid);
    if (ex.length) {
      const r = await kcall('remesh', { sids: ex.map((b) => b.sid), quality: 'high' });
      const m = new Map(r.map((x) => [x.sid, x.mesh]));
      bodies = bodies.map((b) => (b.sid && m.has(b.sid) ? Object.assign({}, b, { mesh: m.get(b.sid) }) : b));
    }
  }
  let blob, ext = fmtId;
  if (fmtId === 'stl') blob = writeSTL(bodies);
  else if (fmtId === 'ply') blob = writePLY(bodies);
  else if (fmtId === '3mf') blob = write3MF(bodies, name);
  else if (fmtId === 'obj') { blob = writeOBJzip(bodies, name); ext = 'zip'; }
  else if (fmtId === 'glb') blob = await writeGLB(bodies);
  await saveBlob(blob, name + '.' + ext);
  toast(t('saved', name + '.' + ext));
  return true;
}
// per-triangle colour lookup for a body
function triColours(b) {
  const tris = b.mesh.index.length / 3, out = new Array(tris);
  const base = bodyColor(b);
  (b.mesh.groups || [[0, b.mesh.index.length, 0]]).forEach((g) => { const c = b.faceColors[g[2]] || base; for (let t2 = g[0] / 3; t2 < (g[0] + g[1]) / 3; t2++) out[t2] = c; });
  for (let i = 0; i < tris; i++) if (!out[i]) out[i] = base;
  return out;
}
const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
function writeSTL(bodies) {
  const tris = bodies.reduce((n, b) => n + b.mesh.index.length / 3, 0);
  const buf = new ArrayBuffer(84 + tris * 50), v = new DataView(buf);
  const head = '3DViewer STL, units: mm';
  for (let i = 0; i < head.length; i++) v.setUint8(i, head.charCodeAt(i));
  v.setUint32(80, tris, true);
  let o = 84;
  const a = new THREE.Vector3(), b2 = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  bodies.forEach((b) => {
    const p = b.mesh.position, ix = b.mesh.index, cols = triColours(b);
    for (let i = 0; i < ix.length; i += 3) {
      a.fromArray(p, ix[i] * 3); b2.fromArray(p, ix[i + 1] * 3); c.fromArray(p, ix[i + 2] * 3);
      n.subVectors(c, b2).cross(new THREE.Vector3().subVectors(a, b2)).normalize();
      v.setFloat32(o, n.x, true); v.setFloat32(o + 4, n.y, true); v.setFloat32(o + 8, n.z, true); o += 12;
      [a, b2, c].forEach((q) => { v.setFloat32(o, q.x, true); v.setFloat32(o + 4, q.y, true); v.setFloat32(o + 8, q.z, true); o += 12; });
      const [r, g, bb] = rgb(cols[i / 3]); // VisCAM/SolidView colour bits
      v.setUint16(o, 0x8000 | ((bb >> 3) << 10) | ((g >> 3) << 5) | (r >> 3), true); o += 2;
    }
  });
  return new Blob([buf], { type: 'model/stl' });
}
function writePLY(bodies) {
  let nv = 0, nf = 0;
  bodies.forEach((b) => { if (b.kind === 'points') nv += b.mesh.position.length / 3; else { nv += b.mesh.index.length; nf += b.mesh.index.length / 3; } });
  const head = 'ply\nformat binary_little_endian 1.0\ncomment 3DViewer, units: mm\nelement vertex ' + nv + '\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face ' + nf + '\nproperty list uchar int vertex_indices\nend_header\n';
  const hb = new TextEncoder().encode(head);
  const buf = new ArrayBuffer(hb.length + nv * 15 + nf * 13), v = new DataView(buf);
  new Uint8Array(buf).set(hb);
  let o = hb.length;
  const faces = [];
  let base = 0;
  bodies.forEach((b) => {
    const p = b.mesh.position;
    if (b.kind === 'points') {
      const col = rgb(bodyColor(b));
      for (let i = 0; i < p.length; i += 3) {
        v.setFloat32(o, p[i], true); v.setFloat32(o + 4, p[i + 1], true); v.setFloat32(o + 8, p[i + 2], true);
        const c = b.mesh.colors ? [b.mesh.colors[i] * 255, b.mesh.colors[i + 1] * 255, b.mesh.colors[i + 2] * 255] : col;
        v.setUint8(o + 12, c[0]); v.setUint8(o + 13, c[1]); v.setUint8(o + 14, c[2]); o += 15;
      }
      base += p.length / 3; return;
    }
    const ix = b.mesh.index, cols = triColours(b);
    for (let i = 0; i < ix.length; i++) {
      const k = ix[i] * 3, c = rgb(cols[(i / 3) | 0]);
      v.setFloat32(o, p[k], true); v.setFloat32(o + 4, p[k + 1], true); v.setFloat32(o + 8, p[k + 2], true);
      v.setUint8(o + 12, c[0]); v.setUint8(o + 13, c[1]); v.setUint8(o + 14, c[2]); o += 15;
    }
    for (let i = 0; i < ix.length; i += 3) faces.push(base + i);
    base += ix.length;
  });
  faces.forEach((f) => { v.setUint8(o, 3); v.setInt32(o + 1, f, true); v.setInt32(o + 5, f + 1, true); v.setInt32(o + 9, f + 2, true); o += 13; });
  return new Blob([buf], { type: 'application/octet-stream' });
}
function write3MF(bodies, name) {
  const cols = [], colIdx = new Map();
  const ci = (h) => { const k = h.toUpperCase(); if (!colIdx.has(k)) { colIdx.set(k, cols.length); cols.push(k); } return colIdx.get(k); };
  let objects = '', items = '', id = 2;
  bodies.forEach((b) => {
    if (b.kind === 'points') return;
    const p = b.mesh.position, ix = b.mesh.index, tc = triColours(b), bc = ci(bodyColor(b));
    let vs = '', ts = '';
    for (let i = 0; i < p.length; i += 3) vs += '<vertex x="' + +p[i].toFixed(5) + '" y="' + +p[i + 1].toFixed(5) + '" z="' + +p[i + 2].toFixed(5) + '"/>';
    for (let i = 0; i < ix.length; i += 3) { const c = ci(tc[i / 3]); ts += '<triangle v1="' + ix[i] + '" v2="' + ix[i + 1] + '" v3="' + ix[i + 2] + '"' + (c !== bc ? ' pid="1" p1="' + c + '"' : '') + '/>'; }
    objects += '<object id="' + id + '" name="' + esc(b.name) + '" type="model" pid="1" pindex="' + bc + '"><mesh><vertices>' + vs + '</vertices><triangles>' + ts + '</triangles></mesh></object>';
    items += '<item objectid="' + id + '"/>';
    id++;
  });
  const model = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Title">' + esc(name) + '</metadata><metadata name="Application">3DViewer</metadata><resources><basematerials id="1">' +
    cols.map((c) => '<base name="' + c + '" displaycolor="' + c + 'FF"/>').join('') + '</basematerials>' + objects + '</resources><build>' + items + '</build></model>';
  const enc = (s) => new TextEncoder().encode(s);
  const zip = THREE.fflate.zipSync({
    '[Content_Types].xml': enc('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': enc('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': enc(model),
  }, { level: 6 });
  return new Blob([zip], { type: 'model/3mf' });
}
function writeOBJzip(bodies, name) {
  const mats = new Map();
  const mname = (b, c) => { const k = c.toUpperCase() + '|' + b.metal + '|' + b.rough + '|' + b.alpha; if (!mats.has(k)) mats.set(k, { n: 'mat_' + c.slice(1).toUpperCase() + '_' + mats.size, c, a: b.alpha == null ? 1 : b.alpha }); return mats.get(k).n; };
  const L = ['# 3DViewer OBJ, units: mm', 'mtllib ' + name + '.mtl'];
  let vo = 1;
  bodies.forEach((b) => {
    if (b.kind === 'points') return;
    const p = b.mesh.position, nr = b.mesh.normal, ix = b.mesh.index;
    L.push('o ' + b.name.replace(/\s+/g, '_'));
    for (let i = 0; i < p.length; i += 3) L.push('v ' + +p[i].toFixed(6) + ' ' + +p[i + 1].toFixed(6) + ' ' + +p[i + 2].toFixed(6));
    const hasN = nr && nr.length === p.length;
    if (hasN) for (let i = 0; i < nr.length; i += 3) L.push('vn ' + +nr[i].toFixed(5) + ' ' + +nr[i + 1].toFixed(5) + ' ' + +nr[i + 2].toFixed(5));
    const tc = triColours(b);
    let last = null;
    for (let i = 0; i < ix.length; i += 3) {
      const m = mname(b, tc[i / 3]);
      if (m !== last) { L.push('usemtl ' + m); last = m; }
      const f = (k) => (ix[k] + vo) + (hasN ? '//' + (ix[k] + vo) : '');
      L.push('f ' + f(i) + ' ' + f(i + 1) + ' ' + f(i + 2));
    }
    vo += p.length / 3;
  });
  const M = [];
  mats.forEach((m) => { const c = rgb(m.c).map((x) => (x / 255).toFixed(4)); M.push('newmtl ' + m.n, 'Kd ' + c.join(' '), 'Ka 0 0 0', 'Ks 0.2 0.2 0.2', 'Ns 50', 'd ' + m.a, 'illum 2', ''); });
  const enc = (s) => new TextEncoder().encode(s);
  return new Blob([THREE.fflate.zipSync({ [name + '.obj']: enc(L.join('\n') + '\n'), [name + '.mtl']: enc(M.join('\n')) }, { level: 6 })], { type: 'application/zip' });
}
async function writeGLB(bodies) {
  const root = new THREE.Group(); root.name = docName || 'model';
  root.scale.setScalar(0.001); // glTF is in metres
  root.rotation.x = -Math.PI / 2; // glTF is Y-up
  const gnodes = new Map();
  bodies.forEach((b) => {
    if (b.kind === 'points') return;
    let gn = gnodes.get(b.group);
    if (!gn) { gn = new THREE.Group(); const g = groupById(b.group); gn.name = g ? g.name : ''; root.add(gn); gnodes.set(b.group, gn); }
    const geo = viewGeo(b.mesh);
    const mats = [], idx = new Map();
    const mat = (c) => { if (!idx.has(c)) { idx.set(c, mats.length); mats.push(new THREE.MeshStandardMaterial({ color: new THREE.Color(c), metalness: b.metal, roughness: b.rough, transparent: b.alpha < 1, opacity: b.alpha, side: THREE.DoubleSide })); } return idx.get(c); };
    mat(bodyColor(b));
    (b.mesh.groups || []).forEach((g) => geo.addGroup(g[0], g[1], mat(b.faceColors[g[2]] || bodyColor(b))));
    const mesh = new THREE.Mesh(geo, mats.length > 1 ? mats : mats[0]);
    if (mats.length === 1) geo.clearGroups();
    mesh.name = b.name; gn.add(mesh);
  });
  const glb = await new Promise((res, rej) => new THREE.GLTFExporter().parse(root, res, rej, { binary: true }));
  return new Blob([glb], { type: 'model/gltf-binary' });
}
async function saveBlob(blob, name) {
  const D = window.tdvDesktop;
  if (D && D.saveFile) { // Windows app: the usual Windows "Save as" dialog
    const path = await D.saveFile(name, new Uint8Array(await blob.arrayBuffer()));
    if (!path) throw new Error(t('cancelled'));
    return true;
  }
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name });
      const w = await h.createWritable(); await w.write(blob); await w.close();
      return true;
    } catch (e) { if (e && e.name === 'AbortError') throw new Error(t('cancelled')); }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return true;
}

// ---------------- project (.3dv): exact bodies as BREP text, meshes as arrays, colours, tree ----------------
const b64 = {
  enc(arr) { const u = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); },
  dec(s, T) { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new T(u.buffer); },
};
async function saveProject(name, onlyBodies) {
  if (!state.bodies.length) { toast(t('noModel'), 'warn'); return; }
  const bodies = onlyBodies || state.bodies;
  const nm = typeof name === 'string' ? name : (docName || 'project');
  await withBusy(t('saving'), async () => {
    const out = [];
    for (const b of bodies) {
      const o = { name: b.name, group: b.group, kind: b.kind, color: b.color, faceColors: b.faceColors, alpha: b.alpha, metal: b.metal, rough: b.rough, visible: b.visible, vcol: b.vcol };
      if (b.kind === 'brep' && b.sid) o.brep = (await kcall('brepOf', { sid: b.sid })).text;
      else {
        o.mesh = { position: b64.enc(b.mesh.position), index: b64.enc(b.mesh.index || new Uint32Array(0)), groups: b.mesh.groups };
        if (b.mesh.normal && b.mesh.normal.length) o.mesh.normal = b64.enc(b.mesh.normal);
        if (b.mesh.colors) o.mesh.colors = b64.enc(b.mesh.colors);
      }
      out.push(o);
    }
    const used = new Set(bodies.map((b) => b.group));
    const json = JSON.stringify({ app: '3DViewer', format: 1, version: VLABEL, name: nm, groups: state.groups.filter((g) => used.has(g.id)), bodies: out });
    const gz = THREE.fflate.gzipSync(new TextEncoder().encode(json), { level: 6 });
    await saveBlob(new Blob([gz], { type: 'application/octet-stream' }), nm + '.3dv');
    toast(t('saved', nm + '.3dv'));
  });
}
async function loadProject(file) {
  const raw = new Uint8Array(await file.arrayBuffer());
  const json = JSON.parse(new TextDecoder().decode(raw[0] === 0x1f && raw[1] === 0x8b ? THREE.fflate.gunzipSync(raw) : raw));
  if (json.app !== '3DViewer') throw new Error(t('notProject'));
  const gmap = new Map();
  const groups = (json.groups || []).map((g) => { const ng = mkGroup(g.name); ng.visible = g.visible !== false; gmap.set(g.id, ng.id); return ng; });
  const bodies = [];
  for (const o of json.bodies) {
    let gid = gmap.get(o.group);
    if (gid == null) { const ng = mkGroup(json.name || 'Model'); groups.push(ng); gmap.set(o.group, ng.id); gid = ng.id; }
    const base0 = { name: o.name, group: gid, kind: o.kind, color: o.color, faceColors: o.faceColors || {}, alpha: o.alpha, metal: o.metal, rough: o.rough, visible: o.visible !== false, vcol: !!o.vcol };
    if (o.brep) {
      const r = await kcall('brepLoad', { text: o.brep, quality: S.quality });
      bodies.push(mkBody(Object.assign(base0, { sid: track(r.sid), mesh: r.mesh })));
    } else {
      const m = o.mesh;
      bodies.push(mkBody(Object.assign(base0, { mesh: { position: b64.dec(m.position, Float32Array), index: b64.dec(m.index, Uint32Array), groups: m.groups, normal: m.normal ? b64.dec(m.normal, Float32Array) : null, colors: m.colors ? b64.dec(m.colors, Float32Array) : null } })));
    }
  }
  if (!state.bodies.length) docName = json.name || stem(file.name);
  commit(Object.assign({}, state, { groups: state.groups.concat(groups), bodies: state.bodies.concat(bodies) }));
}

// ---------------- drag & drop, desktop app bridge ----------------
function wireIO() {
  $('fileIn').addEventListener('change', (e) => openFiles(e.target.files));
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; $('dropmask').hidden = false; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('dropmask').hidden = true; });
  window.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; $('dropmask').hidden = true; openFiles(e.dataTransfer.files); });
  const D = window.tdvDesktop;
  if (D && D.onOpenFiles) {
    D.onOpenFiles((list) => openFiles(list.map((f) => new File([f.data], f.name))));
    if (D.ready) D.ready();
  }
}

boot();
