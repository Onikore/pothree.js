# Документация форка Potree

| Файл | О чём |
|---|---|
| [architecture.md](architecture.md) | как устроен Potree: слои, путь точки от URL до экрана, LOD, рендер, picking, сборка, найденные проблемы |
| [modules.md](modules.md) | назначение каждого файла в `src/` |
| [rendering.md](rendering.md) | отрисовка облаков: что делает рендерер Potree и как это переносится на three.js |
| [build.md](build.md) | сборка: gulp, rollup, three.js из npm, import map в примерах |
| [testing.md](testing.md) | визуальный регресс примеров, smoke-тест форматов, тест picking |
| [../MIGRATION_PLAN.md](../MIGRATION_PLAN.md) | миграция на актуальный three.js: аудит, целевая архитектура, план шагов, решения |
| [../CHANGELOG.md](../CHANGELOG.md) | что изменилось для пользователей Potree |
| [RELEASE.MD](RELEASE.MD) | порядок выпуска (из оригинального репозитория) |

Правило: изменение кода и обновление документации, `CHANGELOG.md` и `README.md` — в одном коммите. Новая подсистема получает
свой файл здесь; новый или переписанный класс и публичная функция — JSDoc в коде.
