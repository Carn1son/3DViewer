/* 3DViewer — squaring models to the axes: automatically after opening a file, and the "lay on a face" tool
   (click a flat face, then a plane XY / XZ / YZ or a flat face of another part). Same scope as app.js. */
/* global THREE */

// main directions of a set of bodies: the normals that carry the most flat area (opposite normals count together)
function dominantAxes(bodies) {
  const bins = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  bodies.forEach((bd) => {
    const P = bd.mesh.position, I = bd.mesh.index;
    if (!I || !I.length) return;
    const step = Math.max(3, Math.floor(I.length / 3 / 150000) * 3);
    for (let t = 0; t + 2 < I.length; t += step) {
      a.fromArray(P, I[t] * 3); b.fromArray(P, I[t + 1] * 3); c.fromArray(P, I[t + 2] * 3);
      n.subVectors(b, a).cross(c.clone().sub(a));
      const area = n.length() / 2;
      if (area < 1e-12) continue;
      n.normalize();
      if (n.x < -1e-9 || (Math.abs(n.x) <= 1e-9 && (n.y < -1e-9 || (Math.abs(n.y) <= 1e-9 && n.z < 0)))) n.negate();
      const k = Math.round(n.x * 60) + ',' + Math.round(n.y * 60) + ',' + Math.round(n.z * 60);
      let e = bins.get(k); if (!e) { e = { w: 0, v: new THREE.Vector3() }; bins.set(k, e); }
      e.w += area; e.v.addScaledVector(n, area);
    }
  });
  const list = Array.from(bins.values()).sort((p, q) => q.w - p.w);
  if (!list.length) return null;
  const n1 = list[0].v.clone().normalize();
  const second = list.find((e) => Math.abs(e.v.clone().normalize().dot(n1)) < 0.05);
  let n2;
  if (second) n2 = second.v.clone().normalize();
  else { n2 = Math.abs(n1.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0); }
  n2.addScaledVector(n1, -n2.dot(n1)).normalize();
  return { n1, n2, weight: list[0].w };
}
// the smallest rotation that puts n1 and n2 onto world axes
function squaringRotation(n1, n2) {
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const pick = (v, skip) => {
    let best = null, bd = -1;
    axes.forEach((ax, i) => { if (i === skip) return; const d = Math.abs(v.dot(ax)); if (d > bd) { bd = d; best = i; } });
    return [best, ax(best).multiplyScalar(Math.sign(v.dot(ax(best))) || 1)];
  };
  const ax = (i) => axes[i].clone();
  const [i1, a1] = pick(n1, -1);
  const [, a2] = pick(n2, i1);
  const n3 = n1.clone().cross(n2), a3 = a1.clone().cross(a2);
  const N = new THREE.Matrix4().makeBasis(n1, n2, n3), A = new THREE.Matrix4().makeBasis(a1, a2, a3);
  return A.multiply(N.transpose()); // R * n_i = a_i
}
function rotationAngle(m) { const e = m.elements; return Math.acos(clamp((e[0] + e[5] + e[10] - 1) / 2, -1, 1)); }
function boundsOf(bodies, m) {
  const box = new THREE.Box3(), v = new THREE.Vector3();
  bodies.forEach((bd) => {
    const P = bd.mesh.position, step = Math.max(3, Math.floor(P.length / 3 / 200000) * 3);
    for (let i = 0; i < P.length; i += step) { v.set(P[i], P[i + 1], P[i + 2]); if (m) v.applyMatrix4(m); box.expandByPoint(v); }
  });
  return box;
}
// square up and centre: rotation to the axes about the middle, then X/Y centred on the origin and the bottom on Z = 0
function alignMatrix(bodies, opts) {
  opts = opts || {};
  const box0 = boundsOf(bodies), ctr = box0.getCenter(new THREE.Vector3());
  let M = new THREE.Matrix4();
  if (opts.square !== false) {
    const d = dominantAxes(bodies);
    if (d) {
      const R = squaringRotation(d.n1, d.n2);
      if (rotationAngle(R) > THREE.MathUtils.degToRad(0.2)) {
        M = new THREE.Matrix4().makeTranslation(ctr.x, ctr.y, ctr.z).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-ctr.x, -ctr.y, -ctr.z));
      }
    }
  }
  if (opts.centre !== false) {
    const b = boundsOf(bodies, M), c = b.getCenter(new THREE.Vector3());
    M = new THREE.Matrix4().makeTranslation(-c.x, -c.y, -b.min.z).multiply(M);
  }
  return M;
}
function isIdentity(m) {
  const e = m.elements, I = new THREE.Matrix4().elements;
  return e.every((v, i) => Math.abs(v - I[i]) < 1e-7);
}
async function applyMatrix(bodies, M) {
  if (!bodies.length || isIdentity(M)) return false;
  const moved = await withBusy(t('working'), () => transformBodies(bodies, M));
  if (!moved) return false;
  const map = new Map(moved.map((b) => [b.id, b]));
  commit(Object.assign({}, state, { bodies: state.bodies.map((b) => map.get(b.id) || b) }));
  return true;
}
// after a file is opened: its bodies move together
async function autoAlign(bodies) {
  if (!S.autoAlign || !bodies.length) return false;
  const M = alignMatrix(bodies);
  const rot = rotationAngle(M) > 1e-4;
  const ok = await applyMatrix(bodies, M);
  if (ok) toast(t(rot ? 'alignedRot' : 'alignedCentre'), '', 5000);
  return ok;
}
// the bodies that move with a clicked body: the selection when it holds it, else the part from one file, else the body
function movingSet(id) {
  const ids = new Set(uniqBodies(sel).map((s) => s.b));
  if (ids.has(id) && ids.size > 1) return state.bodies.filter((b) => ids.has(b.id));
  const b = bodyById(id), g = groupById(b.group);
  if (g && g.file) return state.bodies.filter((x) => x.group === g.id);
  return [b];
}
async function alignSelected(centreOnly) {
  let bs = selBodies();
  if (!bs.length) bs = state.bodies.filter((b) => b.visible);
  if (!bs.length) { toast(t('noModel'), 'warn'); return; }
  const ok = await applyMatrix(bs, alignMatrix(bs, { square: !centreOnly }));
  toast(t(ok ? 'alignedDone' : 'alignedAlready'));
  fitView();
}

// ---------------- "lay on a face" tool ----------------
const MATE = { src: null };
function facePoint(b, fi) {
  const g = b.mesh.groups[fi], P = b.mesh.position, I = b.mesh.index;
  const c = new THREE.Vector3(); let n = 0;
  for (let t = g[0]; t < g[0] + g[1]; t++) { c.x += P[I[t] * 3]; c.y += P[I[t] * 3 + 1]; c.z += P[I[t] * 3 + 2]; n++; }
  return c.multiplyScalar(1 / Math.max(n, 1));
}
function mateReset() { MATE.src = null; if (tool === 'mate') { setSel([]); showHint(); } }
function mateClick(e) {
  const p = pickAt(e.clientX, e.clientY);
  if (!p || p.f == null) { if (MATE.src && !p) mateMenu(e.clientX, e.clientY); return; }
  const b = bodyById(p.b), n = faceNormal(b, p.f);
  if (!MATE.src) {
    if (!n) { toast(t('mateNotFlat'), 'warn'); return; }
    // the outward normal: the side the camera sees when it was clicked
    const toCam = new THREE.Vector3().subVectors(cam.position, p.point);
    if (n.dot(toCam) < 0) n.negate();
    MATE.src = { b: p.b, f: p.f, n, point: facePoint(b, p.f) };
    setSel([{ b: p.b, f: p.f }]);
    showHint();
    mateMenu(e.clientX, e.clientY);
    return;
  }
  if (p.b === MATE.src.b || movingSet(MATE.src.b).some((x) => x.id === p.b)) { MATE.src = null; mateClick(e); return; } // another face of the same part: start over
  if (!n) { toast(t('mateNotFlat'), 'warn'); return; }
  const toCam = new THREE.Vector3().subVectors(cam.position, p.point);
  if (n.dot(toCam) < 0) n.negate();
  layOn(n, facePoint(b, p.f), false);
}
function mateMenu(x, y) {
  showMenu(x, y, '<div class="ttl">' + esc(t('mateWhere')) + '</div>' +
    mi('xy', 'grid', t('mateXY'), '') + mi('xz', 'grid', t('mateXZ'), '') + mi('yz', 'grid', t('mateYZ'), '') + '<hr>' +
    mi('xyc', 'target', t('mateXYc'), '') + '<div class="ttl">' + esc(t('mateOrFace')) + '</div>',
  {
    xy: () => layOn(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), true),
    xz: () => layOn(new THREE.Vector3(0, -1, 0), new THREE.Vector3(), true),
    yz: () => layOn(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), true),
    xyc: () => layOn(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), true, true),
  });
}
// turn the part so the chosen face lies on the target plane (facing into it), square it up about that plane and press it on
async function layOn(targetN, targetP, worldPlane, centre) {
  const src = MATE.src; if (!src) return;
  const bodies = movingSet(src.b);
  const pivot = src.point.clone();
  const want = targetN.clone().normalize().negate(); // the face looks into the plane
  const R1 = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(src.n.clone().normalize(), want));
  let M = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(R1).multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  if (worldPlane) { // spin about the plane normal so the part's edges run along the axes
    const tmp = bodies.map((b) => Object.assign({}, b, { mesh: transformMesh(b.mesh, M) }));
    const d = dominantAxes(tmp);
    if (d) {
      const axisN = targetN.clone().normalize();
      const cand = [d.n1, d.n2, d.n1.clone().cross(d.n2)].map((v) => v.clone().addScaledVector(axisN, -v.dot(axisN))).filter((v) => v.length() > 0.2).sort((p, q) => q.length() - p.length());
      if (cand.length) {
        const v = cand[0].normalize();
        const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].filter((a) => Math.abs(a.dot(axisN)) < 0.5);
        let best = axes[0], bd = -1; axes.forEach((a) => { const dd = Math.abs(a.dot(v)); if (dd > bd) { bd = dd; best = a; } });
        const target = best.clone().multiplyScalar(Math.sign(best.dot(v)) || 1);
        const ang = Math.atan2(v.clone().cross(target).dot(axisN), v.dot(target));
        if (Math.abs(ang) > 1e-5) {
          const p2 = pivot.clone().applyMatrix4(M);
          const R2 = new THREE.Matrix4().makeRotationAxis(axisN, ang);
          M = new THREE.Matrix4().makeTranslation(p2.x, p2.y, p2.z).multiply(R2).multiply(new THREE.Matrix4().makeTranslation(-p2.x, -p2.y, -p2.z)).multiply(M);
        }
      }
    }
  }
  // press onto the plane
  const p3 = pivot.clone().applyMatrix4(M), n = targetN.clone().normalize();
  const dist = n.dot(new THREE.Vector3().subVectors(targetP, p3));
  M = new THREE.Matrix4().makeTranslation(n.x * dist, n.y * dist, n.z * dist).multiply(M);
  if (centre) {
    const b = boundsOf(bodies, M), c = b.getCenter(new THREE.Vector3());
    M = new THREE.Matrix4().makeTranslation(-c.x, -c.y, 0).multiply(M);
  }
  MATE.src = null;
  const ok = await applyMatrix(bodies, M);
  setSel(bodies.map((b) => ({ b: b.id, f: null })));
  showHint();
  if (ok) toast(t('mateDone'));
}
