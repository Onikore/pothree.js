# Handoff — Pothree (Potree на актуальном three.js)

Выжимка контекста для продолжения работы в новой сессии. Актуально на 2026‑10‑13 (после шага 8, чистки мёртвого кода и ускорения тестов).
Подробности — в файлах, на которые ссылается этот документ; здесь только то, что нужно, чтобы
продолжить без потерь.

## Где что лежит

| Что | Где |
|---|---|
| Рабочий репозиторий | `/home/dmitry/portee-test/potree`, ветка `three-upgrade` |
| Удалённый репозиторий | `pothree` → https://github.com/Onikore/pothree.js.git (публичный), push: `git push pothree three-upgrade` |
| Автор коммитов | `Onikore <grishinda10@ya.ru>` — уже в локальном git config; в конце сообщения `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` |
| Исходный Potree для сравнения | worktree `/home/dmitry/portee-test/potree-orig` (detached `5636cd47`), собран (r124), в нём скопированы `tests/visual/*`, `tests/perf/*`, примеры `potree2*.html`, правки EPT‑примеров и `annotation_hierarchy` без Cesium |
| potree-core (референс) | `/home/dmitry/portee-test/potree-core` (TypeScript, tentone) |
| Скрэтчпад | `/tmp/claude-1000/-home-dmitry-portee-test/04702241-d859-456d-b1b0-e192f8cdbe27/scratchpad` |

Документы в репо: `MIGRATION_PLAN.md` (аудит, архитектура, шаги, решения A–M), `CHANGELOG.md`,
`PERFORMANCE.md`, `README.md` (раздел о форке сверху), `docs/` (architecture, modules, rendering,
build, testing).

## Состояние (сделано)

- three.js **r186** (`three@0.186.1`, последняя стабильная), `peerDependency ^0.186.0`; WebGL2;
  шейдеры GLSL ES 3.0; rollup 4; three из npm (UMD‑бандл `build/potree/potree.js` вшивает three).
- Облака рисует three.js: `src/rendering/PointCloudRenderer.js` (замена удалённого
  `src/PotreeRenderer.js`). Без приватного API three; единственная опора на недокументированное —
  пропуск uniform с `needsUpdate === false` (заливка uniforms облака раз на облако).
- Цвета как в r124: `src/threeSetup.js` (`ColorManagement.enabled = false`, импортируется первым),
  `outputColorSpace = LinearSRGB`; в каждом примере после импорта three — та же строка. Свет: × π,
  `decay = 0`.
- Picking через публичный API (scissor у render target, `readRenderTargetPixels`), исправлен у краёв.
- Удалено: VR, Arena4D, DeviceOrientationControls, GeoControls, Cesium, мёртвый код (решения J, K).
- Исправлены баги оригинала: двойная загрузка Potree 2.0, EPT binary/zstd, `.vpc` импорт (потом удалён),
  updateRange профиля, picking у краёв, **>2048 видимых узлов** (текстура видимости 2048 × N +
  `texelFetch`), `npm run build` не падал при ошибке rollup.
- Производительность (RTX 4050): отрисовка облаков −10% (10M точек), загрузка −33…−37%
  (`maxNodesLoading` 8), 1% low лучше, JS‑куча вдвое меньше, утечек нет; 50M точек работают
  (оригинал падает). Всё в `PERFORMANCE.md`.
- Библиотеки: jQuery 3.7.1, jQuery UI 1.14.2, jstree 3.3.17 (уязвимости).

## Тесты и замеры

```
npm run build
npm run test:quick                             # 17 с: 8 примеров на видеокарте (во время разработки)
npm run test:gpu                               # 90 с: весь визуальный набор на видеокарте
node tests/visual/run.mjs --jobs 2            # визуальный регресс на SwiftShader (эталонный, ~11 мин); 41 пример + 5 пропусков
node tests/visual/run.mjs --only lion,potree2
node tests/visual/pick.mjs                     # picking, 5 примеров × 25 позиций
node tests/visual/ondemand.mjs                 # рендер по требованию (viewer.renderOnDemand)
node tests/visual/operations.mjs               # операции: выборка, выделение, правки, отмена, JSON
GL=nvidia BUDGET=10000000 node tests/perf/bench.mjs ca13 300   # отрисовка облаков (UNCAPPED, SCISSOR, LOAD_TIMEOUT)
GL=nvidia node tests/perf/frame.mjs ca13 20    # профиль кадра (FREEZE, ANNOTATIONS, UNCAPPED)
GL=nvidia node tests/perf/load.mjs ca13 8      # скорость загрузки
GL=nvidia node tests/perf/leak.mjs ca13 8      # утечки (минуты)
```

Ожидаемо не ноль: `elevation_profile` 0,3–0,4% (порядок порций профиля), `ept_zstandard` 0,57%
(другое октодерево в данных), анимированные/сетевые примеры с допусками в `tests/visual/config.json`.
Эталон picking переснят на r163 (24‑битная глубина точнее, доказано опытом с 16 битами).

## Грабли (наступал)

- Тесты кэшируют данные с 5.9.65.151 в `tests/.cache/remote/` (`tests/remoteCache.mjs`, `NO_CACHE=1` — без кэша).
  Кэш записывает ответы браузера, а не `route.fetch()`: в окружении Claude Node не ходит в сеть (прокси).
- **Нагрев ноутбука**: только один прогон тестов одновременно, `--jobs 2`. Тяжёлые — в фоне.
- `pkill -f <шаблон>` в той же команде убивает саму команду (шаблон совпадает с её текстом) — запускать отдельно или через TaskStop.
- `cd X && ( ... ) &` уводит `cd` в фон — второй прогон шёл не в той папке. Делать `cd X;` отдельной командой.
- Тестовые серверы обязаны отдавать `.css` как `text/css`, иначе раскладка ломается (область 20 px).
- COPC и Potree 2.0 требуют HTTP Range на тестовом сервере (без него каждый узел получает данные корня).
- SwiftShader (по умолчанию в тестах) — не для замеров скорости: там исполнение шейдеров на CPU.
  Скорость мерить с `GL=nvidia`. `gl.finish()` в Chrome не ждёт GPU.
- Примеры — на ES‑сборке (`import * as Potree from "potree"`), глобального `Potree` нет: состояние — `Potree.state.*`
  (`Potree.resourcePath` → `Potree.state.resourcePath`). Тесты берут его через `tests/potreeGlobal.mjs`.
- Не запускать регресс, пока правишь `examples/` или пересобираешь — тест читает файлы на лету.
- jQuery 3.5+: `<span ... />` в HTML‑строках не раскрывается — писать `<span></span>`.

## Решения пользователя

Принято всё A–H, J (VR удалён), K (удаления), C (rollup), D (цвет r124), F (WebGLRenderer, не WebGPU),
G (правки точек — отдельным файлом), H (JS + JSDoc). Мини‑карта — оставить. «Под вопросом» (не удалять
без решения): ориентированные снимки, 360°, GeoPackage/Shapefile, экспорт DXF/GeoJSON, HQ splats, i18n,
узлы LAS/LAZ Potree 1.x. Ожидают решения: I (laz‑perf wasm, компактный zstd), L (d3/OpenLayers/i18next/
tween), M (асинхронный picking).

Пользователь пишет по‑русски, просит работать без остановок, документировать всё (docs/, CHANGELOG,
README в каждом коммите), коммитить и пушить каждый законченный шаг.

## Следующее

Сделано после первой версии этого файла: 7а (ES‑сборка, `state`, ядро без jQuery/proj4, min‑сборка),
рендер по требованию, панель stats.js раз в секунду, данные узлов в текстуре (без поузловых uniform),
замер WebGPU (не даёт прироста — остаёмся на WebGL), шаг 8 (`src/operations/`, `docs/operations.md`),
вторая чистка мёртвого кода, кэш удалённых данных в тестах, `--gpu`/`--group quick`.

Работать из папки `/home/dmitry/portee-test/potree` (память Claude перенесена в
`~/.claude/projects/-home-dmitry-portee-test-potree/`). Соседние папки: `potree-orig` (оригинал для
эталонов), `potree-core` (референс) — не путать.

Предложено пользователю (2026‑10‑13), порядок по рекомендации:
1. CI на GitHub Actions (эталонный `npm test` при push, бюджет размера сборки) — этап 5.
2. `--gpu` для `pick.mjs`, `operations.mjs`, `ondemand.mjs`.
3. Короче ожидание «покоя» в `--gpu` (SETTLE_MS 2 с → 1 с), проверить стабильность.
4. Адаптивный бюджет точек (меньше точек при движении), асинхронный picking (решение M).
5. Ждут решения пользователя: L (ленивая загрузка OpenLayers/d3/…), I (laz‑perf WASM, компактный zstd).
6. Из 6.2 не сделано: «возможности шейдера», compute/воркеры, лассо в UI.
7. Этап 3 ТЗ (ручная проверка, Firefox/WebKit).

## Что ещё можно оптимизировать (не сделано)

- Поузловые uniform убраны (текстура узлов, −16 % CPU кадра). Остаток на узел — VAO/`drawArrays`/
  обход three; на 15M точек кадр всё равно держит GPU (вершины), шейдер близок к голому three.
  Дальше — меньше узлов (объединение мелких) или WebGPU.
- Замеры на ноутбуке шумят ±15 %: A/B делать в режиме, где кадр упирается в CPU (1 точка на узел),
  и без stats.js. Скрипт‑бисекция кадра — в скрэтчпаде `gpucost.mjs` (не в репо).
- Редкие фризы (1% low ~1,8 FPS на 35M) — у обеих версий, причина не исследована.
- Аннотации сотнями — CSS `transform` (конфликт с перетаскиванием jQuery UI).
- Асинхронный picking (решение M).

## Ускорения 2026‑10‑13 (список «по порядку по всем пунктам»)

1. CI на GitHub — `.github/workflows/test.yml` (сборка, бюджет размера `tests/size.mjs`, эталонный набор
   на SwiftShader, `--jobs 2`, шрифты MS core + Noto, кэш данных). Смотреть: `gh run list -R Onikore/pothree.js`.
2. `--gpu` у всех тестов (`tests/browser.mjs`), GPU‑эталон picking `baseline-gpu/pick.json`.
3. «Покой» на GPU 1 с; `operations.mjs` ждёт кадры, а не время. `npm run test:gpu` — 139 с.
4. OpenLayers/d3 по требованию (`src/lazyLibs.js`, решение L).
5. laz-perf WASM для LAZ 1.x, `fzstd` для EPT zstd (решение I).
6. HTTP/2 — замер: выигрыша нет, не делали.
7. `viewer.setAdaptivePointBudget(true)` — опция.
8. `pickAsync` + `Utils.dragPick` для перетаскивания инструментов (решение M).
9. Объединение узлов — замер: не окупится (GPU‑bound), не делали.
10. `queryPointsAsync`, типизированные команды, `uUseEdits`.

Открыто: пауза драйвера 1,3–2,3 с после выделения миллионов точек (PERFORMANCE.md, «Операции над 15M»);
`potree2` под сетевой задержкой грузится втрое дольше `lion` — похоже на последовательную иерархию.
