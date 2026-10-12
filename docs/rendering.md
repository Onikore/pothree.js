# Отрисовка облаков точек

Документ описывает, **что делает** собственный WebGL-рендерер Potree (`src/PotreeRenderer.js`, класс
`Renderer`) и **как каждая его часть перенесена** на штатные средства three.js
(`src/rendering/PointCloudRenderer.js`, шаг 5 миграции, `MIGRATION_PLAN.md` раздел 6.1).

Старый рендерер удалён (шаг 5b) после проверки попиксельного паритета и производительности
(`PERFORMANCE.md`); его описание ниже оставлено как спецификация того, что воспроизводит новый.

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

## Рендер по требованию (`viewer.renderOnDemand`)

По умолчанию вьюер, как оригинал, рисует каждый кадр (`renderer.setAnimationLoop`) — 60 кадров/с, даже
когда картинка не меняется: CPU (обход октодерева в `update()`) и GPU заняты впустую, ноутбук греется.

`viewer.renderOnDemand = true` — цикл пропускает `update()` и `render()`, пока ничего не меняется.
Кадры рисуются, когда:

- было событие ввода на странице (`pointer*`, `wheel`, `key*`, `input`, `change`, `resize` —
  слушатели на `window`, поэтому срабатывают и ползунки сайдбара);
- грузятся узлы (`state.numNodesLoading > 0`) или идут анимации TWEEN;
- код изменил вид (`scene.view`: позиция, углы, радиус) или состав сцены (облака, объекты,
  аннотации, измерения, объёмы, профили) — дешёвая сигнатура проверяется в простое;
- после кадра изменились матрицы камеры, число нарисованных узлов или размер холста (камера
  докатывается по инерции, загруженные узлы добавляются по несколько за кадр).

После последнего изменения рисуется ещё `Viewer.SETTLE_FRAMES` (10) кадров, затем цикл засыпает.
Изменения, которых сигнатура не видит (материал облака, цвет, свет из своего кода), — вызвать
`viewer.requestRender()`. Проверка: `node tests/visual/ondemand.mjs` (простой без кадров; кадр в простое
совпадает с непрерывной отрисовкой; ввод и смена вида будят цикл).

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
   `backfaceCulling`; текстуры `visibleNodesTexture` (**в шейдере сэмплер называется `visibleNodes`** — старый рендерер ставил несуществующий uniform, а работало потому, что текстура оказывалась в блоке 0, куда смотрит сэмплер без значения), `gradient` (режим повтора — из
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
| picking через `renderer.state`, `gl.scissor`, `gl.readPixels` | **сделано**: scissor у render target, `setClearColor`/`clear`, `readRenderTargetPixels` (`PointCloudOctree.pick`); глубина и смешивание — из материала picking. Асинхронное чтение (`readRenderTargetPixelsAsync`, r165+) — после подъёма до r186 |
| `renderer.resetState()` после облаков | не нужен |

Порядок: старый рендерер рисует узлы в порядке `visibleNodes`, three при `sortObjects = false` —
в порядке обхода графа сцены (узлы вложены в родителей). Порядок рисования непрозрачных точек
на картинку не влияет (тест глубины), а `uPCIndex` для picking берётся не из порядка рисования, а
из индекса узла в `visibleNodes`, записанного при выборе узлов (без `indexOf` на каждый узел).
Для прозрачных облаков (аддитивное смешивание) порядок тоже не важен — сумма коммутативна.

## Новый рендерер: устройство (`src/rendering/PointCloudRenderer.js`)

| Часть | Что делает |
|---|---|
| `render(scene, camera, target, params)` | как раньше: находит облака под `scene`, для каждого `renderOctree` с `octree.visibleNodes` |
| `renderOctree(octree, nodes, camera, target, params)` | текстура видимости → внутренний материал → шейдер → смешивание/глубина → uniforms облака; затем видимыми остаются ровно `nodes`, у них временно подменяются `material` и `onBeforeRender`, и `renderer.render(octree, camera)` рисует их средствами three; после — всё восстанавливается |
| внутренний материал | на каждый `PointCloudMaterial` свой `RawShaderMaterial` (`WeakMap`). В нём **только** uniforms, которые выставлял старый рендерер: остальные uniforms шейдера остаются нулями, как было |
| `updateShader` | исходник материала + `#define` рендера; при изменении — `needsUpdate`, three берёт программу из своего кэша или компилирует |
| `updateBlending` | непрозрачно: без смешивания, тест и запись глубины; `opacity < 1`: `SRC_ALPHA, ONE`, без глубины; `params` переопределяют |
| `onBeforeRenderNode` | uniforms узла: `uNodeData` = (`uLevel`, `uVNStart`, `uPCIndex`, `uNodeSpacing`) одним `vec4` — один вызов GL вместо четырёх (в шейдере старые имена — макросы на компоненты), `uDebug`, clip-полигоны, тени; `uniformsNeedUpdate` |
| `updateAttributeAliases` | один раз на геометрию: `rgba`→`color`, `return number`→`returnNumber` и т.д. (тот же `BufferAttribute`); `aExtra` — на активный «дополнительный» атрибут |

Контекст — WebGL2, шейдеры `src/materials/shaders/*` — GLSL ES 3.0 (`glslVersion: THREE.GLSL3`;
`#version 300 es` добавляет three). Перевод механический: `attribute`→`in`, `varying`→`out`/`in`,
`texture2D`→`texture`, `gl_FragColor`→`out_FragColor`, `gl_FragDepthEXT`→`gl_FragDepth`,
`#extension GL_EXT_frag_depth` убран.

## Приватный API three.js и сырой WebGL

Не используются. В `src/` остались только `gl.getExtension('EXT_color_buffer_float')` (включение
расширения) и `gl.getError()` в логе потери контекста. Единственная опора на недокументированное
поведение three — пропуск uniform с `needsUpdate === false` при заливке (`PointCloudRenderer`,
uniforms облака заливаются с первым узлом), проверено в r152 и r186.

## Производительность

Замеры и методика — `PERFORMANCE.md`. Главное, что выяснилось профилированием (CDP, 10 млн точек,
555 узлов): время уходит в вызовы WebGL (`drawArrays`, `uniform*`), а не в JS three.js. Старый
рендерер делал ~22 000 вызовов GL на кадр (на каждый узел заново `bindBuffer`/`vertexAttribPointer`/
`enableVertexAttribArray` для каждого атрибута), новый — ~2 400 (VAO three, uniforms облака один раз,
поузловые — одним `vec4`). Один вызов `uniform*` в контексте WebGL2 в Chrome дороже, чем в WebGL1.
