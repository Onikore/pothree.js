# Отрисовка облаков точек

Документ описывает, **что делает** собственный WebGL-рендерер Potree (`src/PotreeRenderer.js`, класс
`Renderer`) и **как каждая его часть переносится** на штатные средства three.js (шаг 5 миграции,
`MIGRATION_PLAN.md` раздел 6.1). Пока шаг 5 не сделан, работает старый рендерер.

## Как вызывается

Рендереры кадра (`viewer/PotreeRenderer.js`, `EDLRenderer.js`, `HQSplatRenderer.js`), окно профиля и
`PointCloudSM` вызывают `viewer.pRenderer.render(scene, camera, target, params)`.

`render()` обходит сцену (`scene.scenePointCloud`), для каждого видимого облака берёт
`octree.visibleNodes` и вызывает `renderOctree(octree, nodes, camera, target, params)`.
После всех облаков — `threeRenderer.resetState()`.

Параметры `params`:

| Параметр | Кто передаёт | Что делает |
|---|---|---|
| `material` | EDL (тени), HQ (проходы глубины и атрибутов), picking | рисовать другим материалом вместо `octree.material` |
| `shadowMaps` | EDL при включённых тенях | массив `PointCloudSM` |
| `clipSpheres` | все рендереры кадра | сферы clipping (`SphereVolume`) |
| `transparent`, `blendFunc`, `depthTest`, `depthWrite` | HQ, EDL | состояние смешивания и глубины |
| `viewOverride` | VR (удалён), снимки | своя матрица вида |
| `vnTextureNodes` | HQ | узлы для текстуры видимости |

## Что делается на облако (`renderOctree`)

1. **Текстура видимых узлов**: если размер точек `ADAPTIVE` или раскраска «level of detail» —
   `octree.computeVisibilityTextureData(nodes, camera)` пишется в `material.visibleNodesTexture`.
2. **Шейдер**: один `Shader` на материал. К исходникам `material.vertexShader/fragmentShader`
   спереди добавляются `#define`:

   | define | Откуда |
   |---|---|
   | `num_shadowmaps`, `num_snapshots`, `num_clipboxes`, `num_clipspheres`, `num_clippolygons` | число теней, снимков, clip-объёмов |
   | `clip_gps_enabled`, `clip_return_number_enabled`, `clip_number_of_returns_enabled`, `clip_point_source_id_enabled` | есть ли атрибут в корневом узле |

   Остальные `#define` (форма и размер точки, тип раскраски и т.д.) уже в исходнике материала —
   их ставит `PointCloudMaterial.updateShaderSource()`.
3. **Текстуры** материала (`type: "t"`) загружаются в свои GL-текстуры.
4. **Смешивание и глубина**: непрозрачно — без смешивания, с записью глубины; `opacity < 1` —
   аддитивное смешивание `SRC_ALPHA, ONE`, без теста и записи глубины; `params` переопределяют.
5. **Uniforms облака**: `projectionMatrix`, `viewMatrix`, `uViewInv`, `uProjInv`, размер экрана,
   `fov`, `near`, `far`, ортокамера (`uUseOrthographicCamera`, `uOrthoWidth/Height`), `clipTask`,
   `clipMethod`, `clipBoxes`, `uClipSpheres` (матрица «вид → сфера» для каждой сферы), `size`,
   `minSize`, `maxSize`, `uOctreeSpacing`, `uOctreeSize`, `uColor`, `uOpacity`, `elevationRange`,
   `intensityRange`, гамма/яркость/контраст интенсивности и RGB, `uTransition`, веса
   (`wRGB`, `wIntensity`, `wElevation`, `wClassification`, `wReturnNumber`, `wSourceID`),
   `backfaceCulling`; текстуры `visibleNodesTexture`, `gradient` (режим повтора — из
   `elevationGradientRepeat`), `classificationLUT`, `matcapTextureUniform`; снимки
   (`uSnapshot`, `uSnapshotDepth`, `uSnapView/Proj/ProjInv/ViewInv`) — текстуры через приватное
   `threeRenderer.properties.get(tex).__webglTexture`.

## Что делается на узел (`renderNodes`)

| Что | Значение |
|---|---|
| `modelMatrix`, `modelViewMatrix` | матрица узла и вид × узел |
| `uVNStart` | смещение узла в текстуре видимости |
| `uLevel`, `uNodeSpacing`, `uPCIndex` | уровень узла, шаг точек, порядковый номер узла в кадре (для picking) |
| `uDebug` | подсветка отладочного узла |
| `uClipPolygonWVP`, `uClipPolygonVCount`, `uClipPolygonVertices` | для каждого clip-полигона: проекция × вид полигона × **матрица узла** |
| `uShadowWorldView`, `uShadowProj`, `uShadowMap` | для каждой тени: вид тени × **матрица узла**; текстура тени — приватное `__webglTexture` |
| `uGpsScale`, `uGpsOffset`, `uFilterGPSTimeClipRange` | перевод GPS time узла в нормированный диапазон облака |
| `uFilterReturnNumberRange`, `uFilterNumberOfReturnsRange`, `uFilterPointSourceIDClipRange` | фильтры |
| VBO/VAO | свои буферы на `BufferGeometry`, обновляются по `attribute.version` |
| атрибуты | по таблице имён (`attributeLocations`): `rgba`→`color`, `return number`→`returnNumber`, `source id`→`pointSourceID`, `gps-time`→`gpsTime` и т.д.; активный «дополнительный» атрибут подключается как `aExtra` со своими `uExtraScale/uExtraOffset` |
| рисование | `gl.drawArrays(gl.POINTS, 0, numPoints)` |

## Перенос на three.js (шаг 5)

| Сейчас | Будет |
|---|---|
| свои VBO/VAO | `BufferGeometry` узла рисует сам three (`THREE.Points`, уже есть у узла: `node.sceneNode`) |
| свой `Shader` + `#define` | `RawShaderMaterial` с `glslVersion: THREE.GLSL3`; `defines` материала; `customProgramCacheKey` по набору define |
| per-node uniforms | `sceneNode.onBeforeRender` пишет `uLevel`, `uVNStart`, `uPCIndex`, `uNodeSpacing`, `uDebug` в `material.uniforms` и ставит `uniformsNeedUpdate` (как в potree-core) |
| clip-полигоны и тени × матрица узла | матрицы без узла передаются uniform облака, умножение на `modelMatrix` — в шейдере (меньше работы на CPU на узел) |
| имена атрибутов с пробелами | при создании геометрии узла добавляются псевдонимы с GLSL-именами на **тот же** `BufferAttribute` (`geometry.setAttribute('returnNumber', attr)`) — повторной загрузки на GPU нет, three кэширует буфер по объекту атрибута |
| `aExtra` | псевдоним `aExtra` на активный атрибут, переключается при смене `activeAttributeName` |
| текстуры через `__webglTexture` | обычные uniforms-текстуры three (`texture` render target'а) |
| состояние смешивания и глубины | свойства материала: `blending`, `blendSrc/Dst`, `depthTest`, `depthWrite`, `transparent` |
| picking через `renderer.state` | материал picking с нужными свойствами + `readRenderTargetPixelsAsync` |
| `renderer.resetState()` после облаков | не нужен |

Порядок: старый рендерер рисует узлы в порядке `visibleNodes`, three при `sortObjects = false` —
в порядке обхода графа сцены (узлы вложены в родителей). Порядок рисования непрозрачных точек
на картинку не влияет (тест глубины), а `uPCIndex` для picking берётся не из порядка рисования, а
из индекса узла в `visibleNodes`, записанного при выборе узлов (без `indexOf` на каждый узел).
Для прозрачных облаков (аддитивное смешивание) порядок тоже не важен — сумма коммутативна.
