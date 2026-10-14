"""Builds the app into www/: index.html (interface), three.js (graphics), kernel.js (CAD kernel worker + wasm as base64), icons.
Run: python3 src/build.py   (Pillow needed for the icons)"""
import os, sys, json, base64, datetime, io, shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(ROOT), 'www')
V = os.path.join(ROOT, 'vendor')
rd = lambda *p: open(os.path.join(ROOT, *p), encoding='utf-8').read()

_VM, _Vm = (int(x) for x in rd('VERSION').strip().split('.'))
VLABEL = 'V%d.%s' % (_VM, '0' if _Vm == 0 else '%02d' % _Vm)
VDATE = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=3)).strftime('%d.%m.%Y')


def logo_uri(px):
    sys.path.insert(0, ROOT)
    from make_logo import logo
    b = io.BytesIO(); logo(px).save(b, 'PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(b.getvalue()).decode()


def worker_src():
    oc = rd('vendor', 'replicad_single.js')
    oc = oc.replace('import.meta.url', '"file:///tdv/"').replace('export default Module;', '')
    assert 'import.meta' not in oc and 'export default' not in oc
    return '\n;'.join([
        rd('vendor', 'replicad.umd.js'),
        'self.__ocInit = (function () {\n' + oc + '\nreturn Module;\n})();',
        rd('vendor', 'occt-import-js.js'),
        rd('kernel.js').replace("if (typeof module !== 'undefined') module.exports = createKernel;", ''),
        rd('worker.js'),
    ])


def kernel_js():
    b = lambda f: base64.b64encode(open(os.path.join(V, f), 'rb').read()).decode()
    return ('window.TDV_KERNEL = {src: ' + json.dumps(worker_src()) + ',\noc: "' + b('replicad_single.wasm') + '",\noi: "' + b('occt-import-js.wasm') + '"};\n')


def index_html():
    app = '(function () {\n' + rd('i18n.js') + '\n' + rd('icons.js') + '\n' + rd('app.js') + '\n' + rd('sketch.js') + '\n' + rd('measure.js') + '\n' + rd('updates.js') + '\n' + rd('io.js') + '\n})();'
    frag = rd('app.html').replace('/*APP*/', app).replace('__VLABEL__', VLABEL).replace('__VDATE__', VDATE).replace('__LOGO__', logo_uri(96))
    title, rest = frag.split('\n', 1)
    return ('<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            '<meta name="theme-color" content="#131716">\n<link rel="icon" type="image/png" sizes="256x256" href="favicon-256.png">\n' + title + '\n'
            '<script src="build-info.js"></script>\n<script src="three.js"></script>\n</head>\n<body>\n' + rest + '\n</body>\n</html>\n')


def icons(out):
    sys.path.insert(0, ROOT)
    from make_logo import logo
    from PIL import Image
    big = logo(1024)
    def pad(sz, scale, bg=None):
        c = Image.new('RGBA', (sz, sz), bg or (0, 0, 0, 0)); inner = int(round(sz * scale)); o = (sz - inner) // 2
        c.alpha_composite(big.resize((inner, inner), Image.LANCZOS), (o, o)); return c
    pad(512, 0.92).save(os.path.join(out, 'icon-512.png'))
    pad(256, 0.94).save(os.path.join(out, 'favicon-256.png'))
    pad(256, 0.94).save(os.path.join(out, 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    open(os.path.join(OUT, 'index.html'), 'w', encoding='utf-8').write(index_html())
    shutil.copy(os.path.join(V, 'three-bundle.js'), os.path.join(OUT, 'three.js'))
    open(os.path.join(OUT, 'kernel.js'), 'w', encoding='utf-8').write(kernel_js())
    bi = os.path.join(OUT, 'build-info.js')
    if not os.path.exists(bi): open(bi, 'w').write("window.TDV_BUILD = { label: '%s', day: '%s', app: 'web' };\n" % (VLABEL, VDATE))
    icons(OUT)
    os.makedirs(os.path.join(OUT, 'licenses'), exist_ok=True)
    for f in os.listdir(V):
        if f.startswith('LICENSE'): shutil.copy(os.path.join(V, f), os.path.join(OUT, 'licenses', f))
    for f in sorted(os.listdir(OUT)):
        p = os.path.join(OUT, f)
        if os.path.isfile(p): print('%-18s %8.1f KB' % (f, os.path.getsize(p) / 1024))
    print('3DViewer', VLABEL, VDATE, '->', OUT)
