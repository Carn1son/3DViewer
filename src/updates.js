/* 3DViewer — updates of the Windows app, as in BoardV: check GitHub, install only after the user agrees.
   Installed copy: electron-updater downloads and replaces it in place. Portable copy: compare versions and offer the download. */

const UPD_API = 'https://api.github.com/repos/Carn1son/3DViewer/releases/latest';
const UPD_PAGE = GITHUB + '/releases/latest';
const BUILD = window.TDV_BUILD || null;
const DESK = window.tdvDesktop && window.tdvDesktop.update ? window.tdvDesktop : null;
const CAN_UPDATE = !!DESK;
const UPD = { auto: true, st: 'idle', latest: '', day: '', pct: 0, msg: '', mode: '', label: '' };
try { UPD.auto = localStorage.getItem('tdv.autoupd') !== '0'; } catch (e) { /* no storage */ }
let updAuto = false;

function verNewer(a, b) {
  a = String(a).split('.').map(Number); b = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}
function verLabel(a, b) { return 'V' + (a - 1) + '.' + (b ? ('0' + b).slice(-2) : '0'); } // 2100.2.1 = V1.01
function updHtml() {
  let h = '';
  const b = [], d = (UPD.label ? UPD.label : '') + (UPD.day ? ' · ' + UPD.day : '');
  if (UPD.st === 'checking') h += '<div class="ln">' + esc(t('updChecking')) + '</div>';
  else if (UPD.st === 'none') h += '<div class="ln ok">' + esc(t('updLatest')) + '</div>';
  else if (UPD.st === 'available') { h += '<div class="ln">' + esc(t('updAvail', d)) + '</div>'; b.push(['go', UPD.mode === 'portable' ? t('updDownload') : t('updUpdate'), 1]); }
  else if (UPD.st === 'downloading') h += '<div class="ln">' + esc(t('updLoading', UPD.pct || 0)) + '</div><div class="bar"><i style="width:' + (UPD.pct || 0) + '%"></i></div>';
  else if (UPD.st === 'ready') { h += '<div class="ln">' + esc(t('updReady')) + '</div>'; b.push(['install', t('updRestart'), 1]); }
  else if (UPD.st === 'error') h += '<div class="ln bad">' + esc(t('updError', UPD.msg)) + '</div>';
  if (UPD.st !== 'downloading' && UPD.st !== 'checking') b.push(['check', t('updCheck')]);
  if (!h) h = '<div class="ln ok">' + esc(t('updTitle')) + '</div>';
  return h + '<div class="btnrow">' + b.map((x) => '<button type="button" class="btn sm' + (x[2] ? ' primary' : '') + '" data-upd="' + x[0] + '">' + esc(x[1]) + '</button>').join('') + '</div>';
}
function updRender() {
  const box = $('updBox'); if (box) box.innerHTML = updHtml();
  const bar = $('updBar');
  if (bar && !bar.hidden) bar.innerHTML = '<b>' + esc(t('updBarTitle')) + '</b><div class="upd">' + updHtml() + '</div><button type="button" class="btn x" data-upd="later" aria-label="' + esc(t('updLater')) + '">✕</button>';
}
function updSet(st, extra) { UPD.st = st; if (extra) Object.assign(UPD, extra); updRender(); }
function showUpdBar() { $('updBar').hidden = false; updRender(); }
function apiCheck(cur, auto) {
  fetch(UPD_API, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('GitHub ' + r.status); return r.json(); }).then((j) => {
    const v = String(j.tag_name || '').replace(/^v/, '');
    const day = (String(j.name || '').match(/(\d\d\.\d\d\.\d{4})/) || [])[1] || '';
    const label = (String(j.name || '').match(/V\d+\.\d+/g) || ['']).pop();
    if (/^\d+(\.\d+)+$/.test(v) && verNewer(v, cur)) { updSet('available', { latest: v, day, label }); if (auto) showUpdBar(); }
    else updSet('none', { latest: v, day, label });
  }).catch((e) => updSet(auto ? 'idle' : 'error', { msg: (e && e.message) || t('updNoNet') }));
}
function checkUpdates(auto) {
  if (!CAN_UPDATE || UPD.st === 'downloading' || UPD.st === 'checking') return;
  updAuto = !!auto; updSet('checking');
  DESK.update.check().then((r) => {
    UPD.mode = r.mode;
    if (r.mode !== 'installer') { apiCheck(r.version || (BUILD && BUILD.version), auto); return; } // portable: compare and offer the download
    if (r.error) updSet(auto ? 'idle' : 'error', { msg: r.error });
    else if (UPD.st === 'checking' && r.latest && !verNewer(r.latest, r.version)) updSet('none');
  });
}
function startUpdate() {
  if (UPD.mode === 'portable') { window.open(UPD_PAGE + '/download/3DViewer-portable.exe'); return; }
  updSet('downloading', { pct: 0 });
  DESK.update.download();
}
if (DESK) DESK.update.on((m) => {
  if (m.type === 'available') { const vv = String((m.data && m.data.version) || '').split('.'); updSet('available', { latest: m.data && m.data.version, day: '', label: vv[0] === '2100' ? verLabel(+vv[1], +vv[2]) : '' }); if (updAuto) showUpdBar(); }
  else if (m.type === 'none') updSet('none');
  else if (m.type === 'progress') updSet('downloading', { pct: m.data || 0 });
  else if (m.type === 'downloaded') updSet('ready');
  else if (m.type === 'error') updSet('error', { msg: m.data });
});
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-upd]'); if (!b) return;
  const a = b.dataset.upd;
  if (a === 'check') checkUpdates(false);
  else if (a === 'go') startUpdate();
  else if (a === 'install') DESK.update.install();
  else if (a === 'later') $('updBar').hidden = true;
});
document.addEventListener('change', (e) => {
  if (e.target.id !== 'updAuto') return;
  UPD.auto = e.target.checked;
  try { localStorage.setItem('tdv.autoupd', UPD.auto ? '1' : '0'); } catch (x) { /* no storage */ }
});
function updatesBlock() {
  if (!CAN_UPDATE) return '<span class="note">' + esc(t('updWebOnly')) + '</span>';
  return '<div class="updmini"><div class="upd" id="updBox">' + updHtml() + '</div><label class="mchk"><input type="checkbox" id="updAuto"' + (UPD.auto ? ' checked' : '') + '><span>' + esc(t('updAuto')) + '</span></label></div>';
}
if (CAN_UPDATE && UPD.auto) setTimeout(() => checkUpdates(true), 4000);
