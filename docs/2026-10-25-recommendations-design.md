# Рекомендации карт — дизайн

Новая вкладка «Рекомендации»: выбираешь паттерн и цель, программа берёт твой скилл с mania-tracker (или дан, выбранный вручную) и советует 4K рис-карты, которые стоит сыграть.

## Данные (публичный API mania-tracker, без авторизации)

База: `https://api.mania-tracker.com`. Все запросы — GET из main-процесса (не из renderer).

| Что | Запрос | Что берём |
|---|---|---|
| Найти игрока | `/api/users/search?q=<ник>` | `users[0].{id, username, avatarUrl}` |
| Скилл | `/api/profiles/<id>/skills` | `status` ("ready"), `modes[keyCount=4]`: `ratings` (MSD по скиллсетам), `dan.rc.rawDan`, `dan.rc.skillsets.{speed,stamina,tech,jack}.rawDan` |
| Сыгранные карты | `/api/profiles/<id>/skill-plays?keys=4&axis=<A>&limit=200&offset=0&rejected=1` | `items[].{beatmapId, beatmapsetId, accuracy, rate}` + `rejected[]` того же вида. Отдаёт только топ‑200 по оси (offset дальше пуст), а слабая игра карты около твоего уровня может не попасть в топ своей оси, поэтому берём объединение по всем 8 осям (Stream, Jumpstream, Handstream, Stamina, JackSpeed, Chordjack, Technical, Overall) — раз на загрузку профиля |
| Поиск карт | `/api/snapshots/maps-search?...` (ниже) | `items[]` — по одному на сет, у каждого `diffs[]` (все сложности сета, прошедшие фильтр) |

Параметры поиска: `sort=playcount&dir=desc&page=<0..>&pageSize=48&keys=4k&patterns=<id>&vibro=hide&lnMax=15`, дан `danMin, danMinStep, danMax, danMaxStep`, длина `lenMin/lenMax` (секунды), `statuses=ranked,loved` по галочке. `patterns` = совпадение `primaryPattern`. `page` с нуля, больше 48 на страницу сервер не отдаёт. `lnMax=15` — как `RICE_MAX_LN_RATIO` нашего анализатора (выше он считает карту не рисом). `vibro=hide` пропускает многие вибро-паки (у них `vibro: false`), поэтому сложности с «vibro» в названии, версии или артисте отбрасываем сами. Ответ поиска помним 60 с (как `Cache-Control: max-age=60` у сервера). На 429 ждём `Retry-After` (до 10 с) и повторяем один раз, иначе — «mania-tracker просит подождать N с».

Шаги дана у трекера: дан D делится на 5 шагов по 0.2 — `--` (D−0.5, D−0.3], `-` (D−0.3, D−0.1], `` (D−0.1, D+0.1], `+` (D+0.1, D+0.3], `++` (D+0.3, D+0.5]: значение на границе относится к нижнему шагу (13.5 — gamma++, 13.7 — delta--, 13.9 — delta-). Шаг −2..2. Проверено: `danMin=13&danMinStep=1&danMax=14&danMaxStep=-1` → rawDan 13.13…13.89; шаг 14/−2 → 13.51…13.70.

Поля сложности (diff), которые используем: `beatmapId, beatmapsetId, title, artist, creator, version, status, stars, bpm, length, playCount, lnShare, primaryPattern, patterns{jack,stream,jumpstream,handstream,stamina,chordjack,tech,ln}` (0..1, у основного 1), `dan{label,rawDan}`, `msd{Stream,Jumpstream,Handstream,Stamina,JackSpeed,Chordjack,Technical,Overall}`, `covers.list` (только у верхнего элемента сета; у diffs `covers` = null).

## Паттерны и цели

| id | Название | Ось MSD | Плитка дана |
|---|---|---|---|
| stream | Стрим | Stream | speed |
| jumpstream | Джампстрим | Jumpstream | stamina |
| handstream | Хендстрим | Handstream | stamina |
| stamina | Стамина | Stamina | stamina |
| chordjack | Чордджек | Chordjack | jack |
| jack | Джек | JackSpeed | jack |
| tech | Тех | Technical | tech |

Плитки проверены на поиске: stream→speed, jumpstream/handstream/stamina→stamina, chordjack/jack→jack, tech→tech.

Твой дан для паттерна = дан плитки (`dan.rc.skillsets[tile].rawDan`), если его нет — общий `dan.rc.rawDan`. Вручную — уровень + шаг (как во вкладке «Создать карту», `targetNumeric`).

| Цель | Окно дана относительно твоего | MSD относительно рейтинга оси |
|---|---|---|
| Комфорт — «чуть ниже твоего уровня, набить точность» | [−0.6, −0.1] | −1.0 |
| Рост — «то, что стоит играть сейчас» (по умолчанию) | [0, +0.5] | +0.75 |
| Челлендж — «заметно выше, на пробу» | [+0.5, +1.2] | +2.0 |

## Ранжирование

Пул: до 4 страниц поиска (192 сета), на «Ещё» — следующие 20 из пула, кончился пул — ещё 4 страницы. В каждом сете берём лучшую сложность. Сложности вне окна дана [lo, hi] отбрасываем (сервер режет по шагам, мы — точно). Перезаливы одной карты в другие сеты (то же название без скобок, дан ±0.05, MSD оси ±0.3, длина ±2 с) показываем один раз — карточку с лучшим счётом. Если страница поиска не пришла, позиция в выдаче не сдвигается: следующее «Ещё» запросит те же страницы.

- `danFit = 1 − min(1, |dan − center| / (halfWidth + 0.15))`
- `msdFit = 1 − min(1, |msd[ось] − msdTarget| / 1.5)`, вручную (нет рейтинга) = danFit
- `purity = clamp((p[id] − mean(p[q] для q из stream, jumpstream, handstream, chordjack, jack, q≠id)) / 0.5, 0, 1)`; подпись: ≥0.7 «чистый», ≥0.4 «в основном», иначе «смешанный»
- `popularity = clamp(log10(playCount + 1) / 6, 0, 1)`
- `score = 0.45·danFit + 0.25·msdFit + 0.15·purity + 0.15·popularity`, −0.1 если сыграна другая сложность сета, −0.3 если сыграна эта (видна только при снятой галочке «не показывать сыгранные»)

## Наш анализ и рейт (по кнопке на карточке)

`.osu` с `https://osu.ppy.sh/osu/<beatmapId>` → наш анализатор (worker) на 1.0x: наш дан и паттерн. Плюс рейт, который ставит карту в центр цели: ищем r ∈ [0.75, 1.6] шагом 0.05 (двоичный поиск, дан растёт с рейтом), где `наш(r) − наш(1) ≈ center − danТрекера`. Если |center − danТрекера| < 0.1 — «уже в цель». Подпись рейта считаем от дана трекера: `danТрекера + наш(r) − наш(1)`.

## Модули

- `src/recommend/catalog.js` — `REC_PATTERNS`, `GOALS`, `LENGTHS` (any; short ≤150 с; medium 120–240; long ≥240), `TILE_NAMES`.
- `src/recommend/tracker.js` — `createTrackerApi({ fetchImpl, base, timeoutMs })` → `findUser(query)`, `skills(id)`, `playedMaps(id, axes)` (Map beatmapId → {beatmapsetId, accuracy, rate}), `searchMaps(params)`. Ошибки — по-русски.
- `src/recommend/skill.js` — `readSkill(json)`, `playerDanFor(skill, patternId)`, `targetFor({ skill, manualDan, patternId, goalId })`.
- `src/recommend/rank.js` — `danBound`, `searchParams`, `purity`, `scoreDiff`, `rankSets`.
- `src/recommend/recommend.js` — `createRecommender({ api })` → `loadPlayer(query, known)` (known — точный `{ id, name }` аккаунта из osu! через tosu, без поиска по нику; неудачная загрузка оставляет прежний профиль), `start(request)`, `more()`.
- `src/recommend/rateFit.js` — `suggestRate({ analyze, osuText, trackerDan, center })`.
- `src/recommend/format.js` — `mmss`, `signed`, `shortNumber`.
- `app/tosuClient.js` — `fetchProfile(port)` → `{ id, name }` или null.
- `app/main.js` — IPC `rec-player`, `rec-me`, `rec-start`, `rec-more`, `rec-ours`, `rec-open`; `shell.openExternal` только по URL, собранному в main.
- `app/preload.cjs` — `recPlayer, recMe, recStart, recMore, recOurs, recOpen`.
- `app/renderer/recommendTab.js` + раздел в `index.html` + стили; CSP: `img-src 'self' https://assets.ppy.sh data:`.

## Не входит

Скачивание .osz с зеркал (ненадёжны, часть отвечает 403) — вместо этого osu!direct (`osu://b/<id>`) и страница карты на сайте. LN-карты и не-4K.
