# Журнал изменений

Изменения форка Potree относительно оригинала (Potree 1.8, ветка `develop` @ 5636cd47).
Подробности по каждому шагу — `MIGRATION_PLAN.md` и `docs/architecture.md` (раздел «Изменения»).

## Не выпущено — ветка `three-upgrade`

Идёт миграция на актуальный three.js. Сейчас three.js r152 (`three@0.152.2`), цель — r186.

### Ломающие изменения

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
- **Управление цветом three.js выключено** (`THREE.ColorManagement.enabled = false`, вывод
  `LinearSRGBColorSpace`), чтобы цвета совпадали с оригиналом (three r124 цветом не управлял).
  Potree выключает его в своей копии three при загрузке. Если страница импортирует **свою** копию
  three (как все примеры), выключите и в ней, сразу после импорта:
  `THREE.ColorManagement.enabled = false;` — иначе цвета ваших объектов будут темнее.
- Поддержка WebGL1 будет прекращена (three.js r163+ её не имеет). Пока ещё работает.

### Исправлено

- Облако Potree 2.0 (`metadata.json`) загружалось дважды: метаданные и иерархия скачивались повторно,
  а результат второй загрузки выбрасывался.
- Загрузка Arena4D (`.vpc`) падала с `ReferenceError`: загрузчик не был импортирован. Классы
  `PointCloudArena4D`, `PointCloudArena4DGeometry` и их узлы теперь экспортируются из `Potree`.
  Проверить работу нельзя: сервер тестовых данных Arena4D недоступен.
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

- Быстрее выбор видимых узлов: убрано клонирование камеры каждый кадр; фрустумы clip box считаются
  один раз за кадр, а не для каждого узла.
- Сборка на rollup 4 (`rollup.config.mjs` вместо `rollup.config.js`).
- Собственная кнопка VR Potree перенесена из `libs/three.js/extra/VRButton.js` в
  `src/viewer/VRButton.js`.

### Добавлено

- Облака точек рисует three.js (`Potree.PointCloudRenderer`, `src/rendering/PointCloudRenderer.js`):
  `THREE.Points` + `RawShaderMaterial`, без собственного WebGL-рендерера и приватного API three.
  Картинка совпадает с оригиналом попиксельно. Временно можно вернуть старый рендерер:
  `Potree.pointCloudRenderer = "legacy"` до создания вьюера.

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
