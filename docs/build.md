# Сборка

`npm run build` = `gulp build pack`.

| Задача | Что делает |
|---|---|
| `gulp build` | склеивает воркеры LAS/LAZ и EPT (`build/potree/workers/`), копирует ленивые библиотеки (`geopackage`, `sql.js`), вклеивает шейдеры в `build/shaders/shaders.js`, копирует CSS/HTML сайдбара и ресурсы, генерирует страницы примеров и иконок |
| `gulp pack` | `rollup -c` по `rollup.config.mjs`; ошибка rollup валит сборку |
| `npm start` (`gulp watch`) | сборка + dev-сервер на порту 1234 + пересборка при изменении `src/`, ресурсов |

## Rollup (`rollup.config.mjs`)

| Вход | Выход | Формат |
|---|---|---|
| `src/Potree.js` | `build/potree/potree.module.js` (+ `.map`) | **ES‑модуль**, `three` — `external` (одна копия three на странице, ~0,8 МБ) |
| `src/Potree.js` | `build/potree/potree.module.min.js` (+ `.map`) | то же, минифицировано terser (`keep_classnames`): ~0,5 МБ, gzip ~124 КБ |
| `src/umd.js` | `build/potree/potree.js` (+ `.map`) | UMD, глобальный `Potree`; three.js **вшит** (~3 МБ); для `<script src>` и старого кода |
| `src/workers/BinaryDecoderWorker.js` | `build/potree/workers/BinaryDecoderWorker.js` | ES |
| `src/modules/loader/2.0/DecoderWorker*.js` | `build/potree/workers/2.0/` | ES |

three.js берётся из npm (`node_modules/three`, версия закреплена в `package.json`) через
`@rollup/plugin-node-resolve`. В исходниках импорт — `import * as THREE from "three"`, аддоны —
`"three/examples/jsm/..."`.

## three.js и Potree в примерах

Примеры (`examples/*.html`) подключают ES‑сборку. Import map в `<head>` каждой страницы:

```html
<script type="importmap">
{"imports": {
	"three": "../node_modules/three/build/three.module.js",
	"three/examples/jsm/": "../node_modules/three/examples/jsm/",
	"potree": "../build/potree/potree.module.js"
}}
</script>
```

и в `<script type="module">`:

```js
import * as Potree from "potree";
import * as THREE from "three";
```

Three на странице один — тот, что из import map; его же использует Potree. Управление цветом
выключает `src/threeSetup.js` при импорте Potree, примерам ничего делать не нужно.
Примеры работают только из корня репозитория с установленными `node_modules`.

Глобального `window.Potree` у ES‑сборки нет. Изменяемое состояние — `Potree.state`
(`Potree.state.pointBudget`, `Potree.state.numNodesLoading`, …); пространство имён модуля только для
чтения, `Potree.pointBudget = …` в ES‑сборке не работает (в UMD работает). Тесты получают состояние
через `import("potree")` в странице (`tests/potreeGlobal.mjs`).

UMD‑сборка `potree.js` осталась для страниц с `<script src="potree.js">` и глобальным `Potree`: в ней
вшит свой three.js, и если страница импортирует ещё и свой three, их будет два (как в оригинале).

## Импорт без побочных эффектов

Импорт `potree.module.js` не требует глобальных библиотек вьюера: jQuery‑плагин `selectgroup`
(`src/viewer/selectgroup.js`) ставится, только если на странице есть jQuery, а именованные проекции
proj4 (`src/projections.js`) регистрируются при первом использовании (карта, азимут, EPT). Остались
безвредные побочные эффекты: `src/threeSetup.js` (выключает `ColorManagement` в общем three),
патчи прототипов three (`camera.zoomTo`, `ray.distanceToPlaneWithNegative`, `src/extensions/`) и
строка версии в консоли. Сам вьюер (`Potree.Viewer`, сайдбар, карта, профиль) по‑прежнему требует
jQuery, jQuery UI, proj4, OpenLayers, d3, i18next и т. д. из `libs/`.

Отдельный вход `potree/viewer` не делали: сборщик пользователя выкидывает неиспользуемое из
`potree.module.js` сам (tree‑shaking). Ленивые `import()` тоже не дали бы много — самый крупный
необязательный кусок, json5, ~5 КБ gzip.
