# Анализатор данов 4K — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows-приложение (отдельное окно). Пока в osu!stable выбирают карту, оно показывает сводный дан, уверенность и паттерны 4K-рис карты.

**Architecture:**
- Ядро на JS (`src/core`) запускает калькуляторы LeoBlack (Sunny, Daniel, Azusa, Roxy, Companella, Mixed), MinaCalc и поиск паттернов. Сводная модель (ONNX), обученная офлайн на Python по бенчмарку LeoBlack, выдаёт один дан.
- Electron-оболочка (`app/`) скрыто запускает встроенный tosu, слушает его WebSocket v2, считает карту в фоновом процессе и рисует карточку B.

**Tech Stack:**
- Node 24 и ES modules; тесты через `node:test`.
- Electron + electron-builder (portable exe).
- Python 3.12: scikit-learn, skl2onnx, onnxruntime — для обучения.
- onnxruntime-web (вендорный, из LeoBlack) — для инференса.
- tosu v4.26.3.

**Spec:** `docs\2026-10-24-dan-analyzer-design.md`

## Global Constraints

- Только Windows, только osu!stable, только 4K рис: `keys === 4` и `lnRatio <= 0.15`.
- Интерфейс только на русском.
- Подписи данов:
  - ступени по порядку: `low`, `low/mid`, `mid`, `mid/high`, `high`;
  - уровни 1–10 пишутся числом («7 low/mid»), дальше Alpha, Beta, Gamma, Delta, Epsilon, Zeta, Eta, Theta, Iota, Kappa;
  - края шкалы: «ниже 1 дана», «выше Kappa».
- Числовая шкала:
  - 1–10 — даны, Alpha = 11 … Kappa = 20;
  - ступень по смещению `d = n − round(n)`: `d ≤ −0.3` → low, `−0.3 < d ≤ −0.1` → low/mid, `−0.1 < d ≤ 0.1` → mid, `0.1 < d ≤ 0.3` → mid/high, `d > 0.3` → high.
- tosu: скрытый процесс, без окна, без значка на панели задач, останавливается вместе с приложением. Конфиг:
  - `OPEN_DASHBOARD_ON_STARTUP=false`
  - `ENABLE_AUTOUPDATE=false`
  - `CALCULATE_PP=false`
  - `SERVER_IP=127.0.0.1`
  - `SERVER_PORT=24077`
  - `ENABLE_INGAME_OVERLAY=false`
- Приложение работает полностью офлайн: никаких сетевых запросов, кроме `127.0.0.1:24077`.
- Карты бенчмарка (`.osu`) не попадают ни в git, ни в сборку. В сборку идут только веса модели.
- Лицензии и благодарности не добавляются. Оригинальные `LICENSE` внутри `vendor/` не трогать.
- Код LeoBlack зафиксирован на коммите `b700ebc000d502a476ba3fc97d09cef32fa90eb7` и вендорится без изменений. Все адаптации делаются только в `src/`.
- От выбора карты до показа результата — меньше 2 секунд на обычной карте (≤ 3000 нот).
- Сообщение при поломке после обновления osu!: «osu! обновилась? Нужна новая версия приложения» — показывается, если osu! запущена, а карта не определяется дольше 10 секунд.

## Review Focus

1. **Очень короткие и пустые карты** (меньше 80 нот, одна строка). Roxy, Azusa и MinaCalc отказываются считать или падают. Ожидаем: карточка всё равно показывает дан по доступным калькуляторам с низкой уверенностью, или «слишком короткая карта», и не падает. Тест — в Task 3.
2. **Пользователь быстро листает карты.** Результат по старой карте не должен приходить после новой и перетирать её. Ожидаем: показывается только результат для последней выбранной карты. Тест — в Task 8 (`latest-wins`).
3. **Порт 24077 занят или tosu не запустился.** Ожидаем: окно пишет «Не удалось запустить tosu» с причиной, а не висит вечно на «Ждём osu!…». Тест — в Task 9.
4. **Пути с кириллицей и пробелами.** Профиль пользователя с кириллицей (например `C:\Users\Мира`), а у LeoBlack папка с пробелами в имени. Ожидаем: всё грузится. Тест — в Task 1 (фикстура во временной папке с кириллицей) и проверка в Task 11.
5. **DT/HT на карте, которая уже считалась на 1.0×.** Кеш не должен отдавать результат 1.0×. Ожидаем: ключ кеша включает рейт. Тест — в Task 8.

---

## Структура файлов

```
dan-analyzer/
  package.json                 type: module; scripts: test, extract, train, start, dist
  .gitignore                   data/, node_modules/, dist/, vendor/tosu/*.exe
  vendor/leoblack/js/          копия "ManiaMapAnalyser by Leo_Black/js" @ b700ebc (+ его LICENSE)
  vendor/leoblack/VERSION      хеш коммита
  vendor/tosu/                 tosu.exe v4.26.3 (не в git; скачивается скриптом)
  src/core/
    leoblack.js                тонкий адаптер импортов vendor (единственное место с путями)
    labels.js                  число → подпись
    rice.js                    проверка «4K рис»
    features.js                всё, что считается по карте → плоский вектор признаков
    patterns.js                главный паттерн, топ-3 долей, метка Tech
    model.js                   загрузка ONNX + мета, предсказание, разброс/уверенность
    analyze.js                 analyzeChart(): склейка, итоговый AnalysisResult
    cache.js                   LRU-кеш в памяти + на диске (JSON)
  tools/
    fetch-tosu.mjs             скачать и распаковать tosu (по sha256)
    bench-rows.mjs             чтение data.csv, поиск .osu, ключ группы
    extract-features.mjs       бенчмарк → data/features.jsonl
    clean-set.mjs              строки data.csv, добавленные после калибровки Azusa/Roxy
    train.py                   обучение A/B, GroupKFold, отчёт, экспорт ONNX + мета
  models/
    dan_model.onnx             выбранная модель
    dan_model.meta.json        порядок признаков, калибровка разброса, вариант A/B, метрики
  reports/benchmark.md         итоговая таблица для пользователя
  app/
    main.js                    Electron main: окно, трей, жизненный цикл tosu/воркера
    preload.cjs                мост IPC → renderer
    tosuManager.js             запись конфига, запуск скрытого tosu, остановка
    tosuClient.js              WebSocket v2 → события {state, checksum, rate, mods}
    analysisWorker.js          utilityProcess: analyzeChart по запросу
    selectionController.js     латест-винс очередь, кеш, таймер 10 с
    windowState.js             позиция/размер/поверх всех/компактный режим
    renderer/index.html, renderer.js, styles.css
  tests/
    fixtures/makeChart.js      генератор синтетических .osu (стрим, джек, JS, LN)
    *.test.js
```

---

### Task 1: Каркас проекта и вендор LeoBlack

**Files:**
- Create: `package.json`, `.gitignore`, `vendor/leoblack/` (копия), `vendor/leoblack/VERSION`, `src/core/leoblack.js`, `tests/fixtures/makeChart.js`, `tests/leoblack.test.js`

**Interfaces:**
- Produces:
  - `makeChart({ kind: 'stream'|'jack'|'jumpstream'|'ln', bpm: number, seconds: number, keys?: 4|7, lnShare?: number }) -> string` — текст `.osu` (mania, OD 8, версия 14).
  - `src/core/leoblack.js` реэкспортирует из vendor:
    - `runSunnyEstimatorFromText`, `runDanielEstimatorFromText`, `runAzusaEstimatorFromText`, `runRoxyEstimatorFromText`, `runMixedEstimatorFromText`;
    - `analyzeEtternaFromText`, `classifyCompanellaDifficulty`, `calculateInterludeStar`, `analyzePatternFromText`.

- [ ] **Step 1:** `git init` в `dan-analyzer`. Склонировать `https://github.com/LeoBlackMT/osumania_map_analyser` **полностью** (не shallow) во временную папку и сделать checkout `b700ebc000d502a476ba3fc97d09cef32fa90eb7`. Скопировать `ManiaMapAnalyser by Leo_Black/js` в `vendor/leoblack/js` и `LICENSE` в `vendor/leoblack/LICENSE`, записать хеш в `vendor/leoblack/VERSION`. Создать `package.json` (`"type": "module"`, `"test": "node --test tests/"`) и `.gitignore` по структуре выше.
- [ ] **Step 2: Тест** `tests/leoblack.test.js` → `test('all estimators run on synthetic 4K stream')`:
  - сгенерировать `makeChart({kind:'stream', bpm:180, seconds:90})`;
  - записать карту во временную папку `os.tmpdir()/дан тест/` (кириллица и пробел);
  - проверить, что:
    - `runSunnyEstimatorFromText(text,{speedRate:1}).star > 0`;
    - `runDanielEstimatorFromText(...).columnCount === 4`;
    - `(await analyzeEtternaFromText(text,{musicRate:1})).values` имеет числовые `overall` и `technical`;
    - `analyzePatternFromText(text).report.Clusters.length > 0`;
    - `classifyCompanellaDifficulty({msdValues, interludeStar, sunnyStar}).numericDifficulty` конечное.
- [ ] **Step 3:** `npm test`. Ожидаем, что тест падает: нет `src/core/leoblack.js`.
- [ ] **Step 4:** Написать `src/core/leoblack.js` (только реэкспорты, относительные пути на `../../vendor/leoblack/js/...`) и `makeChart`.
- [ ] **Step 5:** `npm test`. Ожидаем PASS. Если какой-то модуль vendor не грузится в Node, исправление делается в адаптере, а не в vendor.
- [ ] **Step 6:** `git add -A && git commit -m "chore: scaffold project, vendor LeoBlack analyser @ b700ebc"`

### Task 2: Подписи данов

**Files:**
- Create: `src/core/labels.js`, `tests/labels.test.js`

**Interfaces:**
- Produces: `numericToLabel(n: number) -> { text: string, level: number|null, step: 'low'|'low/mid'|'mid'|'mid/high'|'high'|null }`

- [ ] **Step 1: Тест** `tests/labels.test.js` — ожидаемые `text`:

| Вход | `text` |
|---|---|
| 12.8 | `'Gamma low/mid'` |
| 13 | `'Gamma mid'` |
| 13.1 | `'Gamma mid'` |
| 13.2 | `'Gamma mid/high'` |
| 13.31 | `'Gamma high'` |
| 12.7 | `'Gamma low'` |
| 7.8 | `'8 low/mid'` |
| 10.4 | `'10 high'` |
| 10.6 | `'Alpha low'` |
| 20.2 | `'Kappa mid/high'` |
| 20.6 | `'выше Kappa'` |
| 0.4 | `'ниже 1 дана'` |
| 0.6 | `'1 low'` |

  `NaN` → `{ text: '—', level: null, step: null }`.
- [ ] **Step 2:** `node --test tests/labels.test.js`. Ожидаем FAIL.
- [ ] **Step 3:** Реализовать по правилу из Global Constraints. Границы: `n < 0.5` → «ниже 1 дана», `n ≥ 20.5` → «выше Kappa». Значения 13.3 и −0.3 относятся к той ступени, которая указана в правиле (`≤`).
- [ ] **Step 4:** Тест проходит.
- [ ] **Step 5:** `git commit -m "feat: dan label formatting"`

### Task 3: Признаки карты

**Files:**
- Create: `src/core/rice.js`, `src/core/features.js`, `tests/features.test.js`

**Interfaces:**
- Consumes: `leoblack.js` (Task 1).
- Produces:
  - `isRice({ keys, lnRatio }) -> boolean`: `keys === 4 && lnRatio <= 0.15`.
  - `async computeFeatures(osuText: string, rate: number) -> ChartFeatures`:
    ```
    ChartFeatures = {
      keys, lnRatio, rice: boolean, noteCount, durationSec, bpm,
      est: { sunny: number|null (star), daniel, azusa, roxy, companella, mixed: number|null },
      msd: { overall, stream, jumpstream, handstream, stamina, jackspeed, chordjack, technical } | null,
      interlude: number|null,
      patternReport: object|null,   // report из analyzePatternFromText
      vector: Record<string, number|null>   // плоский вектор для модели
    }
    ```
  - `FEATURE_NAMES: string[]` — фиксированный порядок ключей `vector`. Порядок должен совпадать с порядком в `train.py` и `meta.json`.

**Что считать и откуда:**
- Калькуляторы вызываются с `speedRate`/`musicRate = rate`.
  - `est.daniel`, `est.azusa`, `est.roxy`, `est.mixed` — это их `numericDifficulty`. Если калькулятор вернул null (например, Roxy вне диапазона 11–17), в поле пишется null.
  - Для Daniel null ставится и при `estDiff`, начинающемся с `<`.
  - `est.companella` = `classifyCompanellaDifficulty({msdValues: msd, interludeStar: interlude, sunnyStar: est.sunny}).numericDifficulty`.
  - MinaCalc считается с `scoreGoal` по умолчанию из vendor.
- `vector` состоит из:
  - всех `est.*` и `msd.*`, `interlude`, `noteCount`, `durationSec`, `bpm`, `lnRatio`;
  - флагов `has_<est>` (0/1);
  - статистик разброса по доступным `est.daniel/azusa/roxy/companella/mixed`: `est_min`, `est_max`, `est_mean`, `est_range`;
  - признаков паттернов: доли трёх главных кластеров по `AmountMs`, доля кластеров с `Mixed=true`, `top_cluster_mixed` (0/1 — главный по Importance кластер `Mixed`). Его использует Task 6 для подбора порога Tech.
- Каждый калькулятор обёрнут в try/catch: исключение превращается в null, анализ не падает.
- Если `!rice`, остальные калькуляторы не запускаются: возвращаются `rice: false` и `keys`/`lnRatio`.

- [ ] **Step 1: Тесты** `tests/features.test.js`:
  - `test('rice stream yields all estimators')`: stream 180 bpm 90 s → `rice === true`, `est.sunny > 0`, `msd.overall > 0`, `FEATURE_NAMES.every(k => k in f.vector)`.
  - `test('LN chart is not rice')`: `makeChart({kind:'ln', lnShare:0.6})` → `rice === false`.
  - `test('7K chart is not rice')`: `keys:7` → `rice === false`, `keys === 7`.
  - `test('DT raises sunny star')`: тот же stream, `rate 1.5` → `est.sunny` больше, чем при `1.0`.
  - `test('tiny chart does not throw')` (Review Focus 1): stream 2 секунды → резолвится без исключения, `vector` содержит null-ы, а не NaN.
- [ ] **Step 2:** Тесты падают.
- [ ] **Step 3:** Реализовать `rice.js` и `features.js`.
- [ ] **Step 4:** Тесты проходят.
- [ ] **Step 5:** `git commit -m "feat: per-chart feature extraction"`

### Task 4: Паттерны и метка Tech

**Files:**
- Create: `src/core/patterns.js`, `tests/patterns.test.js`

**Interfaces:**
- Consumes: `patternReport`, `msd` из `ChartFeatures`.
- Produces: `summarizePatterns(patternReport, msd, { techMsdRatio = 0.93 } = {}) -> { primary: string|null, top3: Array<{ name: string, share: number }>, tech: boolean }`

**Правила:**
- **Доля** = `cluster.AmountMs / Σ AmountMs`. Кластеры с одним именем суммируются.
- **Имя кластера** — то, которое выдаёт `categorise`/`summary` LeoBlack (`SpecificTypes[0][0]`, иначе `Pattern`).
- `top3` — первые три по доле, по убыванию; `primary = top3[0].name`.
- `tech = (главный по Importance кластер имеет Mixed === true) && msd && msd.technical >= techMsdRatio * max(stream, jumpstream, handstream, stamina, jackspeed, chordjack, technical)`.
- Порог 0.93 — начальный. Task 6 подбирает его по бенчмарку и записывает в `meta.json` (`techMsdRatio`), а `analyze.js` передаёт его сюда.

- [ ] **Step 1: Тесты** на синтетических `report`-объектах (без vendor):
  - доли `[600,300,100]` → `top3` с долями `0.6/0.3/0.1`;
  - `Mixed=true`, а Technical на 20% ниже лидера → `tech === false` (стрим с плавающим BPM не получает Tech);
  - `Mixed=true`, Technical = лидер → `tech === true`;
  - пустые кластеры → `{primary:null, top3:[], tech:false}`.
- [ ] **Step 2:** Тесты падают.
- [ ] **Step 3:** Реализовать.
- [ ] **Step 4:** Тесты проходят.
- [ ] **Step 5:** `git commit -m "feat: pattern summary with Tech rule"`

### Task 5: Извлечение признаков из бенчмарка

**Files:**
- Create: `tools/fetch-bench.md` (короткая инструкция), `tools/bench-rows.mjs`, `tools/extract-features.mjs`, `tools/clean-set.mjs`, `tests/bench-rows.test.js`

**Interfaces:**
- Consumes: `computeFeatures`, `FEATURE_NAMES`.
- Produces:
  - `readBenchRows(csvPath) -> Array<{ bid, name, pattern, subPattern, expected: number, group: string }>`;
  - `groupKey(row) -> string`: если `bid` есть — `'bid:'+bid`; иначе имя без хвоста рейта (regex `/\s*x\d+(\.\d+)?\s*$/i`) и без регистра;
  - `data/features.jsonl` — одна строка на карту: `{ name, pattern, expected, group, rice, vector }`, плюс исходный `est.mixed` для сравнения;
  - `data/clean-names.json` — имена строк, добавленных в `data.csv` после последнего изменения калибровочных таблиц Azusa (`AZUSA_ISOTONIC_POINTS`) и Roxy (`roxyMetaModel.generated.js`) в репо LeoBlack.

- [ ] **Step 1:** Склонировать `https://github.com/LeoBlackMT/VSRG-DanEstimation-Benchmark` полностью в `data/bench/` и распаковать `samples/samples.7z` туда же. Путь к `.osu`: `samples/{pattern}/{name}.osu`, сопоставление по `docs/runner_en.md` §6.2. `data/` в `.gitignore`.
- [ ] **Step 2: Тест** `tests/bench-rows.test.js`:
  - `groupKey({bid:'', name:'Grinding Of The Teeth x1.35'}) === groupKey({bid:'', name:'grinding of the teeth x1.2'})`;
  - `groupKey({bid:'123', ...}) === 'bid:123'`;
  - `readBenchRows` на маленьком CSV из 3 строк парсит `expected` как число.
- [ ] **Step 3:** Тест падает.
- [ ] **Step 4:** Реализовать:
  - `extract-features.mjs` пропускает `pattern === 'ln'` и строки с `rice === false`, вызывает `computeFeatures(text, 1.0)` (рейт уже вшит в `.osu`), пишет jsonl и печатает число строк и число ошибок;
  - `clean-set.mjs` находит дату последнего коммита, менявшего калибровки Azusa/Roxy (`git log -1 --format=%cI -- <file>` в клоне LeoBlack), и строки `data.csv`, впервые появившиеся позже (`git log --reverse -p` / `git blame --line-porcelain` по `samples/data.csv`).
- [ ] **Step 5:** Тест проходит. `npm run extract` → в `features.jsonl` ≥ 1100 строк. Вывести размер чистого набора; если он меньше 50 строк, записать это в отчёт Task 6.
- [ ] **Step 6:** `git commit -m "feat: benchmark feature extraction and clean-set detection"` (без `data/`).

### Task 6: Обучение и отчёт

**Files:**
- Create: `tools/train.py`, `tools/requirements.txt` (scikit-learn, skl2onnx, onnxruntime, numpy, pandas), `models/dan_model.onnx`, `models/dan_model.meta.json`, `reports/benchmark.md`

**Interfaces:**
- Consumes: `data/features.jsonl`, `data/clean-names.json`, `FEATURE_NAMES` (порядок берётся из ключей первой строки `vector`; проверка на совпадение во всех строках).
- Produces:
  - `models/dan_model.onnx` — вход `float32 [1, N]`, выход `[1,1]`, где null → NaN. Модель обязана принимать NaN: `HistGradientBoostingRegressor` умеет это сам, для ridge — `SimpleImputer` внутри пайплайна.
  - `models/dan_model.meta.json`:
    ```
    { featureNames: string[], variant: 'A'|'B', techMsdRatio: number,
      spread: { bins: number[], halfWidth: number[] },
      metrics: {...}, trainedAt: ISO, leoblackCommit: string }
    ```

**Что делает `train.py`:**
- **Варианты признаков:**
  - A — без `est.azusa`, `est.roxy`, `est.mixed` и их `has_`, а `est_*` пересчитаны без них;
  - B — все признаки. Mixed как признак в B разрешён.
- **Модели:** `RidgeCV` (с импутером и масштабированием) и `HistGradientBoostingRegressor` (`max_depth ≤ 4`, `learning_rate 0.05`, `max_iter` подбирается по CV). Выбирается лучшая по MAE для каждого варианта.
- **Проверка:**
  - `GroupKFold(5)` по `group`, по всем RC-строкам;
  - отдельно — обучение на всех строках, кроме `clean-names`, и проверка на `clean-names`.
- **Сравнение:** Mixed считается на **тех же** out-of-fold строках (его `got` = `est.mixed`).
- **Выбор для приложения:**
  - вариант с меньшей MAE на чистом наборе, если в нём ≥ 50 строк;
  - иначе — вариант A, если его OOF MAE ниже Mixed; иначе B, и в отчёте пометка, что цифра B может быть завышена;
  - финальная модель переобучается на всех строках.
- **Разброс:** OOF-ошибки выбранной модели бьются на 4 квантильных бина по `est_range`. `halfWidth` = 80-й перцентиль |ошибки| в бине.
- **techMsdRatio:** перебор 0.85…0.99 с шагом 0.01. Берётся порог, при котором метка Tech стоит на картах с `pattern == 'tech'` и реже всего на `speed`/`stamina`; максимизировать `F1(tech)`. `Mixed`-флаг и MSD Technical берутся из jsonl, поэтому в Task 5 нужно положить в `vector` `top_cluster_mixed` и `msd.*`.
- **`reports/benchmark.md`** (русский): таблица MAE / смещение / доля в пределах ±1 / MAE по `pattern` для A, B, Mixed, Roxy, Azusa, Daniel, Companella, Sunny на OOF и на чистом наборе. Какой вариант выбран и почему. Прямая фраза, если чистого набора нет. Цель spec: MAE ниже Mixed, |смещение| ≤ 0.1. Если цель не достигнута, отчёт так и пишет.

- [ ] **Step 1:** `py -3.12 -m venv .venv && .venv\Scripts\pip install -r tools/requirements.txt`
- [ ] **Step 2:** Реализовать `train.py` с `--check`: прогон на 50 строках, проверка, что ONNX-выход совпадает с `model.predict` до 1e-4, и выход с кодом 0.
- [ ] **Step 3:** `.venv\Scripts\python -I tools/train.py --check`. Ожидаем «parity ok».
- [ ] **Step 4:** `.venv\Scripts\python -I tools/train.py` — создаёт `models/*` и `reports/benchmark.md`. Ожидаем: в отчёте есть строки A, B, Mixed.
- [ ] **Step 5:** Показать пользователю таблицу из `reports/benchmark.md`, прежде чем идти дальше. Это контрольная точка «цифры честно».
- [ ] **Step 6:** `git commit -m "feat: train dan model, benchmark report"` (`.venv` в `.gitignore`).

### Task 7: Модель в JS

**Files:**
- Create: `src/core/model.js`, `tests/model.test.js`, `tests/fixtures/model-parity.json` (10 векторов и предсказаний Python, генерирует `train.py --dump-parity`)

**Interfaces:**
- Consumes: `models/dan_model.onnx`, `models/dan_model.meta.json`; onnxruntime-web из `vendor/leoblack/js/estimator/companella/ort/` так же, как это делает `companellaEstimator.js`.
- Produces:
  - `async loadModel(dir = 'models') -> Model`;
  - `async model.predict(vector: Record<string,number|null>) -> { numeric: number, halfWidth: number, confidence: 'высокая'|'средняя'|'низкая' }`;
  - `confidence` — по `halfWidth`: `≤ 0.35` высокая, `≤ 0.7` средняя, иначе низкая.

- [ ] **Step 1: Тест:** для каждого вектора из `model-parity.json` `|predict.numeric − python| < 1e-3`. Вектор из одних null → конечное число и `confidence === 'низкая'`.
- [ ] **Step 2:** Тест падает.
- [ ] **Step 3:** Реализовать. Признаки упорядочиваются строго по `meta.featureNames`, null → NaN.
- [ ] **Step 4:** Тест проходит.
- [ ] **Step 5:** `git commit -m "feat: JS model inference with parity test"`

### Task 8: analyzeChart и кеш

**Files:**
- Create: `src/core/analyze.js`, `src/core/cache.js`, `tests/analyze.test.js`, `tests/cache.test.js`

**Interfaces:**
- Consumes: `computeFeatures`, `summarizePatterns`, `loadModel`, `numericToLabel`, `meta.techMsdRatio`.
- Produces:
  ```
  async analyzeChart(osuText: string, rate: number) -> AnalysisResult
  AnalysisResult =
    | { kind: 'ok', label: string, numeric: number /*2 знака*/, halfWidth: number,
        confidence: 'высокая'|'средняя'|'низкая', primary: string|null,
        top3: Array<{name, share}>, tech: boolean, bpm: number, durationSec: number, rate: number }
    | { kind: 'not-rice', reason: 'keys'|'ln', keys: number }
    | { kind: 'too-short' }            // noteCount < 80
    | { kind: 'error', message: string }

  createCache({ dir: string, max: number = 500 }) -> {
    get(key) -> AnalysisResult|undefined, set(key, value) -> void }
  cacheKey(osuText: string, rate: number) -> string   // sha1(osuText) + '@' + rate.toFixed(3)
  ```
- В `AnalysisResult.ok`: `bpm` = доминирующий BPM карты × rate, `durationSec` = длительность от первой до последней ноты / rate.

- [ ] **Step 1: Тесты:**
  - stream 180 bpm 90 s → `kind === 'ok'`, `label` совпадает с `numericToLabel(numeric).text`, `top3.length ≥ 1`;
  - LN → `{kind:'not-rice', reason:'ln'}`, 7K → `reason:'keys'`;
  - 2-секундная карта → `too-short`;
  - `cacheKey(t,1) !== cacheKey(t,1.5)` (Review Focus 5);
  - кеш на диске переживает пересоздание `createCache` с тем же `dir`.
- [ ] **Step 2:** Тесты падают.
- [ ] **Step 3:** Реализовать. Модель загружается один раз; кеш на диске — один JSON-файл на ключ в `dir`.
- [ ] **Step 4:** Тесты проходят. Время `analyzeChart` на 3000-нотной синтетике меньше 2 с (печатать время в тесте, assert `< 2000`).
- [ ] **Step 5:** `git commit -m "feat: analyzeChart orchestration and cache"`

### Task 9: tosu — запуск и клиент

**Files:**
- Create: `tools/fetch-tosu.mjs`, `app/tosuManager.js`, `app/tosuClient.js`, `tests/tosuManager.test.js`, `tests/tosuClient.test.js`, `tests/fixtures/tosu-v2-frames.json`

**Interfaces:**
- Produces:
  - `fetch-tosu.mjs` — скачивает `https://github.com/tosuapp/tosu/releases/download/v4.26.3/tosu-windows-v4.26.3.zip`, сверяет sha256 `700063da6377c5f69985e09b0d30d575d27653519d7a3b1154bc11f1f9bd5752` и распаковывает в `vendor/tosu/`.
  - `writeTosuConfig(tosuDir: string) -> string` — пишет конфиг в то место, откуда tosu v4.26.3 его читает, и возвращает путь. Шаг 1 выясняет, где это: по исходникам `packages/common/utils/config.ts` (`getConfigPath()`; файл `tosu.env`, dotenv). Содержимое — ровно ключи из Global Constraints.
  - `startTosu({ tosuDir, onExit }) -> { stop(): Promise<void>, pid }` — `child_process.spawn` с `windowsHide: true`, `detached: false`, `stdio: 'ignore'`, `cwd: tosuDir`. `stop()` убивает дерево процессов (`taskkill /PID <pid> /T /F`).
  - `connectTosu({ port = 24077, onFrame, onStatus }) -> { close() }` — переподключение каждые 2 с. `onStatus('connecting'|'connected'|'down')`.
  - `parseFrame(json) -> { state: 'menu'|'songselect'|'playing'|'results'|'other', checksum: string|null, rate: number, mods: string[] }`:
    - `state` из `json.state.number`: `5` → songselect, `2` → playing, `7` → results, `0` → menu;
    - `mods` из `json.menu.mods` (в игре — `json.play.mods`), по коду LeoBlack `js/app/modData.js`;
    - `rate`: `mods.rate`, если это число > 0; иначе DT/NC → 1.5, HT/DC → 0.75, иначе 1. HR/EZ на дан не влияют (решение строителя).
  - Карта берётся `GET http://127.0.0.1:24077/files/beatmap/file`.

- [ ] **Step 1:** Запустить `node tools/fetch-tosu.mjs`. **Перед запуском спросить пользователя о скачивании** (файл ~49 МБ с GitHub). По исходникам tosu v4.26.3 (`config.ts`, `getConfigPath`) определить путь и имя конфига и зафиксировать в коде.
- [ ] **Step 2: Тесты:**
  - `writeTosuConfig` во временную папку → файл содержит `OPEN_DASHBOARD_ON_STARTUP=false` и `SERVER_PORT=24077`, нет `=true` для `ENABLE_AUTOUPDATE`;
  - `parseFrame` на кадрах из `tosu-v2-frames.json` (song select без модов, song select с DT, игра с HT) → `rate` 1, 1.5, 0.75 и правильный `state`;
  - `connectTosu` против локального тестового WS-сервера на свободном порту: сервер закрывается → `onStatus('down')`, поднимается снова → `'connected'`;
  - Review Focus 3: `startTosu` с несуществующим `tosuDir` → `onExit` вызывается с ошибкой, без unhandled rejection.
- [ ] **Step 3:** Тесты падают.
- [ ] **Step 4:** Реализовать. Кадры для фикстуры брать из реального tosu, если он доступен, иначе собрать по полям, которые читает `modData.js`/`socketHandlers.js` LeoBlack.
- [ ] **Step 5:** Тесты проходят.
- [ ] **Step 6:** `git commit -m "feat: hidden tosu manager and v2 client"`

### Task 10: Логика выбора карты

**Files:**
- Create: `app/selectionController.js`, `tests/selectionController.test.js`

**Interfaces:**
- Consumes: `parseFrame`, `analyzeChart` (через функцию-аргумент, чтобы тест мог подставить фейк), `createCache`, `cacheKey`.
- Produces:
  ```
  createSelectionController({ fetchOsu: () => Promise<string>, analyze: (text, rate) => Promise<AnalysisResult>,
    cache, now = Date.now, onView: (view: View) => void })
    -> { onFrame(frame), onTosuStatus(status), tick() }
  View =
    | { screen: 'waiting-osu' }                 // «Ждём osu!…»
    | { screen: 'tosu-failed', reason }         // «Не удалось запустить tosu: …»
    | { screen: 'osu-updated' }                 // «osu! обновилась? Нужна новая версия приложения»
    | { screen: 'loading' }
    | { screen: 'result', result: AnalysisResult }
  ```

**Правила:**
- Новый `checksum` или новый `rate` в любом состоянии, кроме `playing`, запускает анализ.
- **latest-wins:** у каждого запроса свой номер; результат с устаревшим номером выбрасывается.
- Во время `playing` последний результат остаётся на экране, новый анализ не запускается.
- Если tosu `connected`, но 10 с подряд `checksum === null` при `state !== 'menu'`, показывается `osu-updated`. `tick()` вызывается раз в секунду из main.

- [ ] **Step 1: Тесты с фейковыми `analyze`/`now`:**
  - быстрые кадры A → B: результат A приходит после B → итоговый View — результат B (Review Focus 2);
  - тот же checksum, rate 1 → 1.5 → два вызова `analyze`;
  - повторный выбор той же пары (checksum, rate) → берётся из `cache`, `analyze` не вызывается;
  - 10 с без checksum при `connected` → `osu-updated`; 9 с → нет;
  - `onTosuStatus('down')` до первого кадра → `waiting-osu`.
- [ ] **Step 2:** Тесты падают.
- [ ] **Step 3:** Реализовать.
- [ ] **Step 4:** Тесты проходят.
- [ ] **Step 5:** `git commit -m "feat: selection controller (latest-wins, cache, update hint)"`

### Task 11: Electron-окно (карточка B)

**Files:**
- Create: `app/main.js`, `app/preload.cjs`, `app/analysisWorker.js`, `app/windowState.js`, `app/renderer/index.html`, `app/renderer/renderer.js`, `app/renderer/styles.css`, `tests/windowState.test.js`
- Modify: `package.json` (`"main": "app/main.js"`, `"start": "electron ."`, devDependency `electron`)

**Interfaces:**
- Consumes: `startTosu`, `writeTosuConfig`, `connectTosu`, `createSelectionController`, `analyzeChart` (в `utilityProcess` `analysisWorker.js`, сообщения `{id, osuText, rate}` → `{id, result}`).
- Produces:
  - `loadWindowState(file) -> { x, y, width, height, alwaysOnTop: boolean, compact: boolean }`. Значения по умолчанию: 320×300, не поверх, не компактный. Если позиция вне всех мониторов (`screen.getAllDisplays()`), окно ставится в центр основного.
  - `saveWindowState(file, state)`.
  - IPC в renderer: `view` (объект `View` из Task 10) и `settings` (`{alwaysOnTop, compact}`). Из renderer: `toggle-always-on-top`, `toggle-compact`.

**Окно:**
- Без меню, с обычной рамкой. Заголовок «Анализатор данов» + версия из `package.json`.
- Трей: «Показать», «Поверх всех окон» (галочка), «Компактный режим» (галочка), «Выход».
- При выходе `stop()` tosu, сохранение состояния окна.

**Карточка B (русский текст, тёмная тема, по макету из spec):**
- Строка 1: `label` крупно + `numeric` мелко.
- Строка 2: `уверенность <confidence> · разброс ±<halfWidth с 1 знаком>`.
- Строка 3: `primary`.
- Три полосы `top3`: имя и процент целым.
- Чипы: `Tech` (только если `tech`), `<bpm округлённо> BPM`, длительность `m:ss`, и `×<rate>`, если rate ≠ 1.
- Компактный режим: только строки 1 и 3.
- Тексты состояний:

| Состояние | Текст |
|---|---|
| `waiting-osu` | «Ждём osu!…» |
| `loading` | «Считаем…» |
| `not-rice/keys` | «Не 4K (Nk)» |
| `not-rice/ln` | «LN-карта — не считаем» |
| `too-short` | «Слишком короткая карта» |
| `error` | «Ошибка: <message>» |
| `tosu-failed` | «Не удалось запустить tosu: <reason>» |
| `osu-updated` | «osu! обновилась? Нужна новая версия приложения» |

- [ ] **Step 1: Тест** `tests/windowState.test.js`: файла нет → значения по умолчанию; сохранили и загрузили → то же самое; `x: -5000` с одним дисплеем 1920×1080 → окно по центру. Список дисплеев передаётся параметром, чтобы не требовался Electron.
- [ ] **Step 2:** Тест падает.
- [ ] **Step 3:** Реализовать `windowState.js`, main, preload, worker, renderer.
- [ ] **Step 4:** Тест проходит. `npm start` при запущенном osu!stable. Ручная проверка:
  1. консольного окна нет, браузер не открылся;
  2. в song select карточка обновляется меньше чем за 2 с;
  3. DT меняет дан и показывает чип `×1.5`;
  4. на 7K-карте — «Не 4K (7k)»;
  5. после «Выход» в Диспетчере задач нет `tosu.exe`;
  6. то же самое, если папка проекта лежит в пути с кириллицей (Review Focus 4).
- [ ] **Step 5:** `git commit -m "feat: Electron window with card B"`

### Task 12: Сборка для друзей

**Files:**
- Modify: `package.json` (devDependency `electron-builder`; `build`: `win.target: portable`, `files`: `app/**`, `src/**`, `vendor/leoblack/**`, `models/**`, `package.json`; `extraResources`: `vendor/tosu/**` → `tosu/`; `asar: true` с `asarUnpack` для `vendor/leoblack/**/*.wasm` и `models/**`)
- Modify: `app/main.js` — `tosuDir = app.isPackaged ? path.join(process.resourcesPath, 'tosu') : 'vendor/tosu'`. Кеш и состояние окна хранятся в `app.getPath('userData')`.
- Create: `docs/для-друзей.md` — 5–6 строк по-русски: скачать, запустить, что делать, если SmartScreen спросит («Подробнее → Выполнить в любом случае»), где окно, как выйти.

- [ ] **Step 1:** `npm run dist` создаёт `dist/Анализатор данов <версия>.exe`. Ожидаем: файл есть, размер меньше 250 МБ.
- [ ] **Step 2:** Проверить, что в сборке нет карт бенчмарка: распаковать `app.asar` (`npx asar list`) и убедиться, что нет ни одного `.osu`.
- [ ] **Step 3:** Запустить `.exe` из папки, где нет проекта, при запущенном osu!stable. Повторить ручную проверку из Task 11, Step 4, пункты 1–5. Проверить, что состояние окна сохраняется между запусками.
- [ ] **Step 4:** Проверить, что приложение работает без интернета: отключить сеть и повторить пункт 2.
- [ ] **Step 5:** `git commit -m "build: portable exe for friends"`
