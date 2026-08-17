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
задеплоен, сервер опубликован в официальном MCP-реестре как
`io.github.1gr14/agents-party@0.7.2`. Проверено вживую:
`npx skills add 1gr14/agents-party --list` → «Found 1 skill: party»;
`/plugin marketplace add 1gr14/agents-party` +
`/plugin install agents-party@agents-party` ставится и показывает один скилл,
~130 токенов always-on; `bun run check:distribution` → строка `MCP registry`
зелёная.

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

## MCP-реестр: как перепубликовать (и грабли, на которые мы уже наступили)

Запись в реестре привязана к версии, поэтому **каждый релиз нужно
перепубликовать** — иначе агрегаторы будут показывать старую. Из корня репы
пакета, после того как версия уехала в npm:

```sh
mcp-publisher logout && mcp-publisher login github --token "$(gh auth token)" && mcp-publisher publish
```

**`mcp-publisher login github` (device flow) для org-неймспейса не работает** —
на этом мы потеряли полчаса. Реестр выдаёт права так: дёргает
`GET /user/memberships/orgs` твоим GitHub-токеном и ищет `role: admin` +
`state: active`. Но его `client_id` начинается на `Iv23`, то есть это GitHub
App, а user-to-server токен из device flow на этот эндпоинт получает 403 — и
реестр молча трактует это как «админских орг нет», выдавая только
`io.github.iserdmi/*`. Ответ 403 при публикации при этом советует «сделай
членство в орге публичным», что к делу не относится вовсе (у них на это открыт
PR #1483, а сам симптом — issues #1527 и #1537). Лечится токеном с `read:org`
через `--token`; `gh auth token` подходит, отдельный классический PAT с одной
галкой `read:org` — тоже. Репозиторных прав реестру не нужно, код он не читает.

Токен живёт 5 минут, поэтому `login` и `publish` — одной цепочкой.

Хочется вообще забыть — у реестра есть `mcp-publisher login github-oidc` для
GitHub Actions: шаг в `ci.yml` рядом с publish снял бы и ручную работу, и эти
грабли разом.

Отдельно можно завести и remote-сервер (`agents-party.com/api/mcp/<token>`), но
токен в URL в публичный реестр не кладём — если делать, то через отдельную схему
авторизации.

## Awesome-листы — подано 2026-08-17

Три PR открыты, висят на ревью мейнтейнеров:

| Лист                                                                                                     | PR     | Куда                                              |
| -------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------- |
| [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers/pull/12324)               | #12324 | Communication — подан MCP-сервер, не скилл        |
| [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills/pull/1659) (72k★) | #1659  | Collaboration & Project Management                |
| [heilcheng/awesome-agent-skills](https://github.com/heilcheng/awesome-agent-skills/pull/425) (6k★)       | #425   | Community Skills → Productivity and Collaboration |

У punkpeye в `CONTRIBUTING.md` прямо приглашают агентские PR — надо только
добавить `🤖🤖🤖` в конец заголовка, тогда мержат по быстрой дорожке. Сделано.

Статус смотреть так: `gh pr status --repo <owner>/<repo>` или зелёная строка в
`bun run check:distribution` (он грепает README листа, так что зеленеет ровно
после мержа).

## Осталось руками — только то, что агенту делать запрещено

Два листа отказывают не нам, а **автоматике**. Читать их правила буквально: там
за нарушение банят аккаунт на репе, и это твой аккаунт, не мой.

### 1. hesreallyhim/awesome-claude-code (52k★) — только веб-форма, только руками

Их `CONTRIBUTING.md`, дословно: «ALL RECOMMENDATIONS MUST BE MADE USING THE WEB
UI ISSUE FORM TEMPLATE, OR YOU RISK BEING RESTRICTED FROM INTERACTING WITH THIS
REPOSITORY», «It is **not** possible to submit a resource recommendation using
the `gh` CLI» и «resource recommendations must be created by human beings».
Поэтому ни PR, ни `gh issue create` — открываешь
[форму](https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml)
в браузере и заполняешь. Мы проходим по возрасту (репа старше 14 дней, коммиты
идут), так что порог не блокирует.

Поля, готовые к вставке:

- **Display Name** — `agents-party`
- **Category** — `Agent Orchestration` (альтернатива — `Skills`, но там нас
  утопит в потоке однофайловых скиллов)
- **Link** — `https://github.com/1gr14/agents-party`
- **Author Name** — `1gr14`
- **Author Link** — `https://github.com/1gr14`
- **Description** (описание, не продажа; одна строка, без эмодзи и без обращений
  к читателю):

```text
A skill and CLI that give several agent sessions one shared channel: Claude Code, Cursor, Codex or any other agent, on one machine or across machines. Messages are addressed to everyone or to a named participant, the human reads along in the same channel, and message bodies are end-to-end encrypted so a hosted party stores only ciphertext.
```

Одна честная загвоздка: в форме есть **обязательный** чекбокс «This resource is
specific to Claude Code». Мы в Claude Code родные — скилл, плагин-маркетплейс,
`/party` из коробки, — но не эксклюзивны. Ставить галку или нет, решай сам; я бы
поставил и в описании вёл с Claude Code, но врать за тебя не буду.

### 2. travisvn/awesome-claude-skills (14k★) — заблокировано дважды

Во-первых, минимум **10 звёзд**: «if your skill hasn't acquired a basic 10
stars, it will be closed automatically». У нас 8 — двух не хватает. Во-вторых, у
них прямой запрет на PR, сделанные с помощью ИИ: «PRs will be closed without
comment». То есть это тоже руками и только после 10 звёзд. Строка для вставки в
таблицу `### Individual Skills`:

```text
| **[agents-party](https://github.com/1gr14/agents-party)** | A shared channel where agent sessions talk to each other — Claude Code, Cursor, Codex or any other agent, on one machine or across machines |
```

Категории про multi-agent у них нет — в PR стоит предложить завести.

### 3. Пинг Agent Skills-комьюнити

Мы редкий случай: скилл, который одинаково живёт в Claude Code, Cursor и Codex,
и при этом связывает их между собой. Это интересный кейс для самого стандарта, а
не самореклама в вакууме — заходить через
[Discord](https://discord.gg/MKPE9g8aUy) и обсуждения
[agentskills/agentskills](https://github.com/agentskills/agentskills), не через
форму.

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
