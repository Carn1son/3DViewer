# Исходники 3DViewer

`www/` собирается отсюда: `python3 src/build.py` (нужен Pillow). Правки делаются здесь, не в `www/`.

- `app.html` — разметка и стили (дизайн BoardV, зелёный акцент); вместо `/*APP*/` подставляются `i18n.js`, `icons.js`, `app.js`, `io.js`
- `app.js` — сцена (three.js), дерево модели, выделение, пипетка/кисть, операции, настройки
- `sketch.js` — эскиз на плоскости/грани (линия, дуга, прямоугольник, окружность, многоугольник), вытягивание, вращение, вырез
- `measure.js` — измерение с привязками и разложением ΔX/ΔY/ΔZ
- `io.js` — открытие всех форматов, экспорт (STEP, STL, 3MF, OBJ, GLB, PLY, BREP), проект .3dv
- `kernel.js` — CAD-ядро в Web Worker: OpenCascade (сборка replicad) — точная геометрия, булевы операции, скругления, запись STEP с цветами; occt-import-js — цвета и имена из STEP/IGES
- `worker.js` — запуск ядра в потоке, приём команд
- `i18n.js` — русский и английский
- `make_logo.py` — логотип (чип BoardV, зелёный, «3DV»)
- `vendor/` — three.js (сборка `three-entry.js` через esbuild), replicad, OpenCascade wasm, occt-import-js + лицензии
- `VERSION` — номер версии (1.0 → V1.0, 1.1 → V1.01 …)

Пересборка three.js: `npm i three@0.170.0 esbuild && npx esbuild src/three-entry.js --bundle --minify --format=iife --outfile=src/vendor/three-bundle.js`
