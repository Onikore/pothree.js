# Тесты

## Визуальный регресс и smoke-тест примеров

Скрипт `tests/visual/run.mjs` открывает каждую страницу из `examples/` в headless-браузере
(Playwright), дожидается загрузки облака, ставит камеру в позицию из эталона, делает скриншот и
сравнивает его с эталоном (pixelmatch). Попутно собирает ошибки и предупреждения консоли.

```
node tests/visual/run.mjs                      сравнить с эталоном (exit 1, если что-то упало)
node tests/visual/run.mjs --update             снять эталон заново
node tests/visual/run.mjs --only lion,copc     только указанные примеры
node tests/visual/run.mjs --group formats      smoke-тест форматов (группа из config.json)
node tests/visual/run.mjs --browser firefox    другой браузер (chromium | firefox | webkit)
node tests/visual/run.mjs --jobs 8             сколько примеров гонять параллельно (по умолчанию 4)
```

Перед запуском нужна сборка (`npm run build`) и браузер Playwright (`npx playwright install chromium`).

### Как определяется «облако загрузилось»

Каждые 250 мс скрипт читает `Potree.numNodesLoading` и число видимых точек. Состояние считается
стабильным, если узлы не грузятся и число точек не менялось 2 секунды подряд. Предел — 90 секунд
на пример. Вьюер ищется как `window.viewer` или `window.potreeViewer`, в том числе внутри iframe
(`embedded_iframe`).

### Камера

При `--update` скрипт записывает положение камеры (`position` и точку взгляда) в
`baseline.json`. При сравнении ставит камеру туда же и снова ждёт загрузки. Поэтому сравнение
не зависит от того, как пример сам выставляет камеру.

### Детерминизм

Chromium запускается с программным WebGL (SwiftShader: `--use-angle=swiftshader
--enable-unsafe-swiftshader`), окно 1280×800, `deviceScaleFactor` 1. Два прогона на одном коде
дают diff 0,00%. Эталон и проверка должны сниматься одной версией Playwright и браузера
(закреплены в `package.json`: `playwright` 1.64.0, chromium 156).

### Критерии провала

- доля отличающихся пикселей больше `maxDiff` (по умолчанию 0,5%; порог цвета pixelmatch 0,1);
- облако должно быть, а видимых точек 0;
- появились ошибки страницы (`pageerror`), которых не было в эталоне;
- пример не загрузился за 90 секунд.

Предупреждения консоли не валят тест, но сохраняются в `report.json` для сравнения с эталоном.

### Файлы

| Путь | Что |
|---|---|
| `tests/visual/run.mjs` | скрипт |
| `tests/visual/config.json` | допуски по примерам (`maxDiff`), `pointclouds: false` для страниц без облака, `skip`, группы |
| `tests/visual/baseline/<пример>.png` | эталонные скриншоты (сняты на исходном коде, three r124) |
| `tests/visual/baseline/baseline.json` | камера, число точек, консоль эталона |
| `tests/visual/output/` | результаты последнего прогона: скриншоты, `*.diff.png` (красное — отличия), `report.json`; не коммитится |

### Сетевые данные

Многие примеры берут облака с внешних серверов (`5.9.65.151`, `potree.org`, Arena4D, тайлы Cesium).
Если сервер недоступен, пример упадёт по таймауту. Это не регресс кода — смотрите `problems` в
`report.json`. Для примеров с тайлами карты Cesium и анимацией допуск увеличен до 5%.

## Smoke-тест форматов

Группа `formats` в `config.json`: примеры, каждый из которых грузит свой формат.

| Пример | Формат | Данные |
|---|---|---|
| `lion` | Potree 1.x, бинарные узлы | `pointclouds/lion_takanawa` |
| `lion_las` | Potree 1.x, узлы LAS | `pointclouds/lion_takanawa_las` |
| `lion_laz` | Potree 1.x, узлы LAZ | `pointclouds/lion_takanawa_laz` |
| `ept`, `ept_binary`, `ept_laz_14`, `ept_zstandard` | EPT: laszip, binary, LAZ 1.4, zstandard | `pointclouds/lion_takanawa_ept_*` |
| `copc` | COPC | `pointclouds/lion_takanawa.copc.laz` |
| `vr_lion` | Potree 2.0 | **удалённые** данные `potree.org/pointclouds/lion/metadata.json` |

Локальных данных Potree 2.0 в репозитории нет, поэтому этот формат проверяется по сети.
