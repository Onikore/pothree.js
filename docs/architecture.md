# Как устроен Potree (исходное состояние, develop @ 5636cd47)

Документ описывает код **до миграции**. Что меняется по ходу миграции — в `MIGRATION_PLAN.md`
и в разделе «Изменения» в конце этого файла. Карта всех файлов — `docs/modules.md`.

## Слои

```
 examples/*.html           страницы-примеры: создают Viewer, грузят облака, настраивают UI
        │
 src/viewer/*              Viewer: цикл кадра, UI (jQuery-сайдбар), рендереры кадра, проекты
        │
 src/utils/*, modules/*    инструменты (измерения, профиль, clipping, аннотации, изображения, анимация)
        │
 src/navigation/*          контролы камеры (Orbit, Earth, FirstPerson, VR)
        │
 src/PointCloudOctree.js   облако в сцене: дерево узлов, материал, picking, запросы точек
 src/Potree_update_visibility.js   выбор видимых узлов (LOD) и очередь загрузки
 src/PotreeRenderer.js     собственный WebGL-рендерер облаков
 src/materials/*           материалы и GLSL-шейдеры
        │
 src/loader/*, modules/loader/2.0/*   загрузчики форматов (иерархия + точки узла)
 src/workers/*             декодирование точек в воркерах
        │
 three (npm)               three.js из node_modules (до миграции — вшитая копия libs/three.js r124)
```

## Глобальное состояние

Модуль `src/Potree.js` — точка входа сборки. Rollup собирает его в UMD `build/potree/potree.js`
с глобальным `window.Potree`. Важные глобальные значения:

| Имя | Что это |
|---|---|
| `Potree.pointBudget` | общий бюджет точек на кадр для всех облаков (по умолчанию 1 000 000) |
| `Potree.maxNodesLoading` | сколько узлов можно грузить одновременно (4) |
| `Potree.numNodesLoading` | сколько узлов грузится прямо сейчас; эталонные тесты ждут, пока станет 0 |
| `Potree.lru` | LRU-кэш загруженных узлов; выгружает узлы сверх бюджета |
| `Potree.workerPool` | пул воркеров декодирования |
| `Potree.scriptPath`, `Potree.resourcePath` | откуда грузить воркеры и ресурсы (вычисляется по URL скрипта) |
| `Potree.framenumber` | номер кадра |

Код ядра обращается к этим значениям через глобальный `Potree.*` и через `exports.*`
(`Potree_update_visibility.js`). Это работает только в UMD-сборке: при импорте как ES-модуль
без глобального `Potree` ломается. Исправляется в шаге 1 миграции.

## Путь точки: от URL до экрана

### 1. Загрузка облака

`Potree.loadPointCloud(url, name, callback)` (`src/Potree.js`) выбирает загрузчик по URL:

| URL содержит | Загрузчик | Формат |
|---|---|---|
| `cloud.js` | `POCLoader` → `PointCloudOctreeGeometry` | Potree 1.x (узлы — файлы `.bin` или `.las/.laz`) |
| `metadata.json` | `OctreeLoader` (`modules/loader/2.0`) → `OctreeGeometry` | Potree 2.0 (один `octree.bin` + `hierarchy.bin`, опционально Brotli) |
| `ept.json` | `EptLoader` → `PointCloudEptGeometry` | Entwine Point Tile (binary, laszip, zstandard) |
| `.copc.laz` | `CopcLoader` | Cloud Optimized Point Cloud |
| `.vpc` | `PointCloudArena4DGeometry` | Arena4D (kd-дерево) |

Загрузчик читает только метаданные и корень иерархии. Результат — **геометрия облака**
(дерево `*GeometryNode` с bbox, числом точек и уровнем), из неё создаётся
`PointCloudOctree` (`THREE.Object3D`), который добавляют в `viewer.scene.addPointCloud(...)`.

Точки узла грузятся лениво: `geometryNode.load()` → fetch → воркер декодирует буфер в typed
arrays → `THREE.BufferGeometry` с атрибутами (`position`, `rgba`, `intensity`, `classification`, …)
→ `geometryNode.loaded = true`.

### 2. Кадр

`Viewer.loop()` → `update()` → `render()` каждый `requestAnimationFrame`.

`update()` (`viewer.js`):
1. Переносит настройки вьюера в материалы облаков (размер точек, раскраска, фильтры, clipping).
2. Вызывает `Potree.updatePointClouds(pointclouds, camera, renderer)` — выбор узлов (ниже).
3. Обновляет контролы, аннотации, инструменты, камеру.

`render()` выбирает рендерер кадра (`getPRenderer`):

| Условие | Рендерер кадра | Что делает |
|---|---|---|
| по умолчанию | `viewer/PotreeRenderer.js` | фон → облака → сцена three → инструменты |
| `useEDL` | `viewer/EDLRenderer.js` | облака в render target с глубиной в альфе → проход EDL → композиция |
| `useHQ` | `viewer/HQSplatRenderer.js` | два прохода (глубина, взвешенные атрибуты) → нормализация |

Все три рисуют облака через `viewer.pRenderer` (`src/PotreeRenderer.js`, класс `Renderer`), а
остальную сцену — штатным `THREE.WebGLRenderer.render`. Оба работают в одном WebGL1-контексте.

### 3. Выбор видимых узлов (LOD)

`updateVisibility()` (`src/Potree_update_visibility.js`):

- Обход дерева по **очереди с приоритетом** (`BinaryHeap`). Вес узла — его радиус в пикселях
  на экране (`screenPixelRadius`); узел, внутри которого стоит камера, — максимальный вес.
- Узел видим, если он в frustum, укладывается в общий и в свой бюджет точек, не глубже `maxLevel`,
  и проходит отсев по clip box. Уровни 0–2 видимы всегда.
- Дочерние узлы меньше `minimumNodePixelSize` пикселей отбрасываются.
- Как только бюджет точек исчерпан — обход останавливается.
- Загруженный, но ещё не превращённый в узел сцены `geometryNode` превращается в
  `PointCloudOctreeNode` (`toTreeNode`), не больше 2 за кадр — чтобы не было рывков.
- Незагруженные видимые узлы ставятся в загрузку, не больше `maxNodesLoading` одновременно.
- `lru.touch(...)` отмечает использование, `lru.freeMemory()` выгружает лишнее.

`PointCloudOctree.updateMaterial()` затем пишет **текстуру видимых узлов**
(`computeVisibilityTextureData`): для каждого видимого узла — какие дети тоже видимы и где их
искать. Шейдер по ней считает адаптивный размер точки (`PointSizeType.ADAPTIVE`).

### 4. Рисование облаков

Каждый узел сцены — `THREE.Points` (`node.sceneNode`) с общим `PointCloudMaterial`, но
**three.js их не рисует**. Облака лежат в отдельной сцене `scene.scenePointCloud`, её
обходит `Renderer.render()` (`src/PotreeRenderer.js`):

- для каждой `BufferGeometry` создаёт свои VBO и VAO (`createBuffer`/`updateBuffer`);
- компилирует шейдер из `material.vertexShader/fragmentShader` своим классом `Shader`
  (кэш `Map` по материалу; при смене исходника шейдер пересобирается);
- на каждый узел выставляет uniforms (`level`, `vnStart`, `pcIndex`, матрицы, clipping, фильтры)
  и вызывает `gl.drawArrays(gl.POINTS, …)`;
- чтобы взять текстуры render target'ов three (shadow map, EDL), читает приватное
  `threeRenderer.properties.get(tex).__webglTexture`.

После рендера облаков вызывается `renderer.resetState()`, чтобы three не запутался в состоянии GL.

### 5. Материал и шейдеры

`PointCloudMaterial` (`src/materials/PointCloudMaterial.js`) — `THREE.RawShaderMaterial`,
но собирается вручную: свойства (`size`, `shape`, `pointSizeType`, `activeAttributeName`,
`gradient`, clipping, …) при изменении вызывают `updateShaderSource()`, который склеивает
`#define` + `Shaders['pointcloud.vs'|'pointcloud.fs']`. Исходники шейдеров на этапе сборки
gulp вклеивает в `build/shaders/shaders.js` как строки.

Шейдеры GLSL ES 1.0. Вершинный `pointcloud.vs` (~1000 строк) считает цвет по выбранному
атрибуту, размер точки, фильтры (return number, number of returns, GPS time, point source id),
clipping (box, polygon, sphere, plane). Фрагментный — форму точки (квадрат, круг, параболоид),
глубину для EDL и взвешенных splats.

### 6. Picking

`Utils.getMousePointCloudIntersection()` → `PointCloudOctree.pick(viewer, camera, ray)`:
рисует узлы на луче в маленький render target материалом, кодирующим индекс узла и точки в
цвет, читает пиксели `gl.readPixels`, по индексу достаёт точку из геометрии. Состояние глубины и
смешивания переключает через приватный `renderer.state`.

### 7. Запросы точек

`ProfileRequest` (`src/ProfileRequest.js`) — единственный «запрос точек»: обходит узлы,
пересекающие полосу профиля, догружает их до нужного уровня и собирает точки порциями по
времени (≤ 5 мс за кадр). Используется окном профиля (`viewer/profile.js`) и `PointCloudOctree.getPointsInProfile`.

## События

`Viewer`, `Scene`, `PointCloudOctree`, измерения и инструменты наследуют `EventDispatcher`.
Основные события вьюера: `update_start`, `update`, `render.pass.begin`, `render.pass.scene`,
`render.pass.perspective_overlay`, `render.pass.end`, `scene_changed`, `camera_changed`.
Расширения встраиваются в кадр именно через `render.pass.*`.

## Сборка

Подробно — `docs/build.md`. Кратко, `npm run build` = `gulp build pack`:
- rollup: `src/Potree.js` → UMD `build/potree/potree.js` (three.js вшит, `treeshake: false`,
  без минификации); воркеры Potree 2.0 → ES-модули;
- gulp: склейка остальных воркеров (`LASLAZWorker`, `Ept*Worker`), копирование ресурсов, ленивых
  библиотек (`geopackage`, `sql.js`), вклейка шейдеров в `build/shaders/shaders.js`.

Вес сборки на 2026‑10‑12: `potree.js` 2,2 МБ (466 КБ gzip, из них three r124 — ~240 КБ gzip),
воркеры 5,1 МБ (`EptZstandardDecoderWorker` 3,0 МБ, `LASLAZWorker` 1,6 МБ), ресурсы 4,8 МБ,
ленивые библиотеки 11 МБ. Воркеры и ленивые библиотеки грузятся только при использовании
соответствующего формата.

## Проблемы, найденные при разборе

Статус — в последней колонке.

| Где | Что | Статус |
|---|---|---|
| `src/Potree.js`, ветка `metadata.json` | облако Potree 2.0 грузится **дважды**: `Potree.OctreeLoader.load(path).then(...)` и сразу `OctreeLoader.load(path, callback)` | **исправлено в шаге 2** |
| `src/Potree.js`, ветка `.vpc` | `PointCloudArena4DGeometry`/`PointCloudArena4D` не импортированы — `ReferenceError` при загрузке `.vpc` | **исправлено в шаге 2** (импорты и ES-экспорты); сервер тестовых данных Arena4D отвечает 503, работу проверить нельзя |
| `src/Potree.js` | при импорте регистрирует jQuery-плагин `$.fn.selectgroup` — ядро не работает без глобального jQuery | шаг 7а |
| ядро (`Potree_update_visibility.js`, `ProfileRequest.js`, `PotreeRenderer.js` и др.) | `exports.lru`, `exports.resourcePath`, `Potree.pointBudget` — работает только в UMD | шаг 2: `exports.*` → `Potree.*` (в UMD это один объект, поведение то же, но сборка больше не зависит от имени параметра обёртки). Глобальное состояние целиком — шаг 7а |
| `src/Potree_update_visibility.js` | `camera.clone()` каждый кадр на каждое облако, результат не используется | **исправлено в шаге 2** |
| `src/Potree_update_visibility.js` | отсев по clip box создаёт ~20 объектов three на каждый узел × каждый box каждый кадр | **исправлено в шаге 2**: фрустум clip box считается раз за кадр на пару (облако, box) — `computeClipBoxFrustum` |
| `src/Potree_update_visibility.js` | `p.dem instanceof Potree.DEM` — класса `DEM` в коде нет; упадёт, если включить `generateDEM` | открыто |
| `src/workers/DEMWorker.js`, `shaders/pointcloud_dynamic.*` | нигде не используются | открыто (удаление — по согласованию) |
| `build/potree/potree.js` | не минифицирован, tree-shaking выключен | шаг 7а |
| `src/utils/Profile.js` | линия профиля задавала цвета вершин через `THREE.VertexColors`, которого в r124 уже нет (`undefined`) — цвета не применялись | оставлено как было (линия цвета по умолчанию), комментарий в коде |
| `src/utils.js` `createBackgroundTexture` | шум фона через `Math.random()` — фон «gradient» отличается от запуска к запуску | открыто |

## Изменения в ходе миграции

| Шаг | Что изменилось |
|---|---|
| 1 | three.js берётся из npm (`three@0.124.0`, тот же r124), `libs/three.js` удалена; импорты в `src/` и примерах — `"three"`, `"three/examples/jsm/..."`; примеры получили import map. Собственный `VRButton` Potree перенесён в `src/viewer/VRButton.js`. Сборка — rollup 4 (`rollup.config.mjs`), ошибка rollup валит `npm run build`. Подробно — `docs/build.md`. |
| 2 | `THREE.Math` → `THREE.MathUtils`; `RGBFormat` → `RGBAFormat` (фон-градиент); все `THREE.Geometry` (линии и рамки измерений, профиля, объёмов, clip volume, гизмо, сетки, отладочные линии, путь анимации, рамки ориентированных снимков) → `BufferGeometry.setFromPoints`, обновление вершин — через `attributes.position.setXYZ`; исправлены ошибки и аллокации из таблицы «Проблемы». |
