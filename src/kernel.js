/* 3DViewer CAD kernel: runs in a Web Worker (or in node for tests).
   OpenCascade (replicad build) keeps the exact B-rep of every body; occt-import-js reads STEP/IGES colours and names.
   The page never sees OCCT objects: it gets meshes (per-face triangle groups) and sends commands by body id. */
/* global replicad */
function createKernel(R, oc, occti) {
  'use strict';
  const shapes = new Map();
  let nextSid = 1;
  const put = (s) => { const id = nextSid++; shapes.set(id, s); return id; };
  const get0 = (id) => { const s = shapes.get(id); if (!s) throw new Error('shape ' + id + ' not found'); return s; };
  // replicad operations may delete their inputs: every command works on a fresh handle, stored shapes stay intact (undo)
  const get = (id) => get0(id).clone();
  const QUAL = { low: [0.004, 0.5], mid: [0.0015, 0.3], high: [0.0005, 0.15] };

  // ---------- colours ----------
  const lin2s = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const hex2 = (v) => ('0' + Math.max(0, Math.min(255, Math.round(v * 255))).toString(16)).slice(-2);
  const linToHex = (rgb) => '#' + hex2(lin2s(rgb[0])) + hex2(lin2s(rgb[1])) + hex2(lin2s(rgb[2]));
  function rgba(hex, alpha) {
    const h = String(hex || '#888888').replace('#', '');
    const n = h.length === 3 ? h.replace(/(.)/g, '$1$1') : h;
    const c = [0, 2, 4].map((i) => s2lin(parseInt(n.slice(i, i + 2), 16) / 255));
    return new oc.Quantity_ColorRGBA(c[0], c[1], c[2], alpha == null ? 1 : alpha);
  }

  // ---------- geometry helpers ----------
  function bbox(shape) {
    try { const b = shape.boundingBox.bounds; return b; } catch (e) { return [[0, 0, 0], [1, 1, 1]]; }
  }
  function diag(b) { return Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]) || 1; }
  function meshOf(shape, quality) {
    const q = QUAL[quality] || QUAL.mid;
    const b = bbox(shape), d = diag(b);
    const tol = Math.max(d * q[0], 1e-4);
    const m = shape.mesh({ tolerance: tol, angularTolerance: q[1] });
    let e = { lines: [], edgeGroups: [] };
    try { e = shape.meshEdges({ tolerance: tol, angularTolerance: q[1] }); } catch (err) { /* no edges (mesh body) */ }
    return {
      position: Float32Array.from(m.vertices), normal: Float32Array.from(m.normals), index: Uint32Array.from(m.triangles),
      groups: m.faceGroups.map((g, i) => [g.start, g.count, i]), edges: Float32Array.from(e.lines), edgeGroups: (e.edgeGroups || []).map((g) => [g.start, g.count]),
      bbox: b,
    };
  }
  function transferables(mesh) { return [mesh.position.buffer, mesh.normal.buffer, mesh.index.buffer, mesh.edges.buffer]; }
  function cast(s) { return R.cast(s); }
  function explore(shape, what, avoid) {
    const out = [];
    const T = oc.TopAbs_ShapeEnum;
    const ex = avoid ? new oc.TopExp_Explorer(shape, T[what], T[avoid]) : new oc.TopExp_Explorer(shape, T[what], T.TopAbs_SHAPE);
    for (; ex.More(); ex.Next()) out.push(ex.Current());
    ex.delete();
    return out;
  }
  // a compound from a file -> separate bodies (solids, then free shells, then free faces)
  function splitBodies(shape) {
    const raw = shape.wrapped || shape;
    let parts = explore(raw, 'TopAbs_SOLID');
    parts = parts.concat(explore(raw, 'TopAbs_SHELL', 'TopAbs_SOLID'));
    const freeFaces = explore(raw, 'TopAbs_FACE', 'TopAbs_SHELL');
    if (freeFaces.length) parts.push(R.makeCompound(freeFaces.map((f) => cast(f))).wrapped);
    if (!parts.length) parts = [raw];
    return parts.map((p) => cast(p));
  }

  // face centroids for matching colours between the two STEP readers
  function faceStats(pos, idx, start, count) {
    let ax = 0, ay = 0, az = 0, A = 0;
    for (let t = start; t < start + count; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const ar = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      ax += ar * (pos[a] + pos[b] + pos[c]) / 3; ay += ar * (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3; az += ar * (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3; A += ar;
    }
    if (A <= 0) { const a = idx[start] * 3; return [pos[a] || 0, pos[a + 1] || 0, pos[a + 2] || 0, 0]; }
    return [ax / A, ay / A, az / A, A];
  }

  // occt-import-js read: per-face colours + part names, used to colour the exact B-rep we read with OCCT
  function occtFaces(res) {
    const faces = [];
    res.meshes.forEach((m, mi) => {
      const pos = m.attributes.position.array, idx = m.index.array;
      const mc = m.color ? linToHex(m.color) : null;
      const list = m.brep_faces && m.brep_faces.length ? m.brep_faces : [{ first: 0, last: idx.length / 3 - 1, color: null }];
      list.forEach((f) => {
        const st = faceStats(pos, idx, f.first * 3, (f.last - f.first + 1) * 3);
        faces.push({ c: st, color: f.color ? linToHex(f.color) : mc, mesh: mi });
      });
    });
    return faces;
  }
  function meshNames(res) {
    const names = res.meshes.map((m) => m.name || '');
    // nodes carry the product names; a mesh without its own name takes its node's
    (function walk(n) {
      (n.meshes || []).forEach((mi) => { if (!names[mi] && n.name) names[mi] = n.name; });
      (n.children || []).forEach(walk);
    })(res.root || {});
    return names;
  }
  function matchColours(bodies, ofaces, d) {
    const cell = d / 150, grid = new Map();
    const key = (x, y, z) => Math.floor(x / cell) + ',' + Math.floor(y / cell) + ',' + Math.floor(z / cell);
    ofaces.forEach((f, i) => { const k = key(f.c[0], f.c[1], f.c[2]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    const find = (c) => {
      const gx = Math.floor(c[0] / cell), gy = Math.floor(c[1] / cell), gz = Math.floor(c[2] / cell);
      let best = -1, bd = Infinity;
      for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (let z = gz - 1; z <= gz + 1; z++) {
        const l = grid.get(x + ',' + y + ',' + z); if (!l) continue;
        for (const i of l) {
          const f = ofaces[i];
          const dist = Math.hypot(f.c[0] - c[0], f.c[1] - c[1], f.c[2] - c[2]);
          const ar = c[3] > 0 && f.c[3] > 0 ? Math.abs(Math.log(c[3] / f.c[3])) : 0;
          const score = dist + ar * cell * 0.5;
          if (score < bd) { bd = score; best = i; }
        }
      }
      return best;
    };
    bodies.forEach((b) => {
      const m = b.mesh, colours = [], votes = new Map(), areas = [];
      m.groups.forEach((g) => {
        const st = faceStats(m.position, m.index, g[0], g[1]);
        const i = find(st);
        colours[g[2]] = i >= 0 ? ofaces[i].color : null;
        areas[g[2]] = st[3];
        if (i >= 0) votes.set(ofaces[i].mesh, (votes.get(ofaces[i].mesh) || 0) + 1);
      });
      // body colour = the colour covering the largest area; the rest stay as face colours
      const cnt = new Map();
      colours.forEach((c, fi) => { if (c) cnt.set(c, (cnt.get(c) || 0) + (areas[fi] || 0)); });
      let bc = null, bn = 0; cnt.forEach((n, c) => { if (n > bn) { bn = n; bc = c; } });
      b.color = bc;
      b.faceColors = {};
      colours.forEach((c, fi) => { if (c && c !== bc) b.faceColors[fi] = c; });
      let mv = -1, mn = 0; votes.forEach((n, mi) => { if (n > mn) { mn = n; mv = mi; } });
      b.meshVote = mv;
    });
  }

  function writeIn(bytes, name) { oc.FS.writeFile('/' + name, bytes); return '/' + name; }
  function unlink(p) { try { oc.FS.unlink(p); } catch (e) { /* gone */ } }

  // ---------- commands ----------
  const H = {};

  H.importStep = ({ bytes, quality }) => {
    const u8 = new Uint8Array(bytes);
    oc.Interface_Static.SetCVal('xstep.cascade.unit', 'MM');
    const p = writeIn(u8, 'in.step');
    const reader = new oc.STEPControl_Reader();
    const st = reader.ReadFile(p);
    unlink(p);
    if (st !== oc.IFSelect_ReturnStatus.IFSelect_RetDone && st !== 1) { reader.delete(); throw new Error('STEP: file not read'); }
    reader.TransferRoots(new oc.Message_ProgressRange());
    const whole = cast(reader.OneShape());
    reader.delete();
    const parts = splitBodies(whole);
    const bodies = parts.map((s) => ({ shape: s, mesh: meshOf(s, quality) }));
    // colours and names from occt-import-js
    let names = [];
    try {
      const res = occti.ReadStepFile(u8, { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.002, angularDeflection: 0.5 });
      if (res && res.success) {
        const bb = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
        bodies.forEach((b) => { for (let i = 0; i < 3; i++) { bb[0][i] = Math.min(bb[0][i], b.mesh.bbox[0][i]); bb[1][i] = Math.max(bb[1][i], b.mesh.bbox[1][i]); } });
        matchColours(bodies, occtFaces(res), diag(bb));
        names = meshNames(res);
      }
    } catch (e) { /* colours are optional */ }
    const used = new Map();
    const out = bodies.map((b, i) => {
      let name = (b.meshVote >= 0 && names[b.meshVote]) || ('Body ' + (i + 1));
      const n = (used.get(name) || 0) + 1; used.set(name, n);
      if (n > 1) name += ' (' + n + ')';
      return { sid: put(b.shape), name, color: b.color || null, faceColors: b.faceColors || {}, mesh: b.mesh };
    });
    return { result: { bodies: out }, transfer: out.flatMap((b) => transferables(b.mesh)) };
  };

  // IGES (and STEP if OCCT fails): mesh-only bodies, colours per face
  H.importMeshOcct = ({ bytes, kind }) => {
    const u8 = new Uint8Array(bytes);
    const prm = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.4 };
    const res = kind === 'iges' ? occti.ReadIgesFile(u8, prm) : kind === 'brep' ? occti.ReadBrepFile(u8, prm) : occti.ReadStepFile(u8, prm);
    if (!res || !res.success) throw new Error('file not read');
    const names = meshNames(res);
    const out = res.meshes.map((m, i) => {
      const position = Float32Array.from(m.attributes.position.array);
      const normal = m.attributes.normal ? Float32Array.from(m.attributes.normal.array) : new Float32Array(0);
      const index = Uint32Array.from(m.index.array);
      const mc = m.color ? linToHex(m.color) : null;
      const faces = m.brep_faces && m.brep_faces.length ? m.brep_faces : [{ first: 0, last: index.length / 3 - 1, color: null }];
      const groups = faces.map((f, fi) => [f.first * 3, (f.last - f.first + 1) * 3, fi]);
      const faceColors = {};
      faces.forEach((f, fi) => { if (f.color) { const h = linToHex(f.color); if (h !== mc) faceColors[fi] = h; } });
      return { name: names[i] || ('Body ' + (i + 1)), color: mc, faceColors, mesh: { position, normal, index, groups, edges: new Float32Array(0) } };
    });
    return { result: { bodies: out }, transfer: out.flatMap((b) => [b.mesh.position.buffer, b.mesh.normal.buffer, b.mesh.index.buffer]) };
  };

  H.importBrep = ({ text, quality }) => {
    const s = cast(oc.BRepToolsWrapper.Read(text));
    const parts = splitBodies(s);
    const out = parts.map((p, i) => ({ sid: put(p), name: 'Body ' + (i + 1), color: null, faceColors: {}, mesh: meshOf(p, quality) }));
    return { result: { bodies: out }, transfer: out.flatMap((b) => transferables(b.mesh)) };
  };

  function located(shape, at) {
    if (!at) return shape;
    const [x, y, z] = at;
    return x || y || z ? shape.translate([x || 0, y || 0, z || 0]) : shape;
  }

  H.primitive = ({ type, p, at, quality }) => {
    let s;
    const n = (k, d) => { const v = Number(p[k]); return isFinite(v) && v > 0 ? v : d; };
    switch (type) {
      case 'box': {
        const w = n('w', 10), d = n('d', 10), h = n('h', 10);
        s = R.makeBox([-w / 2, -d / 2, 0], [w / 2, d / 2, h]);
        break;
      }
      case 'rbox': { // rounded-corner plate: the usual body of a component
        const w = n('w', 10), d = n('d', 6), h = n('h', 2), r = Math.min(Number(p.r) || 0, w / 2 - 1e-3, d / 2 - 1e-3);
        s = (r > 0 ? R.drawRoundedRectangle(w, d, r) : R.drawRectangle(w, d)).sketchOnPlane('XY').extrude(h);
        break;
      }
      case 'cyl': s = R.makeCylinder(n('r', 5), n('h', 10), [0, 0, 0], [0, 0, 1]); break;
      case 'tube': {
        const ro = n('r', 5), ri = Math.min(Number(p.ri) || 0, ro - 1e-3), h = n('h', 10);
        s = R.makeCylinder(ro, h, [0, 0, 0], [0, 0, 1]);
        if (ri > 0) s = s.cut(R.makeCylinder(ri, h + 2, [0, 0, -1], [0, 0, 1]));
        break;
      }
      case 'sphere': s = R.makeSphere(n('r', 5)); break;
      case 'cone': {
        const r1 = n('r1', 5), r2 = Math.max(0, Number(p.r2) || 0), h = n('h', 10);
        let pen = R.draw([0, 0]).lineTo([r1, 0]);
        pen = r2 > 0 ? pen.lineTo([r2, h]).lineTo([0, h]) : pen.lineTo([0, h]);
        s = pen.close().sketchOnPlane('XZ').revolve([0, 0, 1], { origin: [0, 0, 0] });
        break;
      }
      case 'torus': {
        const mk = new oc.BRepPrimAPI_MakeTorus(n('R', 10), n('r', 2));
        s = cast(mk.Shape()); mk.delete(); break;
      }
      case 'prism': s = R.drawPolysides(n('r', 5), Math.max(3, Math.round(n('n', 6)))).sketchOnPlane('XY').extrude(n('h', 10)); break;
      default: throw new Error('unknown primitive ' + type);
    }
    s = located(s, at);
    const mesh = meshOf(s, quality);
    return { result: { sid: put(s), mesh }, transfer: transferables(mesh) };
  };

  function trsfFromMatrix(e) { // three.js Matrix4.elements (column-major)
    const t = new oc.gp_Trsf();
    t.SetValues(e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]);
    return t;
  }
  function applyTrsf(shape, t) {
    const op = new oc.BRepBuilderAPI_Transform(shape.wrapped, t, true, false);
    const r = cast(op.Shape()); op.delete(); return r;
  }

  H.transform = ({ sid, matrix, mirror, quality }) => {
    const s = get(sid);
    let t;
    if (mirror) {
      t = new oc.gp_Trsf();
      const ax = new oc.gp_Ax2(new oc.gp_Pnt(mirror.p[0], mirror.p[1], mirror.p[2]), new oc.gp_Dir(mirror.n[0], mirror.n[1], mirror.n[2]));
      t.SetMirror(ax);
    } else t = trsfFromMatrix(matrix);
    const r = applyTrsf(s, t);
    t.delete();
    const mesh = meshOf(r, quality);
    return { result: { sid: put(r), mesh }, transfer: transferables(mesh) };
  };

  H.boolean = ({ op, a, b, quality }) => {
    let s = get(a);
    for (const id of b) {
      const t = get(id);
      s = op === 'fuse' ? s.fuse(t) : op === 'cut' ? s.cut(t) : s.intersect(t);
    }
    if (op === 'fuse') { try { s = s.simplify(); } catch (e) { /* keep as is */ } }
    const mesh = meshOf(s, quality);
    if (!mesh.index.length) throw new Error('empty result');
    return { result: { sid: put(s), mesh }, transfer: transferables(mesh) };
  };

  function edgesOfFaces(shape, faceIdx) {
    const faces = shape.faces;
    const list = [];
    faceIdx.forEach((i) => { if (faces[i]) faces[i].edges.forEach((e) => list.push(e.wrapped)); });
    return list;
  }
  H.edgeOp = ({ op, sid, size, mode, faces, quality }) => {
    const s = get(sid);
    let cfg = size;
    if (mode === 'faces' && faces && faces.length) {
      const sel = edgesOfFaces(s, faces);
      cfg = (e) => (sel.some((w) => w.IsSame(e.wrapped)) ? size : null);
    } else if (mode === 'vertical') cfg = (e) => { try { return e.geomType === 'LINE' && Math.abs(e.tangentAt(0.5).z) > 0.999 ? size : null; } catch (er) { return null; } };
    else if (mode === 'horizontal') cfg = (e) => { try { const z = e.tangentAt(0.5).z; return Math.abs(z) < 1e-3 ? size : null; } catch (er) { return null; } };
    const r = op === 'chamfer' ? s.chamfer(cfg) : s.fillet(cfg);
    const mesh = meshOf(r, quality);
    return { result: { sid: put(r), mesh }, transfer: transferables(mesh) };
  };

  H.remesh = ({ sids, quality }) => {
    const out = sids.map((id) => ({ sid: id, mesh: meshOf(get0(id), quality) }));
    return { result: out, transfer: out.flatMap((o) => transferables(o.mesh)) };
  };

  H.props = ({ sid }) => {
    const s = get0(sid);
    let volume = null, area = null;
    try { volume = R.measureVolume(s); } catch (e) { /* not a solid */ }
    try { area = R.measureArea(s); } catch (e) { /* no faces */ }
    return { result: { volume, area, faces: s.faces.length, edges: s.edges.length, bbox: bbox(s) } };
  };

  // triangle soup -> OCCT shell (via the STL reader, coplanar triangles merged into faces)
  function stlBytes(pos, idx, start, count) {
    const n = count / 3, buf = new ArrayBuffer(84 + n * 50), v = new DataView(buf);
    v.setUint32(80, n, true);
    let o = 84;
    for (let t = start; t < start + count; t += 3) {
      o += 12;
      for (let k = 0; k < 3; k++) { const a = idx[t + k] * 3; v.setFloat32(o, pos[a], true); v.setFloat32(o + 4, pos[a + 1], true); v.setFloat32(o + 8, pos[a + 2], true); o += 12; }
      o += 2;
    }
    return new Uint8Array(buf);
  }
  function meshToShape(pos, idx, start, count, solid) {
    const p = writeIn(stlBytes(pos, idx, start, count), 'm.stl');
    const reader = new oc.StlAPI_Reader();
    const sh = new oc.TopoDS_Shell();
    const ok = reader.Read(sh, p);
    unlink(p); reader.delete();
    if (!ok) throw new Error('mesh conversion failed');
    let shape = sh;
    try { // stitch shared edges so the result is one connected shell
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let t = start; t < start + count; t++) { const a = idx[t] * 3; for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pos[a + k]); mx[k] = Math.max(mx[k], pos[a + k]); } }
      const d = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
      const sew = new oc.BRepBuilderAPI_Sewing(d * 1e-6, true, true, true, false);
      sew.Add(shape); sew.Perform(new oc.Message_ProgressRange());
      shape = sew.SewedShape(); sew.delete();
    } catch (e) { /* keep as read */ }
    try {
      const up = new oc.ShapeUpgrade_UnifySameDomain(shape, true, true, false); up.Build(); shape = up.Shape(); up.delete();
    } catch (e) { /* keep triangles */ }
    if (solid) {
      const shells = explore(shape, 'TopAbs_SHELL');
      if (shells.length === 1) {
        try {
          const ms = new oc.BRepBuilderAPI_MakeSolid(); ms.Add(oc.TopoDS.Shell(shells[0]));
          const so = ms.Solid(); ms.delete();
          const res = cast(so);
          if (R.measureVolume(res) > 0) return res;
        } catch (e) { /* open mesh: stay a shell */ }
      }
    }
    return cast(shape);
  }
  H.meshToBody = ({ position, index, quality }) => {
    const s = meshToShape(position, index, 0, index.length, true);
    const mesh = meshOf(s, quality);
    return { result: { sid: put(s), mesh }, transfer: transferables(mesh) };
  };

  // ---------- export ----------
  const ext = (s) => new oc.TCollection_ExtendedString(s, true);
  // items: [{name, group, color, alpha, faceColors, sid | mesh:{position,index,groups}}]
  function bodyShape(it) {
    if (it.sid) return { shape: get(it.sid), fc: it.faceColors || {} };
    // mesh body: one shell (a solid when closed); face colours carried over by nearest source triangle
    const m = it.mesh, src = it.faceColors || {};
    const shape = meshToShape(m.position, m.index, 0, m.index.length, true);
    const fc = {};
    if (Object.keys(src).length) {
      const tri = []; // source triangle centroids with their face group
      m.groups.forEach((g) => { for (let t = g[0]; t < g[0] + g[1]; t += 3) tri.push([faceStats(m.position, m.index, t, 3), g[2]]); });
      const out = meshOf(shape, 'low');
      out.groups.forEach((g, fi) => {
        const c = faceStats(out.position, out.index, g[0], Math.min(3, g[1]));
        let best = null, bd = Infinity;
        for (const [st, gi] of tri) { const d = (st[0] - c[0]) ** 2 + (st[1] - c[1]) ** 2 + (st[2] - c[2]) ** 2; if (d < bd) { bd = d; best = gi; } }
        if (best != null && src[best]) fc[fi] = src[best];
      });
    }
    return { shape, fc };
  }
  function colourFaces(tool, ctool, label, b, it) {
    const CS = oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf;
    const keys = Object.keys(b.fc);
    if (!keys.length) return;
    const faces = b.shape.faces;
    keys.forEach((k) => {
      const f = faces[Number(k)]; if (!f) return;
      const l = tool.AddSubShape(label, f.wrapped);
      if (l && !l.IsNull()) ctool.SetColor(l, rgba(b.fc[k], it.alpha), CS);
    });
  }

  H.exportStep = ({ items, schema, structure, docName }) => {
    oc.XCAFDoc_ShapeTool.SetAutoNaming(false);
    const doc = new oc.TDocStd_Document(ext('XmlOcaf'));
    const main = doc.Main();
    const tool = oc.XCAFDoc_DocumentTool.ShapeTool(main);
    const ctool = oc.XCAFDoc_DocumentTool.ColorTool(main);
    const CS = oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf;
    const built = items.map((it) => ({ it, b: bodyShape(it) }));
    if (structure === 'part') {
      // one part: all bodies in one compound, colours on the bodies and faces
      const comp = built.length === 1 ? built[0].b.shape : R.makeCompound(built.map((x) => x.b.shape.clone()));
      const label = tool.NewShape(); tool.SetShape(label, comp.wrapped);
      oc.TDataStd_Name.Set(label, ext(docName || 'Part'));
      built.forEach(({ it, b }) => {
        let l = label;
        if (built.length > 1) { l = tool.AddSubShape(label, b.shape.wrapped); if (!l || l.IsNull()) l = null; }
        if (l && it.color) ctool.SetColor(l, rgba(it.color, it.alpha), CS);
        if (l && built.length > 1 && it.name) oc.TDataStd_Name.Set(l, ext(it.name));
        colourFaces(tool, ctool, label, b, it); // faces hang off the part itself: a sub-shape label cannot take sub-shapes
      });
    } else {
      // assembly: one component per group, one part per body
      const groups = new Map();
      built.forEach((x) => { const g = x.it.group || docName || 'Assembly'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); });
      const top = groups.size > 1 ? tool.NewShape() : null;
      if (top) oc.TDataStd_Name.Set(top, ext(docName || 'Assembly'));
      groups.forEach((list, gname) => {
        const asm = tool.NewShape();
        oc.TDataStd_Name.Set(asm, ext(gname));
        list.forEach(({ it, b }) => {
          const part = tool.NewShape(); tool.SetShape(part, b.shape.wrapped);
          oc.TDataStd_Name.Set(part, ext(it.name || 'Body'));
          if (it.color) ctool.SetColor(part, rgba(it.color, it.alpha), CS);
          colourFaces(tool, ctool, part, b, it);
          tool.AddComponent(asm, part, new oc.TopLoc_Location());
        });
        if (top) tool.AddComponent(top, asm, new oc.TopLoc_Location());
      });
    }
    tool.UpdateAssemblies();
    oc.Interface_Static.SetCVal('write.step.unit', 'MM');
    oc.Interface_Static.SetCVal('xstep.cascade.unit', 'MM');
    oc.Interface_Static.SetIVal('write.step.schema', schema || 4);
    oc.Interface_Static.SetIVal('write.surfacecurve.mode', 1);
    oc.Interface_Static.SetIVal('write.precision.mode', 0);
    oc.Interface_Static.SetCVal('write.step.product.name', docName || '3DViewer');
    const session = new oc.XSControl_WorkSession();
    const w = new oc.STEPCAFControl_Writer(session, false);
    w.SetColorMode(true); w.SetNameMode(true); w.SetLayerMode(true);
    const ok = w.Perform(doc, '/out.step', new oc.Message_ProgressRange());
    w.delete(); doc.delete();
    if (!ok) throw new Error('STEP export failed');
    const data = oc.FS.readFile('/out.step'); unlink('/out.step');
    const bytes = data.slice().buffer;
    return { result: { bytes }, transfer: [bytes] };
  };

  H.exportBrep = ({ items }) => {
    const shp = items.map((it) => bodyShape(it).shape);
    const comp = shp.length === 1 ? shp[0] : R.makeCompound(shp.map((x) => x.clone()));
    return { result: { text: oc.BRepToolsWrapper.Write(comp.wrapped) } };
  };
  H.brepOf = ({ sid }) => ({ result: { text: oc.BRepToolsWrapper.Write(get0(sid).wrapped) } });
  H.brepLoad = ({ text, quality }) => {
    const s = cast(oc.BRepToolsWrapper.Read(text));
    const mesh = meshOf(s, quality);
    return { result: { sid: put(s), mesh }, transfer: transferables(mesh) };
  };


  // ---------- sketch -> solid ----------
  // loops: {t:'rect',x,y,w,h} | {t:'circle',x,y,r} | {t:'poly',x,y,r,n,a} | {t:'path',pts:[[x,y]...],arcs:{i:[mx,my]}}; hole:true cuts
  function loopDrawing(L) {
    let d;
    if (L.t === 'rect') d = R.drawRectangle(Math.abs(L.w), Math.abs(L.h)).translate(L.x + L.w / 2, L.y + L.h / 2);
    else if (L.t === 'circle') d = R.drawCircle(L.r).translate(L.x, L.y);
    else if (L.t === 'poly') { d = R.drawPolysides(L.r, Math.max(3, Math.round(L.n))); if (L.a) d = d.rotate(L.a, [0, 0]); d = d.translate(L.x, L.y); }
    else {
      const P = L.pts, arcs = L.arcs || {};
      let pen = R.draw(P[0]);
      for (let i = 1; i < P.length; i++) {
        if (arcs[i]) pen = pen.threePointsArcTo(P[i], arcs[i]); else pen = pen.lineTo(P[i]);
      }
      if (arcs.close) d = pen.threePointsArcTo(P[0], arcs.close).done();
      else d = pen.close();
    }
    return d;
  }
  function vec(a) { return [a[0], a[1], a[2]]; }
  H.sketchSolid = ({ plane, loops, op, dist, dir, axis, angle, quality }) => {
    if (!loops.length) throw new Error('empty sketch');
    let draw = null;
    loops.filter((l) => !l.hole).forEach((l) => { const d = loopDrawing(l); draw = draw ? draw.fuse(d) : d; });
    if (!draw) throw new Error('no outer contour');
    loops.filter((l) => l.hole).forEach((l) => { draw = draw.cut(loopDrawing(l)); });
    const n = plane.n, D = Number(dist) || 10;
    let o = vec(plane.o);
    let s;
    if (op === 'revolve') {
      const pl = new R.Plane(o, vec(plane.x), vec(n));
      const ax = axis === 'x' ? plane.x : [n[1] * plane.x[2] - n[2] * plane.x[1], n[2] * plane.x[0] - n[0] * plane.x[2], n[0] * plane.x[1] - n[1] * plane.x[0]];
      s = draw.sketchOnPlane(pl).revolve(vec(ax), { origin: o, angle: Number(angle) || 360 });
    } else {
      if (dir === 'both') o = [o[0] - n[0] * D / 2, o[1] - n[1] * D / 2, o[2] - n[2] * D / 2];
      const pl = new R.Plane(o, vec(plane.x), vec(n));
      const sk = draw.sketchOnPlane(pl);
      s = dir === 'reverse' ? sk.extrude(D, { extrusionDirection: [-n[0], -n[1], -n[2]] }) : sk.extrude(D);
    }
    const mesh = meshOf(s, quality);
    return { result: { sid: put(s), mesh }, transfer: transferables(mesh) };
  };

  // plane of a planar face (for sketching on it): origin = face centre, normal outward
  H.facePlane = ({ sid, face }) => {
    const f = get0(sid).faces[face];
    if (!f) throw new Error('face not found');
    if (f.geomType !== 'PLANE') return { result: { planar: false } };
    const c = f.center, nv = f.normalAt(c);
    const n = [nv.x, nv.y, nv.z];
    // x direction: world X projected on the plane, or world Y if the face looks along X
    let x = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
    const k = x[0] * n[0] + x[1] * n[1] + x[2] * n[2];
    x = [x[0] - k * n[0], x[1] - k * n[1], x[2] - k * n[2]];
    const l = Math.hypot(x[0], x[1], x[2]); x = x.map((v) => v / l);
    return { result: { planar: true, o: [c.x, c.y, c.z], n, x } };
  };

  // push/pull a planar face: positive adds material, negative removes it
  H.faceExtrude = ({ sid, face, dist, quality }) => {
    const s = get(sid);
    const f = s.faces[face];
    if (!f) throw new Error('face not found');
    const nv = f.normalAt(f.center);
    const d = Number(dist) || 1;
    const prism = R.basicFaceExtrusion(f, new R.Vector([nv.x * d, nv.y * d, nv.z * d]));
    let r = d > 0 ? s.fuse(prism) : s.cut(prism);
    try { r = r.simplify(); } catch (e) { /* keep */ }
    const mesh = meshOf(r, quality);
    return { result: { sid: put(r), mesh }, transfer: transferables(mesh) };
  };

  H.free = ({ sids }) => {
    sids.forEach((id) => { const s = shapes.get(id); if (s) { shapes.delete(id); try { s.delete(); } catch (e) { /* already freed */ } } });
    return { result: true };
  };

  return H;
}
if (typeof module !== 'undefined') module.exports = createKernel;
