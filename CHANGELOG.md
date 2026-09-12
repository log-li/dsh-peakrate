# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-09-12

### Changed

- **The README now says up front that this plugin replaces the official model selector.** It always did take over the `conversation.input.model` slot — that is the point, and the replacement is a functional superset — but the fact was only stated deep inside *Architecture → Surfaces*. Someone installing this is replacing a piece of their harness's UI and should know it before, not after. The disclosure now sits directly under the install command, together with the consequence: because the slot is replaced rather than extended, an upstream DSH release that restructures the picker can require re-porting.
- **Added a tested-with table** so the support boundary is stated rather than implied: `0.1.5-rc.1` on macOS, installed from the **published npm package into a freshly created profile** (bundle registration, catalog route, all three surfaces, clean console). Other DSH versions, Linux and Windows, and profiles that already customise the selector are listed as **not yet verified**. The selector takeover is called out as the most likely thing to break.

## [0.2.1] - 2026-09-12

### Fixed

- **The install command in this file was wrong.** It read `dsh plugin add dsh-peakrate`; `--profile` is a required option (`dsh` declares it as one and forwards the rest to pnpm inside that profile's directory), so the command failed before doing anything: `error: required option '--profile <name>' not specified`. It is now `dsh plugin --profile web add dsh-peakrate`. Found by installing the published package into a freshly created profile rather than the development checkout — every earlier verification had used a `link:` install, which never exercises this path.
- **The install section did not mention pnpm**, without which `dsh plugin` stops with `pnpm not found on PATH — install pnpm to manage profile plugins`.
- **Installing printed a peer-dependency warning.** `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` are supplied by the host at runtime, not installed alongside the plugin, so pnpm reported them as missing peers — easy to misread as a failed install. Both are now declared `optional` in `peerDependenciesMeta`.
- `peerDependencies` tightened from `*` to explicit ranges (`cordis >=4 <5`, `schemastery >=3 <4`) so an incompatible host fails loudly instead of silently resolving.

## [0.2.0] - 2026-09-12

### Changed

- **The rate detail is now an in-page card, not an OS tooltip.** Hovering (or keyboard-focusing) the composer badge opens a card drawn by the plugin, so it follows the light/dark theme instead of the operating system's tooltip styling, appears without the native delay, and is reachable by keyboard. It is also part of the documentation now — an OS tooltip cannot be captured, an in-page card can.
- **The card leads with the model you hovered.** The first line is the current model's display name (`DeepSeek-V41-Flash`), matching the composer trigger. The matched profile's coverage — which can span several models that share one schedule, e.g. `V4.1 Flash + V4 Pro 0813` — is now a secondary line rather than the headline.
- **Documentation fix:** `customProfiles` was described as host-side only, "not affecting the badges". That stopped being true once the host began serving its merged catalog to the page — a custom profile now takes part in badge judgement exactly like a bundled one.

## [0.1.0] - 2026-09-12

First public release.

### Added

- **Live catalog with a fenced route.** The host refreshes the shared catalog at boot and every `refreshIntervalHours` (default 24h), validates it, caches it to disk, and serves it to the page over **`GET /peakrate/catalog`** (with **`POST`** to force a re-fetch — the *Refresh now* button). A data update therefore reaches the badges **without rebuilding or reinstalling the plugin**; the bundled snapshot remains as an offline fallback. The route applies the same browser-trust fence as the harness's own `/api` route (DNS-rebinding and cross-site defences).

- **Per-provider peak / off-peak rate badges.** Each provider is judged by its own IANA time zone and schedule — not by DeepSeek-only hours. A model shows the rate that actually applies to it right now.
- **Three rate states**, including a third `campaign` state for limited-time promotional windows (`schedule.overrides` with a date range and weekday filter), which takes precedence over the regular peak/off-peak cycle.
- **Switch countdown** next to every rate, so you can see when the current state ends.
- **Rate badges on every row of the model selector**, so providers can be compared before switching. The official selector is taken over as a deliberate, fully functional superset (upstream `@deepseek-ai/dsh-client-ui-model-selection`, MIT, `0.1.5-rc.1`).
- **Composer tool-row badge** showing the current model's rate at a glance.
- **Coverage panel** under *Settings → Plugins → Plugin configuration*, which lists every configured provider × model with what it matched, and raises a warning for any provider where **nothing at all** matched — the shape of a silent misconfiguration. `enabled` and `refreshIntervalHours` are editable there.
- **`npm run audit`** — an offline coverage sweep that enumerates the live provider × model set and flags providers that need a decision.
- Bundled catalog snapshot (`data/pricing.json`, schemaVersion 1) with a 24-hour background refresh and a disk cache.
- **A fenced route serving the live catalog to the page** (`GET`/`POST /peakrate/catalog`), so catalog updates reach the badges without a rebuild.

### Design notes

- **Zero runtime dependencies.** Time-zone and window arithmetic uses only the platform's `Intl.DateTimeFormat` and `Date`. No date library.
- Peak, off-peak and campaign windows are evaluated against real timestamps, so DST transitions and cross-midnight windows are correct rather than approximately correct.
- A cross-midnight window belongs to **the day it starts** — for overrides exactly as for regular peak windows.
- Campaign overrides reject zero-length windows and malformed dates at parse time, because the catalog is fetched at runtime.

[Unreleased]: https://github.com/log-li/dsh-peakrate/compare/v0.2.0...HEAD [0.2.0]: https://github.com/log-li/dsh-peakrate/compare/v0.1.0...v0.2.0 [0.1.0]: https://github.com/log-li/dsh-peakrate/releases/tag/v0.1.0

# 更新日志

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)， 版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.2] - 2026-09-12

### 变更

- **README 现在会在开头就说明：本插件会替换官方的模型选择器。** 它一直如此 —— 接管 `conversation.input.model` 槽位正是本插件的设计，且替换版是功能超集 —— 但这个事实原先只写在「架构 → 三处呈现」的深处。安装它的人是在替换自己 harness 的一块 UI，应当在**安装前**就知道，而不是之后。该声明现在紧跟在安装命令下方，并写明其后果：由于是**替换**而非扩展，上游 DSH 一旦重构该选择器，就可能需要重新移植。
- **新增「已实测范围」表**，把支持边界写出来而不是让人去猜：macOS 上的 `0.1.5-rc.1`，以**已发布的 npm 包**安装到**新建 profile**（bundle 注册、目录路由、三处呈现、控制台零错误）。其他 DSH 版本、Linux 与 Windows、以及已经自定义过选择器的 profile 均标注为**尚未验证**。并点名**选择器接管**是最可能出问题的地方。

## [0.2.1] - 2026-09-12

### 修复

- **本文件里的安装命令是错的。** 原文为 `dsh plugin add dsh-peakrate`，而 `--profile` 是**必填**选项（`dsh` 把它声明为 requiredOption，其余参数转发给该 profile 目录里的 pnpm），所以这条命令**什么都还没做就失败了**：`error: required option '--profile <name>' not specified`。现为 `dsh plugin --profile web add dsh-peakrate`。该问题由「把已发布的包装进一个**新建 profile**」发现 —— 此前所有验证用的都是 `link:` 开发副本，从未走过这条路径。
- **安装节没有提 pnpm**，缺少它时 `dsh plugin` 会停在 `pnpm not found on PATH — install pnpm to manage profile plugins`。
- **安装会打印 peer 依赖警告。** `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 由宿主在运行时提供、不随插件安装，pnpm 因此报「missing peer」—— 容易被误读为安装失败。现已在 `peerDependenciesMeta` 中声明为 `optional`。
- `peerDependencies` 由 `*` 收紧为显式区间（`cordis >=4 <5`、`schemastery >=3 <4`），使不兼容的宿主**大声失败**而不是静默解析。

## [0.2.0] - 2026-09-12

### 变更

- **倍率详情改为页面内浮层，不再用系统 tooltip**：悬停（或键盘聚焦）composer 徽章时， 浮层由插件自己绘制 —— 跟随明暗主题、无原生延迟、键盘可达；而且**能被截图**， 系统 tooltip 做不到。
- **浮层第一行改为「你悬停的那个模型」**（如 `DeepSeek-V41-Flash`，与触发器一致）； 命中的 profile 覆盖范围（同一个 profile 常覆盖多个共用时段规则的模型， 如 `V4.1 Flash + V4 Pro 0813`）降为次要行。
- **文档修正**：`customProfiles` 原写「仅 host 侧生效、不影响徽章」。自 host 开始把合并后的 目录下发给页面起，该说法已不成立 —— 自定义 profile 与内置条目一样参与徽章判定。

## [0.1.0] - 2026-09-12

首次公开发布。

### 新增

- **按 provider 区分的峰谷倍率徽章**：每个 provider 用**自己的时区与时段规则**判定， 而不是套用 DeepSeek 的时段。模型显示的倍率是它此刻**真实适用**的那个。
- **三种时段态**，含第三种 `campaign`（限时活动窗口，来自 `schedule.overrides`， 带日期区间与星期过滤），优先级高于常规峰谷。
- **切换倒计时**：显示当前时段还有多久结束。
- **模型选择器每一行**都显示倍率，选型前就能比价。官方选择器是**有意的功能超集接管** （上游 `@deepseek-ai/dsh-client-ui-model-selection`，MIT，`0.1.5-rc.1`）。
- **composer 工具行徽章**：不用打开菜单就能看到当前模型的倍率。
- **覆盖面板**（设置 → 插件 → 插件配置）：逐 provider 列出「命中 / 总数 / 未收录的模型」； 对**整组零命中**的 provider 给出告警 —— 那正是静默漏配的形态。 `enabled` 与 `refreshIntervalHours` 可直接在界面里编辑。
- **`npm run audit`** —— 离线覆盖穷举：枚举运行时的 provider × model 集合， 挑出需要人工决策的 provider。
- 内置目录快照（`data/pricing.json`，schemaVersion 1），24 小时后台刷新 + 磁盘缓存。
- **把实时目录下发给页面的带围栏路由**（`GET`/`POST /peakrate/catalog`）， 目录更新无需重新构建即可到达徽章。

### 设计取舍

- **零运行时依赖**：时区与窗口计算只用平台自带的 `Intl.DateTimeFormat` 与 `Date`， 不引入任何日期库。
- 峰 / 谷 / 活动窗口都按**真实时间戳**换算，因此 DST 切换与跨午夜窗口是**正确**而非近似正确。
- 跨午夜窗口归属**它开始的那一天** —— override 与常规峰时窗口语义一致。
- 活动 override 在**解析期**就拒绝零长度窗口与非法日期，因为目录是运行时拉取的。

[Unreleased]: https://github.com/log-li/dsh-peakrate/compare/v0.2.0...HEAD [0.2.0]: https://github.com/log-li/dsh-peakrate/compare/v0.1.0...v0.2.0 [0.1.0]: https://github.com/log-li/dsh-peakrate/releases/tag/v0.1.0
