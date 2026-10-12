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
| `src/Potree.js` | `build/potree/potree.js` (+ `.map`) | UMD, глобальный `Potree`; three.js **вшит** |
| `src/workers/BinaryDecoderWorker.js` | `build/potree/workers/BinaryDecoderWorker.js` | ES |
| `src/modules/loader/2.0/DecoderWorker*.js` | `build/potree/workers/2.0/` | ES |

three.js берётся из npm (`node_modules/three`, версия закреплена в `package.json`) через
`@rollup/plugin-node-resolve`. В исходниках импорт — `import * as THREE from "three"`, аддоны —
`"three/examples/jsm/..."`.

## three.js в примерах

Примеры (`examples/**/*.html`) импортируют three тем же голым именем `"three"`. Его разрешает
import map в `<head>` каждой страницы:

```html
<script type="importmap">
{"imports": {
	"three": "../node_modules/three/build/three.module.js",
	"three/examples/jsm/": "../node_modules/three/examples/jsm/"
}}
</script>
```

Поэтому примеры работают только из корня репозитория с установленными `node_modules`.

Известное ограничение (как и в оригинале): на странице две копии three — внутри `potree.js` и та,
что импортирует пример. Пока версии совпадают, это работает. Единая копия появится в шаге 7а
(ES-сборка Potree с `three` как `external`).
