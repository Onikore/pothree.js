# Операции над облаком (шаг 8)

Каркас для операций над точками: выборка точек в области, выделение, скрытие, правка атрибутов,
отмена/повтор, сохранение правок, единый реестр операций. Замысел — `MIGRATION_PLAN.md`, раздел 6.2.
Код — `src/operations/`.

| Модуль | Что делает |
|---|---|
| `PointQuery.js` | `queryPoints(pointclouds, region)` — загруженные точки внутри области; области `BoxRegion`, `SphereRegion`, `ScreenPolygonRegion`; `worldPositions(chunk)`, `countPoints(chunks)`, `loadedNodes(pc)` |
| `EditLayer.js` | `EditLayer` — правки одного облака (флаги «выделена»/«скрыта», правки атрибутов), стек отмены, `toJSON`/`fromJSON`; `editLayerOf(pc)`; `EditFlags` |
| `Operations.js` | `viewer.operations` — реестр (`register`, `run`, `list`) и встроенные операции |

## Четыре вида операций

| Вид | Что делает | Где | Встроенные |
|---|---|---|---|
| `view` | меняет только отображение | шейдер | (раскраски, фильтры и clipping Potree — пока не в реестре) |
| `query` | читает точки | `queryPoints` | `selection.stats`, `query.count` |
| `edit` | меняет точки через `EditLayer`, отменяемо | `EditLayer` + атрибут `aEdit` | `selection.region`, `selection.clear`, `selection.hide`, `edits.showAll`, `selection.setAttribute`, `edits.undo`, `edits.redo` |
| `compute` | считает новые данные | (будущее: воркеры) | — |

## Использование

```js
import * as Potree from "potree";

// область: единичный куб, преобразованный матрицей (как BoxVolume Potree)
const volume = new Potree.BoxVolume();
volume.scale.set(10, 10, 5);
volume.position.set(x, y, z);
viewer.scene.addVolume(volume);
volume.updateMatrixWorld();

await viewer.operations.run("selection.region", {region: new Potree.BoxRegion(volume.matrixWorld)});
await viewer.operations.run("selection.region", {region: anotherRegion, mode: "add"});   // или "remove"
const {count, boundingBox} = await viewer.operations.run("selection.stats");
await viewer.operations.run("selection.setAttribute", {attribute: "classification", value: 2});
await viewer.operations.run("selection.hide");
await viewer.operations.run("edits.undo");

// лассо: многоугольник в NDC (-1..1) для текущей камеры
const region = new Potree.ScreenPolygonRegion(viewer.scene.getActiveCamera(), [[-0.5, -0.5], [0.5, -0.5], [0, 0.5]]);

// своя операция
viewer.operations.register({
	id: "my.lowPoints",
	kind: "query",
	label: "Points below z = 10",
	run(ctx, {z = 10}) {
		let n = 0;
		for (const chunk of ctx.query(ctx.pointclouds, null)) {
			const p = Potree.worldPositions(chunk);
			for (let k = 2; k < p.length; k += 3) if (p[k] < z) n++;
		}
		return n;
	},
});
await viewer.operations.run("my.lowPoints", {z: 5});

// сохранить / загрузить правки (исходные данные не меняются)
const json = Potree.editLayerOf(pointcloud).toJSON();
Potree.editLayerOf(pointcloud).fromJSON(json);
```

`ctx` операции: `{viewer, pointclouds, query, edits}`. `pointclouds` — `params.pointclouds` или все
видимые облака сцены, `query` — `queryPoints`, `edits(pc)` — `EditLayer` облака. `run` всегда
возвращает промис; после операции вида `edit` вьюер перерисовывается (`requestRender`, см. рендер по
требованию). Реестр шлёт события `registered` и `ran`, `EditLayer` — `changed`.

## PointQuery

Работает по **загруженным** точкам: узлы дерева облака (`PointCloudOctreeNode` с `sceneNode`),
то есть то, что было нарисовано и ещё не выгружено LRU. Каждая точка Potree 1.x / 2.0 / EPT / COPC
лежит ровно в одном узле — дубликатов нет. Узлы, чей bbox не пересекает область, пропускаются без
чтения точек. Положение точки считается в мире той же матрицей `sceneNode.matrixWorld`, с которой
точка рисуется. Результат — порции `{pointcloud, node, name, indices}` по узлам.

Область — любой объект с `intersectsBox(worldBox3)` (отсев узлов) и `tester(nodeMatrixWorld)`,
возвращающим `(x, y, z) => boolean` для координат узла. Встроенные: `BoxRegion(matrixWorld)`,
`SphereRegion(center, radius)`, `ScreenPolygonRegion(camera, ndcPolygon)`.

`queryPointsAsync` — то же, но уступает браузеру каждые ~8 мс (по узлам), чтобы выборка по десяткам
миллионов точек не замораживала страницу; в операциях — `ctx.queryAsync`. Воркеры не используем:
копирование координат в воркер дороже самой выборки. Незагруженные точки (глубже текущего LOD) не
видны; «догрузить до уровня N» — когда понадобится.

## EditLayer

Своя на каждое облако (`pointcloud.editLayer`, создаётся `editLayerOf`). Правки хранятся по имени
узла:

- **флаги** — `Uint8Array` на точку (`EditFlags.SELECTED = 1`, `HIDDEN = 2`). Этот же массив —
  атрибут `aEdit` узла, поэтому изменение — одна заливка буфера узла;
- **правки атрибутов** — `имя атрибута → Map(индекс → значение)`; пишутся прямо в геометрию узла
  (например, `classification`) и накладываются заново при повторной загрузке узла. Исходные
  значения запоминаются (`originals`), правка, вернувшая исходное значение, удаляется.

Каждое изменение — команда `{label, changes}` в стеке отмены: `execute`, `undo`, `redo`.
Команды строят `flagCommand`, `flagsCommand`, `attributeCommand`. Выделение — тоже флаг, поэтому
любая операция может взять «текущее выделение» (`layer.flagged(EditFlags.SELECTED)`).

**На GPU.** Пока у облака есть правки (`layer.active`), `PointCloudRenderer` включает в шейдере точек
uniform `uUseEdits` (не `#define`: иначе первая правка компилировала бы новый вариант шейдера, ~2 с) и
вызывает `layer.attachNode` для каждого рисуемого узла: узел получает
`aEdit` (свои флаги или общий нулевой массив) и правки атрибутов. Скрытые точки уводятся за
пределы clip‑объёма (не рисуются и не попадают в picking), выделенные подкрашиваются
`layer.selectionColor`. Облака без правок не платят памятью (атрибута нет), флаг выключен. `aEdit` — нормализованный байт
(шейдер умножает на 255).

**Формат файла правок** (`toJSON`): `{type: "potree-edits", version: 1, nodes: {имя узла: {count,
flags: {значение флагов: [индексы]}, overrides: {атрибут: [[индекс, значение], ...]}}}}`.

## Проверка

`node tests/visual/operations.mjs` (lion, potree2, ept, copc): выборка в боксе совпадает с перебором
всех загруженных точек; выделение подсвечивается, скрытие убирает точки; две отмены возвращают
исходную картинку пиксель в пиксель, повтор — картинку со скрытием; классификация пишется и
откатывается; `toJSON`/`fromJSON`; правки переживают выгрузку и повторную загрузку узлов.

Тестовый сервер обязан поддерживать HTTP Range: Potree 2.0 и COPC читают узлы диапазонами байтов
одного файла (без Range каждый узел получает данные корня).

## Чего пока нет

- **Возможности шейдера** (план 6.2 п.1: свои раскраски/фильтры как подключаемые куски GLSL) —
  встроенные раскраски Potree пока не переведены в реестр.
- `compute`‑операции и воркеры для query.
- Интерфейс в сайдбаре — см. CHANGELOG, если добавлен.
