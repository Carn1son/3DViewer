/* Worker entry: the page sends {cmd:'init', ocWasm, oiWasm} (base64), then {id, cmd, args}. */
/* global replicad, occtimportjs, createKernel */
(function () {
  'use strict';
  let H = null;
  const quiet = () => {};
  async function bytesOf(b64) {
    const r = await fetch('data:application/wasm;base64,' + b64);
    return r.arrayBuffer();
  }
  function hook(bytes) {
    return function (imports, cb) {
      WebAssembly.instantiate(bytes, imports).then((r) => cb(r.instance, r.module));
      return {};
    };
  }
  function errText(e) {
    if (e && typeof e === 'object' && typeof WebAssembly.Exception === 'function' && e instanceof WebAssembly.Exception) return 'KERNEL';
    if (typeof e === 'number') return 'KERNEL';
    return String((e && e.message) || e || 'error');
  }
  self.onmessage = async (ev) => {
    const m = ev.data || {};
    if (m.cmd === 'init') {
      try {
        const [ocB, oiB] = await Promise.all([bytesOf(m.ocWasm), bytesOf(m.oiWasm)]);
        const oc = await self.__ocInit({ instantiateWasm: hook(ocB), print: quiet, printErr: quiet });
        replicad.setOC(oc);
        const oi = await occtimportjs({ instantiateWasm: hook(oiB), print: quiet, printErr: quiet });
        H = createKernel(replicad, oc, oi);
        self.postMessage({ id: m.id, ok: true, result: true });
      } catch (e) { self.postMessage({ id: m.id, ok: false, error: errText(e) }); }
      return;
    }
    if (!H) { self.postMessage({ id: m.id, ok: false, error: 'kernel not ready' }); return; }
    try {
      const fn = H[m.cmd];
      if (!fn) throw new Error('unknown command ' + m.cmd);
      const r = fn(m.args || {});
      self.postMessage({ id: m.id, ok: true, result: r.result }, r.transfer || []);
    } catch (e) {
      self.postMessage({ id: m.id, ok: false, error: errText(e) });
    }
  };
})();
