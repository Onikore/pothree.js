# Карта исходников Potree

Назначение каждого файла в `src/`. Общая картина — `docs/architecture.md`.
Метка **мёртвый** — файл нигде не импортируется (проверено `grep` по `src/` на 2026‑10‑12).
Метка **WebGL** — файл напрямую работает с WebGL или внутренностями three; переписывается в миграции.

## Ядро (`src/`)

| Файл | Строк | Назначение |
|---|---|---|
| `threeSetup.js` | 18 | глобальные настройки three.js для Potree (выключает управление цветом r152+); импортируется первым |
| `Potree.js` | 306 | точка входа: реэкспорт всего API, глобальное состояние (`pointBudget`, `lru`, `workerPool`, пути), `loadPointCloud()`, jQuery-плагин `selectgroup` |
| `Potree_update_visibility.js` | 416 | LOD: `updatePointClouds()` → `updateVisibility()` — выбор видимых узлов по приоритету, бюджет точек, очередь загрузки |
| `PointCloudTree.js` | 50 | базовые классы `PointCloudTree` (Object3D) и `PointCloudTreeNode` |
| `PointCloudOctree.js` | 1153 | облако в сцене: узлы (`toTreeNode`), текстура видимых узлов, picking (`pick`), профиль, `getPointsInBox`, bbox, `find` |
| `PointCloudOctreeGeometry.js` | 269 | геометрия Potree 1.x: узел, URL узла, загрузка иерархии и точек |
| `PointCloudEptGeometry.js` | 319 | геометрия EPT: ключи узлов, иерархия EPT |
| `rendering/PointCloudRenderer.js` | ~590 | отрисовка облаков средствами three.js (заменил удалённый `PotreeRenderer.js`); см. `docs/rendering.md` |
| ~~`PotreeRenderer.js`~~ | 1483 | удалён в шаге 5b: собственный WebGL-рендерер облаков (шейдеры, VBO/VAO, uniforms, текстуры, `drawArrays`) |
| `ProfileRequest.js` | 392 | `ProfileData`, `ProfileRequest` — асинхронный сбор точек вдоль полосы профиля |
| `LRU.js` | 173 | LRU узлов; `freeMemory()` выгружает узлы сверх `pointLoadLimit` |
| `WorkerPool.js` | 27 | пул воркеров по URL скрипта |
| `XHRFactory.js` | 31 | создание `XMLHttpRequest` с `withCredentials` и своими заголовками |
| `Features.js` | 40 | что поддерживает WebGL2 браузера сверх базового (`SHADER_EDL`, `SHADER_SPLATS` — float render targets) |
| `defines.js` | 55 | перечисления: `PointSizeType`, `PointShape`, `ClipTask`, `ClipMethod`, `CameraMode`, `LengthUnits`, `MOUSE`, `TreeType`, `ElevationGradientRepeat` |
| `Enum.js` | 43 | класс `Enum` (используется в `utils/GeoTIFF.js`) |
| `EventDispatcher.js` | 98 | события (`addEventListener`, `dispatchEvent`, `removeEventListeners`) |
| `Actions.js` | 83 | `Action` — кнопка/действие с иконкой и подсказкой |
| `Annotation.js` | 573 | аннотация: DOM-метка в 3D, иерархия, полёт камеры к аннотации |
| `AnimationPath.js` | 140 | путь анимации (сплайн) |
| `TextSprite.js` | 146 | текстовый спрайт (подписи измерений) |
| `Points.js` | 49 | контейнер набора точек (данные профиля, выборки) |
| `utils.js` | 1098 | `Utils`: загрузка skybox, сетка, луч из мыши, `getMousePointCloudIntersection`, отладочная геометрия, виды камеры, азимут, `generateDataTexture` и др. |
| `Version.js` | 44 | разбор и сравнение строки версии `"major.minor"` (версии форматов в метаданных) |
| `KeyCodes.js` | 19 | коды клавиш |

## Расширения three (`src/extensions/`)

Патчат прототипы three при импорте.

| Файл | Что добавляет |
|---|---|
| `OrthographicCamera.js`, `PerspectiveCamera.js` | `zoomTo(node, factor)` |
| `Ray.js` | `distanceToPlaneWithNegative` |

## Загрузчики (`src/loader/`, `src/modules/loader/2.0/`)

| Файл | Формат |
|---|---|
| `loader/POCLoader.js` | Potree 1.x (`cloud.js`) |
| `loader/BinaryLoader.js` | узлы Potree 1.x в бинарном формате |
| `loader/LasLazLoader.js` | узлы Potree 1.x в LAS/LAZ (через `LASLAZWorker`) |
| `loader/PointAttributes.js` | описание атрибутов точек Potree 1.x |
| `loader/EptLoader.js` | EPT (`ept.json`), COPC (`.copc.laz`) |
| `loader/ept/BinaryLoader.js`, `LaszipLoader.js`, `ZstandardLoader.js` | узлы EPT по типу данных |
| `loader/ShapefileLoader.js` | шейп-файлы → линии three |
| `loader/GeoPackageLoader.js` | GeoPackage (лениво грузит `geopackage`, `sql.js`) |
| `modules/loader/2.0/OctreeLoader.js` | Potree 2.0 (`metadata.json`, `hierarchy.bin`, `octree.bin`) |
| `modules/loader/2.0/OctreeGeometry.js` | геометрия и узел Potree 2.0 |
| `modules/loader/2.0/DecoderWorker.js`, `DecoderWorker_brotli.js` | воркеры декодирования Potree 2.0 |

## Воркеры (`src/workers/`)

| Файл | Что декодирует |
|---|---|
| `BinaryDecoderWorker.js` | бинарные узлы Potree 1.x |
| `LASDecoderWorker.js`, `LazLoaderWorker.js`, `LASLAZWorker.js` | LAS/LAZ (laz-perf из `libs/plasio`) |
| `EptBinaryDecoderWorker.js`, `EptLaszipDecoderWorker.js`, `EptZstandardDecoderWorker.js` (+ `_preamble`) | узлы EPT |

## Материалы и шейдеры (`src/materials/`)

| Файл | Назначение |
|---|---|
| `PointCloudMaterial.js` | материал облака: все настройки отображения → `#define` + uniforms; градиенты, matcap, LUT классификации |
| `EyeDomeLightingMaterial.js` | проход EDL |
| `NormalizationMaterial.js`, `NormalizationEDLMaterial.js` | нормализация взвешенных splats (HQ), с EDL и без |
| `ClassificationScheme.js` | цвета и видимость классов ASPRS по умолчанию |
| `Gradients.js` | градиенты (spectral, rainbow, viridis, …) |
| `shaders/pointcloud.vs/.fs` | основной шейдер облака (GLSL ES 1.0) |
| `shaders/edl.*`, `normalize*.*` | постпроцесс |

## Вьюер (`src/viewer/`)

| Файл | Назначение |
|---|---|
| `viewer.js` | `Viewer`: создание WebGL-контекста и `WebGLRenderer`, цикл `loop/update/render`, настройки, drag&drop (VR-рендер удалён в форке) |
| `Scene.js` | `Scene`: камеры, облака, измерения, объёмы, профили, аннотации, изображения |
| `View.js` | положение камеры как `position` + `yaw/pitch` + `radius` |
| `PotreeRenderer.js` | рендерер кадра без EDL |
| `EDLRenderer.js` | рендерер кадра с EDL, скриншоты, shadow map |
| `HQSplatRenderer.js` | рендерер кадра с взвешенными splats |
| `NavigationCube.js` | куб навигации |
| `map.js` | мини-карта на OpenLayers |
| `profile.js`, `profile.html` | окно профиля высот (d3) |
| `sidebar.js`, `sidebar.html`, `potree.css` | боковая панель (jQuery UI, jstree, spectrum) |
| `PropertyPanels/*.js` | панели свойств выбранного объекта (облако, измерения, объёмы, камера, анимация) |
| `HierarchicalSlider.js` | слайдер диапазона (фильтр GPS time) |
| `LoadProject.js`, `SaveProject.js` | проект в JSON (облака, измерения, объёмы, аннотации, вид) |

## Навигация (`src/navigation/`)

| Файл | Режим |
|---|---|
| `InputHandler.js` | мышь, клавиатура, касания; выбор и перетаскивание объектов, раздача событий контролам |
| `OrbitControls.js` | вращение вокруг точки |
| `EarthControls.js` | «хватай землю» |
| `FirstPersonControls.js` | полёт |

## Инструменты (`src/utils/`)

| Файл | Назначение |
|---|---|
| `Measure.js`, `MeasuringTool.js` | измерения (точка, расстояние, высота, площадь, угол, круг, азимут) и инструмент их создания |
| `Profile.js`, `ProfileTool.js` | профиль высот (полоса) и его создание |
| `Volume.js`, `VolumeTool.js` | объёмы (box, sphere) и их создание |
| `ClipVolume.js`, `PolygonClipVolume.js`, `ClippingTool.js` | clipping box и polygon |
| `ScreenBoxSelectTool.js` | выделение прямоугольником на экране |
| `AnnotationTool.js` | создание аннотаций |
| `TransformationTool.js` | гизмо перемещения, вращения, масштаба |
| `PointCloudSM.js` | shadow map облака |
| `Box3Helper.js`, `SpotLightHelper.js` | отладочные помощники |
| `Compass.js` | компас |
| `Message.js` | всплывающие сообщения |
| `GeoTIFF.js` | чтение GeoTIFF |

## Модули (`src/modules/`)

| Папка | Назначение |
|---|---|
| `OrientedImages/` | ориентированные снимки: загрузка, проекция в 3D, контролы просмотра |
| `Images360/` | 360° панорамы |
| `CameraAnimation/` | анимация камеры по ключевым точкам |

## Экспорт (`src/exporter/`)

`CSVExporter`, `LASExporter` (точки профиля, вызываются из `viewer/profile.js`), `DXFExporter`, `DXFProfileExporter`, `GeoJSONExporter`
(измерения).

## Прочее

| Путь | Назначение |
|---|---|
| `src/tools/` | генерация страниц примеров и иконок (Node, при сборке) |

## Удалено в форке

VR (`VRControls`, `VRButton`), Arena4D (`src/arena4d/`, формат `.vpc`), `DeviceOrientationControls`,
`GeoControls`, мёртвый код (`DEMWorker`, `InterleavedBuffer`, `BitReader`, `BlurMaterial`, шейдеры
`pointcloud_dynamic.*`, `pointcloud_sm.*`, `blur.*`, `src/server/getPoints.php`, `libs/MeshLine`),
интеграция Cesium (примеры `cesium_*`, `annotation_hierarchy`, `libs/Cesium`), собственный WebGL-рендерер
`PotreeRenderer.js`. Причины — `MIGRATION_PLAN.md`, решения J и K.
