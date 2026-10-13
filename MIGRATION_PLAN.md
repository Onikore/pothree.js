# Миграция Potree на актуальный three.js — план (Этап 0, аудит)

Статус (2026‑10‑12): шаги 1–7 выполнены — three.js r186, WebGL2, отрисовка облаков на three.js, без приватного API; дальше 7а (ES‑сборка, размер) и 8 (операции). Решения A–H, J, K приняты, I — ожидает. Документация кода — `docs/`.

## 1. Версии

| | Значение | Как установлено |
|---|---|---|
| Текущая three.js | **r124** | `libs/three.js/build/three.module.js:2` — `const REVISION = '124'` |
| Целевая three.js | **0.186.1 (r186)** | `npm view three version` на 2026‑10‑12 |
| Как three попадает в сборку | вшит в `build/potree/potree.js` | `rollup.config.js`: `treeshake:false`, без `external` |
| Как three берут примеры | **вторая копия**: `import * as THREE from "../libs/three.js/build/three.module.js"` | 41 из 49 примеров |

Следствие последней строки: уже сейчас в странице живут две копии three (в бандле и в примере).
Работает только потому, что версии совпадают. После миграции примеры и бандл обязаны брать
один и тот же модуль `three` (import map / external), иначе `instanceof` между ними ломается.

## 2. Аудит использования three.js по группам риска

### 2.1 Прямой WebGL и внутренности рендерера — РИСК КРИТИЧЕСКИЙ

Облака точек рисуются **не через three.js**, а собственным рендерером на сыром WebGL,
разделяющим контекст с `THREE.WebGLRenderer`.

| Место | Что делает |
|---|---|
| `src/PotreeRenderer.js` (1483 строки) | Собственная компиляция шейдеров (`gl.createProgram`, `bindAttribLocation`), VAO, VBO, uniform blocks, собственные GL‑текстуры (`gl.createTexture`, `texParameteri`), конвертация констант three → GL (`paramThreeToGL`, ссылается на `THREE.RGBFormat`, `THREE.LuminanceFormat`) |
| `src/PotreeRenderer.js:834, 1397-1398` | **`threeRenderer.properties.get(tex).__webglTexture`** — приватный API, чтобы взять GL‑текстуру render target'а three (shadow map, snap‑текстуры) |
| `src/PotreeRenderer.js:1448, 1470` | `setRenderTarget`, `resetState` — публичные, ок |
| `src/viewer/viewer.js:1431` | **`canvas.getContext('webgl')` — явно WebGL1**, затем передаётся в `THREE.WebGLRenderer({context})` |
| `src/viewer/viewer.js:1451-1465` | Включает `EXT_frag_depth`, `WEBGL_depth_texture`, `WEBGL_color_buffer_float`, полифил VAO через `OES_vertex_array_object` |
| `src/PointCloudOctree.js:823-863`, `src/arena4d/PointCloudArena4D.js:380-412` | Picking: `gl.scissor`, `gl.readPixels`, **`renderer.state.buffers.depth.*`, `renderer.state.setBlending`, `renderer.state.reset()`** — приватный API |
| `src/Features.js` | Детект возможностей через расширения WebGL1 |
| `src/viewer/EDLRenderer.js`, `HQSplatRenderer.js`, `profile.js` | Чередуют `pRenderer.render(...)` (свой GL) и `renderer.render(...)` (three) в одном кадре |

### 2.2 Шейдеры — РИСК ВЫСОКИЙ

- `src/materials/shaders/*.vs|fs` (13 файлов) — GLSL ES 1.0: `gl_FragColor`, `texture2D`,
  `#extension GL_EXT_frag_depth` + `gl_FragDepthEXT` (pointcloud.fs, edl.fs, normalize.fs,
  normalize_and_edl.fs). Под WebGL2/GLSL3 нужно: `in/out`, `texture`, `gl_FragDepth`, явный `out vec4`.
- Материалы: `PointCloudMaterial`, `EyeDomeLightingMaterial`, `NormalizationMaterial`,
  `NormalizationEDLMaterial` — `RawShaderMaterial`; `BlurMaterial` — `ShaderMaterial`.
  `PointCloudMaterial` компилируется **не** three.js, а `PotreeRenderer` (2.1).
- `src/modules/OrientedImages/OrientedImages.js` — inline‑шейдер GLSL1.

### 2.3 Удалённые классы геометрии — РИСК СРЕДНИЙ (механический, но объёмный)

`THREE.Geometry` (удалён в r125), `.vertices`, `Face3` (r126):
`src/utils/ClipVolume.js` (37 вхождений), `src/utils/TransformationTool.js` (25), `src/utils.js` (11),
`src/utils/Volume.js` (7), `src/utils/Profile.js` (4), `src/modules/OrientedImages/OrientedImages.js` (4),
`src/AnimationPath.js` (3), `src/utils/Measure.js` (2). Всего 13 конструкторов `new THREE.Geometry()`.

### 2.4 Цвет — РИСК ВЫСОКИЙ (визуальный)

- Код Potree **вообще не задаёт** encoding/colorSpace — живёт на дефолтах r124 (Linear, без color management).
- r152: `ColorManagement.enabled = true`, `outputColorSpace = SRGBColorSpace` по умолчанию.
  Это изменит цвета всех мешей/линий/спрайтов three (`THREE.Color` в sRGB‑hex станет конвертироваться),
  текстур (NavigationCube, matcap, gradient‑текстуры, панорамы 360, oriented images) и постпроцесса EDL.
- Облака точек, рисуемые `PotreeRenderer`, на это не реагируют (свои шейдеры) — получится
  **рассинхрон**: точки как раньше, остальная сцена — иначе.
- Решение по умолчанию: на r152+ выставить `ColorManagement.enabled=false` + `outputColorSpace=LinearSRGBColorSpace`
  (точное воспроизведение r124), затем отдельным опциональным шагом — честный color management.

### 2.5 Addons three.js — РИСК СРЕДНИЙ

Используются в `src/`: `lines/Line2.js`, `LineGeometry.js`, `LineMaterial.js` (Measure, Profile, ClipVolume, …;
6 импортов), `extra/VRButton.js`, `webxr/XRControllerModelFactory.js`.
В примерах: `loaders/PLYLoader`, `OBJLoader`, `GLTFLoader` (meshes.html и др.).
Всё это переходит на `three/addons/...`. `LineMaterial` в новых версиях требует `resolution` и
изменил поведение `worldUnits`/`linewidth` — проверить толщины линий измерений.

### 2.6 Прочие удалённые/переименованные API

| API | Где | Удалён/изменён |
|---|---|---|
| `THREE.Math.*` (27 вызовов) | Annotation.js, profile.js, DeviceOrientationControls.js, … | r113 переименован в `MathUtils`; алиас `Math` в r124 ещё жив, далее убран |
| `THREE.PlaneBufferGeometry` (3) | utils.js:1082, VRControls.js:458, Scene.js:384 | deprecated r145, удалён позже |
| `THREE.RGBFormat` | utils.js:392 (`DataTexture`), PotreeRenderer.js:46 | удалён r137 |
| `THREE.LuminanceFormat` | PotreeRenderer.js:48 | удалён (WebGL2) |
| UMD `build/three.js`, `three.min.js` | вендорены, в src не используются | удалены r161 |
| WebGL1 | viewer.js:1431 | deprecated r153, **удалён r163** |
| `renderer.xr.*` | viewer.js, VRControls.js | r162 hand tracking off по умолчанию; r169 слои камеры; r187+ derived XR camera — **неактуально: VR удалён** |

## 3. Breaking changes, реально затрагивающие Potree (по migration guide)

Сверено с https://github.com/mrdoob/three.js/wiki/Migration-Guide.

| Ревизия | Изменение | Файлы Potree |
|---|---|---|
| r124→r125 | `Geometry` убран из ядра; генераторы возвращают `BufferGeometry` | 2.3 + `PlaneGeometry` меняет тип возвращаемого значения |
| r125→r126 | `Face3` убран | ClipVolume.js, TransformationTool.js |
| r136→r137 | `RGBFormat` убран → `RGBAFormat` | utils.js:392, PotreeRenderer.js:46 |
| r137→r138 | `WebGLMultisampleRenderTarget` убран | не используется — ок |
| r144→r145 | `*BufferGeometry` алиасы deprecated | 3 места (2.6) |
| r147→r148 | `examples/js` удалён | Potree уже на jsm — ок |
| r149→r150 | UMD‑сборки deprecated; `useLegacyLights` | освещение мешей в meshes.html |
| r151→r152 | `outputEncoding`→`outputColorSpace`, `encoding`→`colorSpace`, ColorManagement on | 2.4, вся сцена |
| r152→r153 | WebGL1 deprecated | viewer.js:1431 |
| r154→r155 | `useLegacyLights=false` по умолчанию (физ. интенсивности) | примеры с мешами и светом (light*.html) |
| r160→r161 | UMD удалены | libs/three.js/build/three(.min).js |
| r162→r163 | **WebGL1 удалён из WebGLRenderer** | viewer.js:1431, Features.js, все шейдеры |
| r161→r162, r168→r169 | XR: hand tracking, слои камеры | неактуально: VR удалён |

## 4. Прочие зависимости в `libs/`

| Библиотека | Версия | Связь с three | Блокирует? |
|---|---|---|---|
| jQuery 3.1.1, jQuery UI, jstree, spectrum | старые | нет | нет (UI сайдбара) |
| Cesium | вендорен, отдельный canvas | синхронизация камеры через матрицы | нет; проверить cesium_*.html |
| openlayers3 (`ol.js`) | старый | нет (мини‑карта) | нет |
| proj4, d3, i18next, tween, stats.js | — | tween анимирует `THREE.Vector3` | нет |
| plasio (laz-perf), copc, ept, zstd-codec, brotli | — | только воркеры, данные | нет |
| geopackage, sql.js, shapefile | — | строят `THREE.Line`/`BufferGeometry` | нет (сверить вывод) |
| MeshLine | папка есть, в src не импортируется | — | нет |
| three.js/libs/* (dat.gui, …) | вендор three | — | удаляются вместе с вендором |

Блокер только один — сам three.js (WebGL1 + собственный рендерер). Остальное мигрирует независимо.

## 5. Эталон (Этап 0, п.6)

`npm install` + `gulp build` на исходнике — успешно. Скрипт эталона снимает все 49 примеров в
headless Chromium (SwiftShader, 1280×800): ждёт `Potree.numNodesLoading == 0` 2 с подряд, камера —
исходная позиция примера (детерминирована кодом примера), сохраняет PNG, число видимых точек,
позицию камеры и ошибки/предупреждения консоли. Результат: `tests/baseline/*.png`,
`tests/baseline/report.json`. Сводка — см. раздел 8.

## 6. Целевая архитектура

Принятое решение (2026‑10‑12): облака точек рисуются **только средствами three.js** —
`THREE.Points` + `BufferGeometry` + `RawShaderMaterial({glslVersion: THREE.GLSL3})`, WebGL2,
последняя стабильная three (сейчас r186 / 0.186.1). Основа рендеринга облаков переносится из
potree-core (tentone, MIT), загрузчики, LOD, бюджет точек, UI и инструменты остаются Potree.
Собственный WebGL‑рендерер `src/PotreeRenderer.js` удаляется после доказанного паритета.

### 6.1 Рендеринг облаков

| Элемент | Как устроено | Откуда |
|---|---|---|
| Узел октодерева | `node.sceneNode = new THREE.Points(geometry, material)`; per‑node uniforms (`level`, `vnStart`, `pcIndex`) — в `onBeforeRender` | potree-core `point-cloud-octree.ts:200` |
| Материал | один `PointCloudMaterial extends RawShaderMaterial`, GLSL3; набор включённых возможностей = `defines` + `customProgramCacheKey`, всё остальное — uniforms (без перекомпиляции) | potree-core + Potree |
| Атрибуты | сохраняем универсальность Potree: любой атрибут облака как `aExtra` с range/gamma/brightness/contrast, LUT классификации, градиенты, matcap | Potree `src/materials` |
| Фильтры | return number, number of returns, point source id, GPS time — из Potree; filter by normal — из core | обе |
| Clipping | Potree (box, polygon, plane) + core (sphere, include/exclude на каждый объём, `HIGHLIGHT_INSIDE`, штатные `material.clippingPlanes`) | обе |
| Visibility texture (адаптивный размер точек) | текстура видимых узлов, как в обоих проектах | core |
| Глубина | поддержка `reversedDepthBuffer` (опция `WebGLRenderer` в r186) и логарифмической глубины в point‑ и EDL‑шейдерах | core |
| EDL, HQ splats | многопроходный рендер через `WebGLRenderTarget` (float на WebGL2), облака на отдельном layer, остальная сцена — штатным `renderer.render` | core `rendering/edl-pass.ts` |
| Picking | рендер только узлов на луче в маленький RT со scissor‑окном; ID‑материал; чтение `readRenderTargetPixelsAsync` (без остановки GPU); состояние глубины/смешивания — через свойства материала, без `renderer.state` | core `point-cloud-octree-picker.ts` + r186 |
| Raycaster | `PointCloudOctree.raycast` → обычный `THREE.Raycaster` видит облака (совместимость с TransformControls и чужим кодом) | core |

Приватный API three: цель — ноль. Если что‑то останется (кандидат — снапшоты в `PointCloudSM`),
оно живёт в одном модуле `src/three-internals.js` с объяснением причины.

### 6.2 Операции над облаком (место под новые)

Любая операция попадает ровно в один из четырёх видов. Вид определяет, где она выполняется и
почему это быстро.

| Вид | Что делает | Где выполняется | Примеры (есть / будут) |
|---|---|---|---|
| **view** | меняет только отображение | GPU, шейдер; меняются uniforms, перекомпиляция только при смене набора возможностей | раскраска, фильтры, clipping, подсветка, отображение выделения |
| **query** | читает точки, данные не меняет | воркеры (`WorkerPool`), сначала отсев узлов по bbox; screen‑space выборка — на GPU через ID‑буфер | picking, измерения/привязка, профиль, точки в объёме, статистика, экспорт |
| **edit** | меняет атрибуты точек | слой правок + частичная заливка на GPU (`BufferAttribute.addUpdateRange`) | выделение, удаление/скрытие, переклассификация, запись атрибута |
| **compute** | считает новые данные | воркеры; результат пишется как производный атрибут через слой правок | нормали, классификация земли, кластеризация, расстояние облако–меш |

Четыре точки расширения (код, а не фреймворк):

1. **Возможность шейдера** (`view`). Объект `{name, defines, uniforms, glsl: {vertex, fragment}}`, код
   вставляется в фиксированные точки шейдера (`// @hook:filter`, `// @hook:color`, `// @hook:size`).
   Встроенные раскраски, фильтры и clipping оформляются так же — новая операция пишется тем же
   способом, что и штатные, без правки ядра шейдера.
2. **`PointQuery`** (`query`, `compute`). На входе: область (Box3/OBB, полигон‑призма, сфера, frustum,
   луч), уровень детализации (только загруженное или «догрузить до уровня N»), список атрибутов,
   фильтр. На выходе: асинхронный итератор порций `{node, indices, attributes}` (transferable
   буферы). Существующий `ProfileRequest` переводится на `PointQuery` и становится первым клиентом.
3. **`EditLayer`** (`edit`). Своя на каждое облако. Хранит разреженные правки по ключу
   `(имя узла, индекс точки)`: каждая точка Potree 1.x/2.0 и EPT лежит ровно в одном узле, поэтому
   ключ однозначен. На GPU — per‑node атрибут `aEdit` (флаги: выделена, удалена/скрыта) плюс
   при необходимости переопределения атрибутов; при выгрузке и повторной загрузке узла правки
   накладываются заново. Выделение — тоже правка, поэтому любая операция может принять
   «текущее выделение» на вход. Отмена/повтор — стек команд `{apply(), revert()}`.
   Сохранение — отдельный файл правок рядом с данными (исходники не трогаем). Запись обратно в
   LAS/Potree — будущий экспорт, отдельное решение (G).
4. **Регистрация операции** — `viewer.operations.register({id, kind, label, run(ctx, params)})`, где
   `ctx = {viewer, pointclouds, selection, query, editLayer}`. Отсюда операцию подхватывают UI сайдбара,
   горячие клавиши и внешний код. Штатные инструменты (измерения, профиль, clipping) регистрируются
   так же.

Правила скорости для всех операций:
- Всё, что выражается как «условие на точку» на загруженных точках, делается в шейдере.
- Шейдер не перекомпилируется при изменении параметров, только при смене набора возможностей
  (кэш программ three по `customProgramCacheKey`).
- Никакого пересоздания геометрии при правках: только `addUpdateRange`.
- Никакого синхронного `readPixels` в кадре: `readRenderTargetPixelsAsync`.
- Тяжёлое — в воркеры, с отсевом узлов по bbox до чтения точек.
- Каждый шаг проходит бенчмарк Этапа 4; регресс больше 10% блокирует.

**Статус (2026‑10‑13):** п.2–4 сделаны — `src/operations/` (`PointQuery`, `EditLayer`, реестр
`viewer.operations`), описание `docs/operations.md`. Отступления от плана: query на главном потоке,
синхронно (воркеры и «догрузить до уровня N» — когда понадобится); флаги правок — атрибут `aEdit`
только у облаков с правками (облака без правок не платят); сохранение — JSON (`toJSON`). Не сделано:
п.1 «возможности шейдера», compute‑операции.

### 6.3 Что берём из potree-core

| Берём | Зачем |
|---|---|
| Рендер узлов через `THREE.Points` + `onBeforeRender` | ядро решения |
| `PointCloudMaterial` GLSL3, `pointcloud.vs/fs`, `edl.fs` | готовый перевод шейдеров на GLSL ES 3.0 |
| Picker (scissor‑окно, учёт `pixelRatio`, хук `onBeforePickRender`, восстановление render target) | быстрый и точный picking |
| `raycast` у облака | совместимость со штатным `Raycaster` |
| Clip sphere, include/exclude на каждый объём, `HIGHLIGHT_INSIDE`, `material.clippingPlanes` | больше режимов clipping |
| Подсветка точки (`highlightPoint`), фильтр по нормали | наведение и привязка в измерениях |
| Reversed depth / log depth | точность на больших сценах |
| `EDLPass` с float‑RT и разделением по layers | EDL без расширений WebGL1 |
| `RequestManager` (свой `getUrl`/`fetch`) — во все загрузчики | авторизация, подписанные URL, офлайн‑кэш |
| Исправления: ортокамера, узлы с 0 точек, adaptive size на самом детальном узле, аргументы `mix()` в sRGB | проверить, есть ли те же баги в Potree; добавить в регресс |
| Идея `@uniform` / `@requiresShaderUpdate` | в JS — простой помощник, генерирующий getter/setter, без декораторов |

| Не берём | Почему |
|---|---|
| Загрузчики core | у Potree их больше (LAS/LAZ, EPT, COPC); в core LAS/LAZ не подключены |
| LRU, BinaryHeap | в Potree есть свои, работают |
| `DEMNode` | в core нигде не используется |
| `features.ts`, `normalize.fs`, `blur.fs` | WebGL1 / GLSL1, мёртвый или устаревший код |
| TypeScript | Potree остаётся на JS (ES‑модули) + JSDoc; типы — генерация `.d.ts` (решение H) |

Лицензия: core — MIT, Potree — BSD‑2. Совместимы; в перенесённых файлах — заголовок с
атрибуцией и копия лицензии в `LICENSE-potree-core`.

### 6.4 Скорость

Цель — не медленнее оригинала (регресс больше 10% блокирует) и быстрее там, где оригинал
тратит время впустую. Найдено при разборе (`docs/architecture.md`, раздел «Проблемы»):

| Где | Что делаем |
|---|---|
| `updateVisibility`: `camera.clone()` на каждое облако каждый кадр, результат не используется | убрать |
| `updateVisibility`: ~20 объектов three на узел × clip box × кадр | считать плоскости clip box один раз за кадр на облако, переиспользовать временные объекты |
| per‑node uniforms в `onBeforeRender` | писать только `level`/`vnStart`/`pcIndex`; three не делает GL‑вызов, если значение uniform не изменилось. Если замер покажет нагрузку — перенести в атрибут/текстуру |
| picking | `readRenderTargetPixelsAsync`, рисовать только узлы на луче, окно в несколько пикселей |
| выгрузка узлов | `geometry.dispose()` (уже есть в LRU) → three освобождает GPU‑буферы сам, без своего учёта VBO |
| воркеры | размер пула = `navigator.hardwareConcurrency`, данные — transferable |
| загрузка на GPU | по‑прежнему не больше 2 новых узлов за кадр (без рывков) |

Каждый шаг 5–8 замеряется по Этапу 4 (FPS средний и 1% low, время кадра, память, скорость подгрузки).

### 6.5 Размер сборки

Сейчас: `potree.js` 2,2 МБ (466 КБ gzip, не минифицирован, three вшит), воркеры 5,1 МБ, ресурсы 4,8 МБ,
ленивые библиотеки 11 МБ.

| Мера | Эффект |
|---|---|
| `three` — `peerDependency` и `external` | −~240 КБ gzip, и в проекте одна копия three |
| ES‑модули, tree‑shaking включён, `sideEffects` в `package.json` | в проект попадает только используемое |
| Две точки входа: `potree` (ядро: загрузка, LOD, рендер, picking, операции; без DOM и jQuery) и `potree/viewer` (UI, сайдбар, карта, профиль) | проект без UI Potree не тянет jQuery, jQuery UI, jstree, d3, OpenLayers |
| Патчи прототипов three (`extensions/*`) и jQuery‑плагин `selectgroup` — только в `potree/viewer` | ядро без побочных эффектов при импорте |
| Минификация (terser) для ESM и UMD, sourcemap отдельным файлом | меньше в разы |
| Шейдеры: импорт строкой, при сборке убрать комментарии и лишние пробелы | меньше и без gulp‑шага |
| Тяжёлое — только по требованию (`import()`): Cesium, OpenLayers, профиль (d3), GeoPackage (`sql.js`), шейп‑файлы, воркеры форматов | начальная загрузка без них |
| Бюджет размера в CI: скрипт сравнивает gzip‑размер файлов `dist/` с `size-budget.json` | рост веса виден в каждом PR |

**I. Тяжёлые декодеры — ОЖИДАЕТ СОГЛАСОВАНИЯ.** `LASLAZWorker.js` 1,6 МБ — asm.js‑версия laz‑perf;
рядом уже лежит `laz-perf.wasm` 212 КБ (используется для COPC). `EptZstandardDecoderWorker.js` 3,0 МБ —
`zstd-codec`. Предлагаю перевести LAS/LAZ на wasm‑версию laz‑perf и заменить `zstd-codec` на компактный
декодер zstd. Это замена зависимостей; делаю только после вашего «да» и со smoke‑тестами форматов.

### 6.6 Документация

Всё, что найдено и написано, документируется по ходу работы, в том же коммите, что и код:
- `docs/architecture.md` — как устроено (исходное состояние + раздел изменений);
- `docs/modules.md` — карта всех файлов `src/`;
- отдельный файл в `docs/` на каждую новую подсистему (рендеринг облаков, операции, сборка, тесты);
- JSDoc у каждого нового или переписанного класса и публичной функции: что делает, параметры,
  единицы измерения, кто вызывает, почему так (если неочевидно);
- `CHANGELOG.md` — каждое изменение, заметное пользователю Potree (особенно ломающее);
- `README.md` — статус миграции (версия three), установка, запуск, тесты — актуализируется
  с каждым шагом.

## 7. План шагов

Принцип: каждый шаг — сборка + визуальный регресс против эталона, отдельный коммит.

Ключевое ограничение: старый рендерер работает только в WebGL1‑контексте (GLSL1 c
`gl_FragDepthEXT`), а three r163 WebGL1 удалил. Значит, новый рендеринг должен появиться **до**
r163. Делаем его на r152: там ещё есть WebGL1, поэтому старый и новый рендеры могут жить рядом за
флагом `Potree.renderer = 'legacy' | 'three'` — попиксельное сравнение и бенчмарк на одной версии three.

| # | Шаг | three | Сложность |
|---|---|---|---|
| 1 | Инфраструктура (Этап 1): ветка `three-upgrade`, Playwright‑регресс, smoke форматов, three из npm (`three@0.124.0`, нулевой diff), rollup v4, import map в примерах. Единая копия three на странице (ES‑сборка с `three` как `external`) перенесена в 7а: UMD без вшитой three невозможен, т.к. в r160+ нет UMD‑сборки three | r124 | M |
| 2 | Подготовка на r124: `THREE.Math`→`MathUtils`, `RGBFormat`→`RGBAFormat`, `Geometry`/`Face3`→`BufferGeometry`; исправление найденных ошибок (двойная загрузка Potree 2.0, импорт `.vpc`, `exports.*`) и лишних аллокаций в `updateVisibility`. Глобальное `Potree.*` в ядре — в 7а, вместе с ES‑сборкой, где его можно проверить | r124 | M |
| 3 | Прыжки r125→r138→r151 (r138 вместо r137: у r137 сломанный `exports` для аддонов): `PlaneBufferGeometry`, addons (`Line2`, `LineMaterial`, `XRControllerModelFactory`) из `three/addons` | r151 | M |
| 4 | r151→r152: color management закрепить на поведении r124 (решение D), сверить пиксели | r152 | M |
| 5 | **Новый рендеринг облаков** на three (раздел 6.1), материал сразу на «возможностях шейдера» (6.2 п.1); WebGL2‑контекст для `'three'`; legacy за флагом. Перенос всех раскрасок, фильтров, размеров, форм | r152 | XL |
| 6 | EDL, HQ splats, picking, профиль, `PointCloudSM`, Arena4D — на новый рендеринг; паритет пикселей и бенчмарк против legacy | r152 | L |
| 7 | Удаление legacy‑рендерера, `Features.js` на WebGL2; r152→r163→r186: `useLegacyLights`, последние deprecations; three → `peerDependency` | r186 | M |
| 7а | Размер (6.5): точки входа `potree` и `potree/viewer`, ленивые `import()`, минификация шейдеров, бюджет размера в CI | r186 | M |
| 8 | Каркас операций: `PointQuery` (+ перевод `ProfileRequest`), `EditLayer` + выделение + undo/redo, GPU‑выборка по экрану (box/lasso), `viewer.operations.register`; штатные инструменты — через регистрацию | r186 | L |
| 9 | Этапы 3–5: ручная и автоматическая проверка, производительность, docs, CI | r186 | L |

Промежуточные точки r125, r137, r152, r163 — места крупных breaking changes из раздела 3.

## 8. Решения

**A. Рендеринг облаков — РЕШЕНО:** только three.js, основа из potree-core (раздел 6.1).

**B. WebGL1 — ПРИНЯТО (следует из выбора «последняя three»):** r163+ его не поддерживает, браузеры без WebGL2
больше не работают. Отмечаю как изменение поведения для CHANGELOG.

**C. Сборщик — ПРИНЯТО:** rollup v4 (`three` как `external`) + UMD‑бандл с глобальным `Potree`, а не
Vite: rollup уже есть, воркеры и ресурсы из gulp переносятся. Vite — только dev‑сервер, если захотите.

**D. Цвет — ПРИНЯТО:** на r152 по умолчанию сохраняем картинку r124 (`ColorManagement.enabled=false`, Linear output).
Честный sRGB — отдельная опция позже.

**E. Arena4D — ПРИНЯТО:** `src/arena4d/` мигрирует наравне со всеми. Данных для теста в `pointclouds/` нет.

**F. WebGLRenderer, а не WebGPURenderer — ПРИНЯТО.** В r186 есть `three/webgpu` с compute‑шейдерами (очень быстрые
операции над всеми точками на GPU), но он не поддерживает `RawShaderMaterial`/GLSL: все шейдеры
пришлось бы переписать на TSL. Предлагаю WebGLRenderer сейчас; возможности шейдера изолированы
(6.2 п.1), чтобы перевод на TSL позже был локальным.
Проверено замером 2026‑10‑13 (`tests/perf/webgpu.mjs`, PERFORMANCE.md): на 15 млн точек WebGPU в
установившемся режиме не быстрее WebGL (точки с размером — только инстансными квадратами).
Владелец: прирост не заметный — остаёмся на WebGL.

**G. Правки точек — ПРИНЯТО:** хранить отдельным файлом правок, исходные данные не менять. Запись
обратно в LAS/Potree 2.0 — отдельная задача после каркаса операций.

**J. VR/WebXR — УДАЛЁН (решение владельца, 2026‑10‑12):** не нужен; снимает риски XR‑изменений three (r162, r169, r187) и пункт VR из Этапа 3.

**K. Удаление компонентов (2026‑10‑12).**
- ПРИНЯТО удалить: мёртвый код (`DEMWorker`, `InterleavedBuffer`, `BitReader`, `BlurMaterial`,
  шейдеры `pointcloud_dynamic.*`/`pointcloud_sm.*`, `GeoControls`, `src/server/getPoints.php`,
  `libs/MeshLine`), Cesium (примеры + `libs/Cesium`), Arena4D (`.vpc`), `DeviceOrientationControls`.
- ПРИНЯТО (2026‑10‑13, вторая чистка, группы А и Б): неиспользуемые файлы `libs/`, ресурсы, исходники
  воркеров, импорты, `image_preview.php`; DEM‑флаги и методы вьюера, заглушка `flipYZ` (список — CHANGELOG).
- ОСТАВЛЕНО: мини‑карта OpenLayers.
- ПОД ВОПРОСОМ (не удалять без отдельного решения): ориентированные снимки, 360° панорамы,
  GeoPackage/Shapefile, экспорт DXF/GeoJSON, HQ splats, переводы интерфейса (i18n), узлы LAS/LAZ
  формата Potree 1.x.

**L. Библиотеки интерфейса.** jQuery, jQuery UI, jstree обновлены (уязвимости). Не обновлены, нужен
перенос кода на новый API: d3 3.5 → 7 (окно профиля), OpenLayers 3.11 → 10 (мини‑карта), i18next 1.8 → 26,
tween.js 0.15 → 25. Предлагается вместе с 7а (разделение на ядро и вьюер), по отдельному решению.

**M. Асинхронный picking** (`readRenderTargetPixelsAsync`) убрал бы синхронное ожидание GPU (~1,2–1,5 мс
на выбор при перетаскивании), но меняет API инструментов (выбор станет асинхронным). По решению.

**H. Язык — ПРИНЯТО:** JS + JSDoc, без перевода Potree на TypeScript; `.d.ts` генерировать для пользователей npm.

## 9. Эталон — сводка

(заполняется по результатам прогона)

## 10. Изменения для пользователей Potree

Ведутся в [CHANGELOG.md](CHANGELOG.md).
