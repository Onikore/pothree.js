# Журнал изменений

Изменения форка Potree относительно оригинала (Potree 1.8, ветка `develop` @ 5636cd47).
Подробности по каждому шагу — `MIGRATION_PLAN.md` и `docs/architecture.md` (раздел «Изменения»).

## Не выпущено — ветка `three-upgrade`

three.js r186 (`three@0.186.1`) — последняя стабильная версия на 2026‑10‑12.

### Ломающие изменения

- **Примеры используют ES‑сборку** `build/potree/potree.module.js` (`import * as Potree from "potree"`
  через import map). Глобального `window.Potree` на этих страницах нет; состояние — `Potree.state.*`.
  UMD `potree.js` и глобальный `Potree` для своих страниц остаются (см. `docs/build.md`).

- **three.js больше не лежит в `libs/three.js`.** Он ставится из npm (пакет `three`, версия закреплена в
  `package.json`). Свои страницы, которые импортировали `../libs/three.js/build/three.module.js`,
  должны импортировать `"three"` и подключать его через import map или сборщик (пример — любой файл
  в `examples/`, подробно — `docs/build.md`).
- **Примеры работают только при установленных `node_modules`**: import map в примерах указывает на
  `../node_modules/three/...`. Для выкладки на сервер вместе с примерами нужна папка
  `node_modules/three`.
- `AnimationPath.getGeometry()` возвращает `THREE.BufferGeometry` вместо удалённого из three
  `THREE.Geometry`. Точки — в `geometry.attributes.position`, а не в `geometry.vertices`.
- Геометрии линий и рамок инструментов стали `THREE.BufferGeometry`: `Volume.frame`, `ClipVolume.frame`
  и `planeFrame`, линии `Profile`, рамка `TransformationTool`, `Utils.createGrid()`,
  `Utils.debugLine()`, `Utils.debugCircle()`, рамки ориентированных снимков. Код, читавший или
  менявший `.vertices`, должен работать с `attributes.position`.
- **VR/WebXR удалён.** Больше нет `Potree.VRControls`, кнопки VR, `viewer.vrControls`,
  `viewer.sceneVR`, `viewer.renderVR()`, `scene.cameraVR`, `CameraMode.VR` и событий вьюера
  `vr_start`/`vr_end`. Примеры `vr_*.html` — обычные страницы с данными Potree 2.0 с potree.org.
- **Свет**: в three r155+ интенсивности физические. Свет Potree (`scene.directionalLight`, ambient,
  свет инструментов) пересчитан (× π, у точечных `decay = 0`) — картинка мешей прежняя. **Свои источники
  света умножьте на `Math.PI`** (у Point/SpotLight с `distance = 0` ещё `decay = 0`), иначе меши
  будут темнее.
- `three` — `peerDependency` (`^0.186.0`): для сборки своего проекта ставьте `three` сами.
- **Управление цветом three.js выключено** (`THREE.ColorManagement.enabled = false`, вывод
  `LinearSRGBColorSpace`), чтобы цвета совпадали с оригиналом (three r124 цветом не управлял).
  Potree выключает его в своей копии three при загрузке. Если страница импортирует **свою** копию
  three (как все примеры), выключите и в ней, сразу после импорта:
  `THREE.ColorManagement.enabled = false;` — иначе цвета ваших объектов будут темнее.
- **Нужен WebGL2.** Вьюер создаёт контекст WebGL2 (three.js r163+ не поддерживает WebGL1), шейдеры
  облаков и постобработки переведены на GLSL ES 3.0. EDL и HQ-сплатам нужно расширение
  `EXT_color_buffer_float`. Собственный WebGL-рендерер облаков `Potree.Renderer` удалён, вместо него
  `Potree.PointCloudRenderer` с тем же `render()`/`renderOctree()`.

### Удалено

- **VR/WebXR** (см. выше), **Arena4D** (`.vpc`, `Potree.PointCloudArena4D*`; сервер тестовых данных
  недоступен), **`Potree.DeviceOrientationControls`** (управление гироскопом), **интеграция Cesium**
  (примеры `cesium_*.html`, `annotation_hierarchy.html` и `libs/Cesium`, 13 МБ).
- Неиспользуемый код: `GeoControls`, `DEMWorker`, `InterleavedBuffer`, `BitReader`, `BlurMaterial`,
  шейдеры `pointcloud_dynamic.*`, `pointcloud_sm.*`, `blur.*`, `src/server/getPoints.php`, `libs/MeshLine`.

### Исправлено

- `Potree_update_visibility.js` обращался к несуществующему `Potree.DEM`, `viewer.js` — к
  несуществующему `Potree.resolveQueries` (код никогда не выполнялся) — удалено. `loadProject`
  создавал объёмы через `Potree[data.type]` — теперь через импорт классов.

- **Больше 2048 видимых узлов приводили к падению отрисовки** (`RangeError: offset is out of bounds`):
  текстура видимости узлов была фиксированной 2048 × 1. Это бывает при больших бюджетах точек
  (десятки миллионов) или маленьком минимальном размере узла. Теперь текстура растёт по строкам
  (2048 × N), шейдер читает её через `texelFetch`. Проверено: 50 млн точек, 2 425 узлов.

- Окно профиля дозаливало новые точки на GPU с неверными границами: `updateRange` задавался в точках,
  а three ожидает элементы массива (точки × размер элемента). Старый рендерер перезаливал буфер целиком
  и ошибки не проявлял; теперь — `addUpdateRange` с правильными единицами.

- Выбор точки мышью (picking) у краёв экрана (ближе ~32 px): у двух краёв точка не выбиралась
  (окно чтения обрезалось, а читалось полное), у двух других выбиралась точка ближайшая не к курсору,
  а к середине сдвинутого окна (на ~12 px дальше). Теперь читается видимая часть окна и расстояние
  считается до курсора. В остальной части экрана результат прежний (проверено тестом).

- Облако Potree 2.0 (`metadata.json`) загружалось дважды: метаданные и иерархия скачивались повторно,
  а результат второй загрузки выбрасывался.
- `npm run build` не завершался ошибкой, когда падал rollup.
- В новых three.js методы вроде `Box3.getCenter()`, `Object3D.getWorldDirection()`,
  `getWorldQuaternion()`, `Ray.intersectBox()` требуют вектор-приёмник; без него они падали
  (ориентированные снимки, пример `gradient_colors`, `Scene.estimateHeightAt`, clip volume).
  **В своём коде передавайте приёмник**: `box.getCenter(new THREE.Vector3())`.
- **EPT binary и EPT zstandard не загружались вообще** (с добавления COPC в 2023 г.): их загрузчик
  обращался к удалённому `node.url()` и старым полям узла. Переведён на новый API узлов EPT, как
  загрузчик EPT LAZ.
- Примеры `ept_binary` и `ept_zstandard` не подключали `libs/copc/index.js`, а загрузчик EPT берёт
  `window.Copc` для всех типов EPT. **Свои страницы с EPT должны подключать `libs/copc/index.js`**.

### Изменено

- Панель stats.js (если страница её подключает) обновляется раз в секунду своей панелью FPS вместо
  `stats.begin()/end()` каждый кадр: это стоило 1,6–3,5 мс на кадр (22–40 % на ca13). Панели «мс» и
  «MB» больше не обновляются.
- Отрисовка облаков без поузловых uniform: данные узлов — в текстуре `uNodeTexture`, узел выбирает
  свои тексели атрибутом `aSlot`; `modelMatrix`/`modelViewMatrix` в шейдере точек больше не uniform.
  −16 % CPU на кадр, когда кадр упирается в CPU (805 узлов). Картинка и picking те же.

- Импорт ядра без побочных эффектов, требующих глобальных библиотек: jQuery‑плагин `selectgroup`
  перенесён во вьюер (`src/viewer/selectgroup.js`), регистрация проекций proj4 — ленивая
  (`src/projections.js`). `potree.module.js` грузится на странице без jQuery и proj4.
- `libs/plasio/js/laslaz.js` берёт путь воркера и пул из `state`, а не из глобального `Potree`.

- Глобальное состояние (`pointBudget`, `numNodesLoading`, `lru`, `workerPool`, …) — модуль
  `src/state.js`, экспорт `Potree.state`. Ядро больше не читает глобальный `window.Potree`, поэтому
  работает и как ES‑модуль. В UMD‑сборке `Potree.pointBudget` и прочие поля по‑прежнему работают
  (аксессоры на `state`).

- **Обновлены библиотеки интерфейса** (известные уязвимости в старых версиях): jQuery 3.1.1 → 3.7.1
  (CVE-2019-11358, CVE-2020-11022/11023), jQuery UI 1.12.1 → 1.14.2 (CVE-2021-41182/41183/41184,
  CVE-2022-31160), jstree 3.3.8 → 3.3.17. Файл jQuery теперь `libs/jquery/jquery-3.7.1.min.js` —
  **поправьте путь на своих страницах**. С jQuery 3.5+ самозакрывающиеся теги не-void элементов
  (`<span ... />`) в HTML-строках больше не раскрываются — пишите `<span ...></span>`.
- Меньше работы в каждом кадре: текстура видимости узлов пересчитывается и перезаливается только при
  смене набора узлов; позиции аннотаций пишутся в DOM только при изменении.

- Облака догружаются примерно на треть быстрее: по умолчанию 8 узлов загружаются параллельно вместо 4
  (`Potree.maxNodesLoading`, замер — `PERFORMANCE.md`).

- Picking точнее различает близкие по глубине точки (буфер глубины 24 бита вместо 16, следствие
  three r163): иногда выбирается другая соседняя точка — та, что действительно ближе к камере.

- Быстрее выбор видимых узлов: убрано клонирование камеры каждый кадр; фрустумы clip box считаются
  один раз за кадр, а не для каждого узла.
- Сборка на rollup 4 (`rollup.config.mjs` вместо `rollup.config.js`).
- Собственная кнопка VR Potree перенесена из `libs/three.js/extra/VRButton.js` в
  `src/viewer/VRButton.js`.

### Добавлено

- Рендер по требованию: `viewer.renderOnDemand = true` — в простое кадры не рисуются (0 % GPU, без
  обхода октодерева), ввод, загрузка, анимации и смена вида будят цикл; `viewer.requestRender()` для
  изменений из своего кода. По умолчанию выключено. Подробно — `docs/rendering.md`.

- Минифицированная ES‑сборка `build/potree/potree.module.min.js` (~0,5 МБ, gzip ~124 КБ; UMD — 3 МБ).

- ES‑сборка `build/potree/potree.module.js` с `three` как внешней зависимостью: на странице одна копия
  three.js (раньше две — в `potree.js` и в примере), сборка 0,8 МБ вместо 3 МБ.

- Облака точек рисует three.js (`Potree.PointCloudRenderer`, `src/rendering/PointCloudRenderer.js`):
  `THREE.Points` + `RawShaderMaterial`, без собственного WebGL-рендерера и приватного API three.
  Картинка совпадает с оригиналом попиксельно.

- Визуальный регресс всех примеров и smoke-тест форматов: `node tests/visual/run.mjs`
  (`docs/testing.md`), эталонные скриншоты исходного кода в `tests/visual/baseline/`.
- Примеры `potree2.html` и `potree2_brotli.html` с локальными данными Potree 2.0
  (`pointclouds/lion_takanawa_potree2*`). Примеры `vr_*` грузят Potree 2.0 с potree.org и работают
  только на нём (CORS).
- Документация кода в `docs/`: устройство (`architecture.md`), карта файлов (`modules.md`),
  сборка (`build.md`), тесты (`testing.md`).

### Запланировано

- Отрисовка облаков штатными средствами three.js вместо собственного WebGL-рендерера.
- three.js как `peerDependency`, ES-модульная сборка, две точки входа: ядро и вьюер.
