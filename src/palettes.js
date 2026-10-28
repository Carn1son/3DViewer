/* 3DViewer — saved palettes: named sets of looks (colour, metal, roughness, opacity) kept in this app.
   The looks used while painting are remembered; after saving a project or exporting, the app offers to keep them as a palette. */

const PAL = { list: [], used: [], declined: new Set() };
try { PAL.list = JSON.parse(localStorage.getItem('tdv.palettes') || '[]') || []; } catch (e) { PAL.list = []; }
function palSave() { try { localStorage.setItem('tdv.palettes', JSON.stringify(PAL.list)); } catch (e) { /* no storage */ } }
const lookKey = (l) => String(l.color).toLowerCase() + '|' + (+l.metal || 0).toFixed(2) + '|' + (+(l.rough == null ? 0.5 : l.rough)).toFixed(2) + '|' + (+(l.alpha == null ? 1 : l.alpha)).toFixed(2);
const cleanLook = (l) => ({ color: String(l.color).toLowerCase(), metal: +l.metal || 0, rough: l.rough == null ? 0.5 : +l.rough, alpha: l.alpha == null ? 1 : +l.alpha });
const setKey = (looks) => looks.map(lookKey).sort().join(';');

// remember a look applied in this session (paint, paste, apply)
function palNoteUsed(look) {
  const k = lookKey(look);
  if (!PAL.used.some((l) => lookKey(l) === k)) PAL.used.push(cleanLook(look));
}
// the looks on the model now (body and face colours with the body's material)
function sceneLooks() {
  const seen = new Map();
  state.bodies.forEach((b) => {
    const add = (c) => { const l = cleanLook({ color: c, metal: b.metal, rough: b.rough, alpha: b.alpha }); seen.set(lookKey(l), l); };
    add(bodyColor(b)); Object.values(b.faceColors || {}).forEach(add);
  });
  return Array.from(seen.values());
}

// ---------- the "My palettes" block in the Appearance pane ----------
function renderPalettes() {
  const el = $('palBox'); if (!el) return;
  let h = '';
  if (!PAL.list.length) h += '<span class="note">' + esc(t('palEmpty')) + '</span>';
  PAL.list.forEach((p, i) => {
    h += '<div class="pal" data-pal="' + i + '"><div class="palh"><b title="' + esc(p.name) + '">' + esc(p.name) + '</b><span class="note">' + p.looks.length + '</span>' +
      '<button class="eye" data-pa="add" title="' + esc(t('palAddCur')) + '">' + IC.svg('plus') + '</button>' +
      '<button class="eye" data-pa="menu" title="' + esc(t('palMenu')) + '">' + IC.svg('dots') + '</button></div><div class="palette">' +
      p.looks.map((l, j) => '<button class="chipc" data-pl="' + j + '" title="' + esc((l.name ? l.name + ' · ' : '') + l.color.toUpperCase()) + '" style="' + swStyle(l) + '"></button>').join('') + '</div></div>';
  });
  h += '<div class="btnrow"><button class="btn sm" id="palNew" data-ic="plus"><span>' + esc(t('palFromScene')) + '</span></button>' +
    '<button class="btn sm" id="palImport" data-ic="folder"><span>' + esc(t('palImport')) + '</span></button></div>';
  el.innerHTML = h;
  applyStatic(el);
  el.querySelectorAll('[data-pal]').forEach((box) => {
    const i = Number(box.dataset.pal), p = PAL.list[i];
    box.querySelectorAll('[data-pl]').forEach((c) => {
      const l = p.looks[Number(c.dataset.pl)];
      c.addEventListener('click', () => { setCur(l, true); if (sel.length && tool !== 'paint') toast(t('libHint')); });
      c.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, '<div class="ttl">' + esc(l.color.toUpperCase()) + '</div>' + mi('apply', 'brush', t('applyToSel'), '', { dis: !sel.length }) + mi('cur', 'pipette', t('takeAsCurrent'), '') + '<hr>' + mi('del', 'trash', t('palRemoveColour'), '', { bad: true }), {
          apply: () => paint(sel, l, sel.some((s) => s.f != null) ? 'face' : 'body'),
          cur: () => setCur(l, true),
          del: () => { p.looks.splice(Number(c.dataset.pl), 1); palSave(); renderPalettes(); },
        });
      });
    });
    box.querySelector('[data-pa=add]').addEventListener('click', () => {
      if (p.looks.some((l) => lookKey(l) === lookKey(cur))) { toast(t('palHasColour')); return; }
      p.looks.push(cleanLook(cur)); palSave(); renderPalettes(); toast(t('palAdded', p.name));
    });
    box.querySelector('[data-pa=menu]').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(r.left - 180, r.bottom + 4, '<div class="ttl">' + esc(p.name) + '</div>' +
        mi('paint', 'brush', t('palPaintAll'), '', { dis: !sel.length }) + mi('ren', 'edit', t('rename'), '') + mi('exp', 'download', t('palExport'), '') + '<hr>' + mi('del', 'trash', t('palDelete'), '', { bad: true }), {
        paint: () => { if (p.looks[0]) paint(sel, p.looks[0], 'body'); },
        ren: () => palNameDialog(p.name, (n) => { p.name = n; palSave(); renderPalettes(); }),
        exp: () => saveBlob(new Blob([JSON.stringify({ app: '3DViewer', palette: 1, name: p.name, looks: p.looks }, null, 1)], { type: 'application/json' }), p.name.replace(/[\\/:*?"<>|]+/g, '_') + '.3dvpal').then(() => toast(t('saved', p.name + '.3dvpal'))).catch(() => {}),
        del: () => { if (confirm(t('palConfirmDelete', p.name))) { PAL.list.splice(i, 1); palSave(); renderPalettes(); } },
      });
    });
  });
  $('palNew').addEventListener('click', () => offerPalette(true));
  $('palImport').addEventListener('click', () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.3dvpal,.json'; inp.multiple = true;
    inp.addEventListener('change', async () => { for (const f of inp.files) await importPalette(f); });
    inp.click();
  });
}
async function importPalette(file) {
  try {
    const j = JSON.parse(await file.text());
    if (!j || !Array.isArray(j.looks) || !j.looks.length) throw new Error();
    const looks = j.looks.filter((l) => /^#[0-9a-f]{6}$/i.test(l.color)).map((l) => Object.assign(cleanLook(l), l.name ? { name: String(l.name) } : {}));
    PAL.list.push({ name: String(j.name || stem(file.name)), looks, created: Date.now() });
    palSave(); renderPalettes(); toast(t('palImported', j.name || stem(file.name)));
  } catch (e) { toast(t('palBadFile', file.name), 'err'); }
}
function palNameDialog(name, done) {
  modal(t('rename'), '<input class="txt" id="palName" style="width:100%" maxlength="60">', [[t('cancel'), '', () => true], [t('save'), 'primary', (m) => {
    const v = m.querySelector('#palName').value.trim(); if (!v) return false; done(v); return true;
  }]], (m) => { const i = m.querySelector('#palName'); i.value = name; i.focus(); i.select(); i.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.querySelector('.df .btn.primary').click(); }); });
}

// ---------- the offer after saving: name the set of looks and keep it ----------
// manual: from the button (always shows, all scene colours); otherwise after a save, only when there is something new
function offerPalette(manual) {
  const used = PAL.used.slice(), scene = sceneLooks();
  const cand = new Map();
  used.forEach((l) => cand.set(lookKey(l), l));
  scene.forEach((l) => { if (!cand.has(lookKey(l))) cand.set(lookKey(l), l); });
  const all = Array.from(cand.values());
  if (!all.length) { if (manual) toast(t('noModel'), 'warn'); return; }
  const pre = new Set((manual || !used.length ? all : used).map(lookKey));
  if (!manual) {
    if (!S.palOffer || !used.length) return;
    const k = setKey(used);
    if (PAL.declined.has(k) || PAL.list.some((p) => setKey(p.looks) === k || used.every((l) => p.looks.some((q) => lookKey(q) === lookKey(l))))) return;
  }
  const chips = all.map((l, i) => '<button class="chipc pick' + (pre.has(lookKey(l)) ? ' on' : '') + '" data-i="' + i + '" title="' + esc(l.color.toUpperCase()) + '" style="' + swStyle(l) + '"></button>').join('');
  const body = '<span class="note">' + esc(t(used.length ? 'palOfferText' : 'palOfferScene')) + '</span>' +
    '<div class="palette big">' + chips + '</div>' +
    '<label class="frow" style="grid-template-columns:auto minmax(0,1fr)"><span>' + esc(t('palNameL')) + '</span><input class="txt" id="palName" maxlength="60"></label>' +
    (manual ? '' : '<label class="frow chk"><input type="checkbox" id="palNever"><span>' + esc(t('palNever')) + '</span></label>');
  modal(t('palOfferTitle'), body, [[t(manual ? 'cancel' : 'palNo'), '', (m) => {
    if (!manual) { PAL.declined.add(setKey(used)); if (m.querySelector('#palNever').checked) { S.palOffer = false; saveS(); } }
    return true;
  }], [t('palKeep'), 'primary', (m) => {
    const looks = Array.from(m.querySelectorAll('.chipc.pick.on')).map((c) => all[Number(c.dataset.i)]);
    if (!looks.length) { toast(t('palPickSome'), 'warn'); return false; }
    const name = m.querySelector('#palName').value.trim() || t('palDefault', PAL.list.length + 1);
    PAL.list.push({ name, looks: looks.map(cleanLook), created: Date.now() });
    palSave(); renderPalettes(); toast(t('palSaved', name));
    PAL.used = [];
    return true;
  }]], (m) => {
    const inp = m.querySelector('#palName');
    inp.value = docName || ''; inp.placeholder = t('palNamePh');
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
    m.querySelectorAll('.chipc.pick').forEach((c) => c.addEventListener('click', () => c.classList.toggle('on')));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.querySelector('.df .btn.primary').click(); });
  });
}
