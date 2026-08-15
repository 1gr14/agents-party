# Дистрибуция скилла — карточка

Единственное место, где видно, куда `/party` уже попал и что осталось. Отмечаем
сделанное прямо здесь; статус живых каталогов не помним, а спрашиваем:

```sh
bun run check:distribution
```

**Главное про этот рынок.** Каталогов скиллов десятки, но заявки принимают
единицы: почти все крау́лят GitHub сами — по топикам репы, по layout скилла, по
телеметрии установок. Поэтому порядок обратный интуиции: сначала репа становится
машиночитаемой (это уже сделано), и только потом имеет смысл стучаться руками.

**Позиционирование, одно на все площадки.** Мы полноценный Claude-скилл — и
одновременно полноценный скилл Codex, Cursor и любого другого агента. Это не
«кросс-агентный вместо Claude»: разделять не надо, суть в том, что мы сводим
между собой сессии одного агента, сессии разных агентов и сессии на разных
машинах. В Claude-каталогах подаёмся как Claude-скилл (не извиняясь за
кросс-агентность), в общих — как Agent Skills-скилл (не пряча, что в Claude Code
он родной).

## Сделано

**2026-08-15, выкачено в 0.7.2.** Пакет на npm, теги `v0.7.1` и `v0.7.2`, сайт
задеплоен. Проверено вживую: `npx skills add 1gr14/agents-party --list` → «Found
1 skill: party»; `/plugin marketplace add 1gr14/agents-party` +
`/plugin install agents-party@agents-party` ставится и показывает один скилл,
~130 токенов always-on; `mcp-publisher validate` против живого реестра — valid.

Дальше по файлу — сама механика (что и зачем лежит в репе) и то, что осталось.

### Механика в репе

Всё это работает от пуша в `main` — каталоги читают GitHub, релиз в npm им не
нужен.

| Что                                               | Зачем                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `skills/party/SKILL.md` (был `skill/party.md`)    | Layout, который сканируют все инсталляторы: `npx skills add 1gr14/agents-party` теперь находит скилл |
| `.claude-plugin/marketplace.json` + `plugin.json` | Репа сама себе маркетплейс: `/plugin marketplace add 1gr14/agents-party`                             |
| `server.json` + `mcpName` в `package.json`        | Заготовка для официального MCP-реестра                                                               |
| Топики репы (16 штук)                             | По ним нас находят краулеры каталогов                                                                |
| README + лендинг                                  | Новые способы установки описаны там, где их ищут                                                     |
| `scripts/release.ts`                              | Версия плагина и `server.json` двигаются вместе с пакетом, руками не помним                          |
| `scripts/distribution-check.ts`                   | Мониторинг, см. конец файла                                                                          |

Версии в `plugin.json` и `server.json` **не правим руками** — их пишет
`bun run release`. Пин, который забыли обновить, значит, что плагин у людей
больше никогда не обновится. Обратная сторона: у кого скилл стоит плагином,
новый текст скилла приезжает только с релизом пакета, правка между релизами до
них не доедет (а пререлиз, наоборот, доедет — версия в манифесте меняется и на
`-next.N`).

Мелочь, о которой стоит знать: кто поставит и скилл обычным способом, и плагин,
получит два `party` — плагинный живёт в своём неймспейсе. README говорит «any
one of them is enough», этого достаточно.

**Описание — одно на все манифесты, и оно называет агентов поимённо.** «Claude
Code, Cursor, Codex or any other agent» живёт в четырёх местах: фронтматтер
`skills/party/SKILL.md` (его печатают каталоги и по нему агент решает,
включаться ли), `plugin.json`, запись в `marketplace.json` и `server.json` (там
лимит 100 символов, формулировка короче). Правишь одно — правь все четыре, иначе
каталоги начнут цитировать разное. Абстрактное «several AI agent sessions» не
годится: человек сканирует список глазами в поиске своего инструмента.

## Осталось руками

Пункт 1 — прямо сейчас, он занимает минуту. 2 — когда будет настроение, 3–4 —
после запуска.

### 1. Опубликовать сервер в официальном MCP-реестре

Единственное, что упирается в живой GitHub-логин (device flow в браузере) и
поэтому не сделано автоматом. `server.json` уже валиден против живого реестра, а
0.7.2 на npm уже несёт `mcpName`, так что это буквально две команды из корня
репы пакета:

```sh
mcp-publisher login github
mcp-publisher publish
```

`mcp-publisher` уже установлен (`brew install mcp-publisher`). Namespace
`io.github.1gr14/*` подтверждается самим GitHub-аккаунтом, заявок нет. Это самый
недооценённый канал: агрегаторы (PulseMCP, Smithery, Glama, mcp.so и прочие
marketplace-ы) — downstream-потребители реестра, они регулярно вычитывают
`GET /v0.1/servers` и наполняют себя сами. Одна публикация → десяток каталогов.
Проверка — `bun run check:distribution`, строка `MCP registry` станет зелёной.

Если надоест делать руками каждый релиз — у реестра есть
`mcp-publisher login github-oidc` для GitHub Actions, шаг в `ci.yml` рядом с
publish закрыл бы это навсегда.

Отдельно можно завести и remote-сервер (`agents-party.com/api/mcp/<token>`), но
токен в URL в публичный реестр не кладём — если делать, то через отдельную схему
авторизации.

### 2. Пинг Agent Skills-комьюнити

Мы редкий случай: скилл, который одинаково живёт в Claude Code, Cursor и Codex,
и при этом связывает их между собой. Это интересный кейс для самого стандарта, а
не самореклама в вакууме — заходить через
[Discord](https://discord.gg/MKPE9g8aUy) и обсуждения
[agentskills/agentskills](https://github.com/agentskills/agentskills), не через
форму.

### 3. Awesome-листы (после запуска, не раньше)

Заявка от репы с 8 звёздами и от репы с сотнями читается по-разному, поэтому
сюда идём после Show HN / Reddit / видео. Формат entry скопирован из этих же
списков — вставляется как есть.

**hesreallyhim/awesome-claude-code** (52k★). **PR запрещены**, только
issue-форма
[recommend-resource](https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml);
перед подачей прочитать `CONTRIBUTING.md` — там за игнор правил публично
отказывают.

**ComposioHQ/awesome-claude-skills** (72k★). Fork → PR в секцию
`### Collaboration & Project Management`:

```text
- [agents-party](https://github.com/1gr14/agents-party) - One channel where your agent sessions talk to each other: Claude Code, Cursor, Codex or any other agent, on one machine or across machines. End-to-end encrypted, local files or your own server. *By [@1gr14](https://github.com/1gr14)*
```

**travisvn/awesome-claude-skills** (14k★). Fork → PR в таблицу
`### Individual Skills`:

```text
| **[agents-party](https://github.com/1gr14/agents-party)** | A shared channel where agent sessions talk to each other — Claude Code, Cursor, Codex or any other agent, on one machine or across machines |
```

Там нет категории про multi-agent; в PR стоит предложить завести её — отдельная
секция заметнее строки в чужой.

**heilcheng/awesome-agent-skills** (6k★). Fork → PR в `## Community Skills`,
внутри `<details>` подходящей темы (или завести свою — «Multi-agent»):

```text
- [1gr14/agents-party](https://github.com/1gr14/agents-party) - Shared channel where Claude Code, Cursor, Codex and any other agent talk to each other, across machines
```

**punkpeye/awesome-mcp-servers** — только после пункта 1, подаём MCP-сервер, а
не скилл.

### 4. Соцканалы

Show HN, Reddit (r/ClaudeAI, r/cursor, r/LocalLLaMA), Хабр, X, видео на
@s\_1gr14 — это уже расписано в `PLAN.md` сайта, включая прогрев аккаунтов.
Здесь только напоминание, что каталоги без этого дают мало: demo GIF расшарят,
строчку в списке — нет.

## Чего сознательно не делаем

- **anthropics/skills** — первопартийная репа Anthropic, сторонние скиллы туда
  не берут.
- **Формы на skillsclaude.org / claudemarketplaces.com / agentskill.club** — они
  краулят GitHub и ранжируют по звёздам и установкам; топики и layout уже стоят,
  подаваться некуда.
- **Отдельный репозиторий только под скилл** — соблазн есть (в каталогах чище
  выглядит одиночная skill-репа), но тогда скилл разъезжается с CLI, который он
  запускает. Одна репа, один источник правды.

## Как следим

```sh
bun run check:distribution
```

Что печатает:

- **Signals** — загрузки npm за 30 дней и звёзды. Это фон: по ним видно,
  работает ли вообще верх воронки.
- **Directories** — проверки, которым можно верить: `skills.sh` отвечает 200/404
  на нашу страницу, MCP-реестр ищется по API. ❌ здесь значит «не нашли» — но
  читай note рядом: «not listed» это ответ каталога, а «unreachable»/`HTTP 5xx`
  — это мы не дозвонились. Если skills.sh когда-нибудь начнёт отдавать 200 на
  любой URL, строка станет врать зелёным; заметить это можно только глазами по
  ссылке.
- **Awesome lists** — грепаем сырой README каждого списка на `agents-party`.
  Зелёное = нас реально вмержили.
- **Check by hand** — каталоги, которые рисуют выдачу в браузере; фетч там не
  отличит «нет в списке» от «список не отдали», поэтому просто ссылки.

Гонять раз в пару недель и после каждого сабмита. Зелёная строка — вычёркиваем
пункт выше и не возвращаемся.
