# Handoff — Pothree (Potree на актуальном three.js)

Выжимка контекста для продолжения работы в новой сессии. Актуально на 2026‑10‑13, коммит `f906ae96`.
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
node tests/visual/run.mjs --jobs 2            # визуальный регресс, эталон = исходный код; 41 пример + 5 пропусков
node tests/visual/run.mjs --only lion,potree2
node tests/visual/pick.mjs                     # picking, 5 примеров × 25 позиций
GL=nvidia BUDGET=10000000 node tests/perf/bench.mjs ca13 300   # отрисовка облаков (UNCAPPED, SCISSOR, LOAD_TIMEOUT)
GL=nvidia node tests/perf/frame.mjs ca13 20    # профиль кадра (FREEZE, ANNOTATIONS, UNCAPPED)
GL=nvidia node tests/perf/load.mjs ca13 8      # скорость загрузки
GL=nvidia node tests/perf/leak.mjs ca13 8      # утечки (минуты)
```

Ожидаемо не ноль: `elevation_profile` 0,3–0,4% (порядок порций профиля), `ept_zstandard` 0,57%
(другое октодерево в данных), анимированные/сетевые примеры с допусками в `tests/visual/config.json`.
Эталон picking переснят на r163 (24‑битная глубина точнее, доказано опытом с 16 битами).

## Грабли (наступал)

- **Нагрев ноутбука**: только один прогон тестов одновременно, `--jobs 2`. Тяжёлые — в фоне.
- `pkill -f <шаблон>` в той же команде убивает саму команду (шаблон совпадает с её текстом) — запускать отдельно или через TaskStop.
- `cd X && ( ... ) &` уводит `cd` в фон — второй прогон шёл не в той папке. Делать `cd X;` отдельной командой.
- Тестовые серверы обязаны отдавать `.css` как `text/css`, иначе раскладка ломается (область 20 px).
- COPC требует HTTP Range на сервере (есть в `run.mjs`).
- SwiftShader (по умолчанию в тестах) — не для замеров скорости: там исполнение шейдеров на CPU.
  Скорость мерить с `GL=nvidia`. `gl.finish()` в Chrome не ждёт GPU.
- В examples две копии three (страница + бандл) — поэтому `ColorManagement` выключается в обоих. Убирает 7а.
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

1. **7а** (начато сейчас): ES‑сборка `build/potree/potree.module.js` с `three` как `external`
   (единая копия three на странице), разделение `potree` (ядро) / `potree/viewer`, без побочных эффектов
   при импорте ядра (jQuery‑плагин `selectgroup`, патчи прототипов three — во вьюер), глобальное
   `Potree.*` в ядре → модуль состояния, минификация, ленивые `import()` тяжёлого, бюджет размера в CI.
   План — `MIGRATION_PLAN.md` разделы 6.5 и 7.
2. **8**: каркас операций (`PointQuery`, `EditLayer`, выделение, регистрация операций) — раздел 6.2 плана.
3. Этап 3 ТЗ (ручная проверка функций, Firefox/WebKit), Этап 5 (CI на GitHub Actions).

## Что ещё можно оптимизировать (не сделано)

- **Рендер по требованию**: Potree рисует 60 кадров/с даже когда ничего не меняется — лишний нагрев/батарея.
  Режим «рисовать только при изменении камеры/сцены/загрузке» (опция).
- Накладные расходы three на объект (~4 мкс/узел: `bindingStates.needsUpdate/setup`, VAO, матрицы) —
  заметны на 2 000+ узлах; путь — меньше узлов/объединение, либо WebGPU позже.
- Редкие фризы (1% low ~1,8 FPS на 35M) — у обеих версий, причина не исследована.
- Аннотации сотнями — CSS `transform` (конфликт с перетаскиванием jQuery UI).
- Асинхронный picking (решение M). Размер сборки (7а).
