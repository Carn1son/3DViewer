// 3DViewer for Windows (WebView2): the same window.tdvDesktop bridge the page had under Electron, over chrome.webview messages.
(function () {
  'use strict';
  var wv = window.chrome && window.chrome.webview; if (!wv || window.tdvDesktop) return;
  var seq = 0, waits = {}, subs = { open: [], upd: [] };
  function send(m) { wv.postMessage(m); }
  function ask(t, extra) { return new Promise(function (res, rej) { var id = ++seq; waits[id] = { res: res, rej: rej }; var m = extra || {}; m.t = t; m.req = id; send(m); }); }
  function b64(u8) { var s = '', k = 0x8000; for (var i = 0; i < u8.length; i += k) s += String.fromCharCode.apply(null, u8.subarray(i, i + k)); return btoa(s); }
  function unb64(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  wv.addEventListener('message', function (e) {
    var m = e.data; if (!m || typeof m !== 'object') return;
    if (m.t === 'res') { var w = waits[m.req]; delete waits[m.req]; if (w) { if (m.error) w.rej(new Error(m.error)); else w.res(m.data); } return; }
    if (m.t === 'open-files') { var list = (m.files || []).map(function (f) { return { name: f.name, data: unb64(f.b64) }; }); subs.open.forEach(function (cb) { cb(list); }); return; }
    if (m.t === 'upd') subs.upd.forEach(function (cb) { cb(m.m); });
  });
  window.tdvDesktop = {
    host: 'webview2',
    onOpenFiles: function (cb) { subs.open.push(cb); },
    ready: function () { send({ t: 'ready' }); },
    // Windows "Save as": resolves to the chosen path, or null when cancelled
    saveFile: function (name, u8) { return ask('save-file', { name: String(name || 'model'), b64: b64(u8) }); },
    update: {
      check: function () { return ask('upd-check'); },
      download: function () { return ask('upd-download'); },
      install: function () { send({ t: 'upd-install' }); },
      on: function (cb) { subs.upd.push(cb); }
    }
  };
  if (window.TDV_WIN) window.tdvDesktop.portableName = window.TDV_WIN.portable;
})();
