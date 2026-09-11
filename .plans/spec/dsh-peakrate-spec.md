# dsh-peakrate — composer 工具行内的峰谷倍率指示插件

Status: implemented（已装机 web profile，实机验证通过 2026-09-12）
创建于: 2026-09-11
最近更新: 2026-09-12
包名: `dsh-peakrate`

> **本文档为活文档**：描述本插件**现在是什么样**，随设计迭代滚动更新。
> 文件名不带日期、不搬家；历史靠 `git log --follow` 回溯，决策留痕见 `.plans/implemented/`。
> 结构：前半为「当前设计」（背景 / 数据源 / 模型 / 匹配 / 显示 / 配置 / 架构 / 边界），
> 后半为「变更历史」（按日期倒序）。
>
> 来源：本文档由 plan `.plans/proposed/2026-09-11-dsh-peakrate.md` 的设计真相转正而来
> （2026-09-12）。plan 中的探索过程与备选方案留在 plan 里，此处只保留结论与理由。

## 1. 背景与目标

DSH 生态里的「峰谷/时段」类插件（`dsh-peak-indicator`、`dsh-peak-status`、
`deepseek-time`、`dsh-cost-meter` 等 30+ 个）**全部硬编码 DeepSeek 官方时段规则**，
只对 DeepSeek 模型生效，换 provider 就失去意义。而实际使用中同一批模型可能通过
不同 provider 路由（官方直连、Ollama Cloud、Z.ai、腾讯云…），**各家时段与倍率
规则并不相同**（例如 DeepSeek 官方是北京时周一–五 09:00-12:00 / 14:00-18:00，
而 Ollama Cloud 的 DeepSeek V4 是 UTC 周一–五 12:00-18:00）。

本插件把「时段倍率」做成**按 provider + 模型分别判定**的能力，数据来自一个
多 provider 的公开时段数据源，显示在模型选择器里。

**成功标准**（2026-09-12 按实际载体修订）：**不用打开任何菜单**，在 composer
工具行就能看到当前模型的峰谷状态、倍率与切换倒计时；未收录的 provider/模型
不显示任何多余信息，**且绝不遮蔽任何自带 UI**。

> 原成功标准为「打开模型选择器，一眼看出哪些模型处于峰时」——那需要替换自带
> 选择器，已被 §5.1 的事故否决。现标准以「不破坏自带交互」为前提。

## 2. 数据源

**唯一数据源**：`https://offpeakclock.com/pricing.json`（DeepSeek Peak-Hour Clock）

- 结构：`{ schemaVersion: 1, updatedAt, defaultProfile, profiles: [...] }`
- 实测（2026-09-11 版）：**14 个 profile**，覆盖 8 家 provider
  （DeepSeek / Ollama / B.AI / Z.ai / Alibaba Cloud / Xiaomi MiMo / Qoder / Tencent Cloud / Swarms）
  > 2026-09-06 版为 12 个 profile；数据源随供应商调价持续增删，**数量不是契约**，
  > 插件按 profile id 匹配，不依赖总数。
- 每个 profile 携带：`id`、`provider`、`model`、`product`、`schedule`
  （`timeZone` / `peakDays` / `peakWindows` / `offDayName`）、
  `periods`（`peak` / `offPeak`，各含 `badge` 倍率字符串与 `name`）、
  `source`（官方定价页链接）、`verifiedAt`（人工核验日期）
- 部分 profile 另有 `campaign` 活动窗口（见 §11 deferred）

**获取策略**：内置快照 + 后台刷新 + 本地缓存

1. 插件包内**打包一份 pricing.json 快照**（安装即用、离线可用）
2. Host 启动后按 `refreshIntervalHours` 后台拉取远端；成功后写入本地缓存
   （`$DSH_HOME/dsh-peakrate/pricing.json`），并记录 `fetchedAt`
3. 读取优先级：**本地缓存（未过期）→ 内置快照**；远端失败只记日志，不阻塞 UI
4. 校验：`schemaVersion` 必须为已支持版本，`profiles` 必须非空数组；
   校验失败则丢弃该次结果并沿用上一份可用数据
5. 手动刷新：选择器内的刷新入口触发一次强制拉取（§5）

## 3. 数据模型

插件内部把 profile 归一化为：

```ts
interface RateProfile {
  id: string                    // 如 ollama-deepseek-v4
  providerName: string          // profile 里的 provider 展示名，如 "Ollama"
  modelLabel: string            // profile 里的 model 描述，如 "DeepSeek V4 models"
  schedule: {
    timeZone: string            // IANA，如 "UTC" / "Asia/Shanghai"
    peakDays: number[]          // 0=周日 … 6=周六
    peakWindows: { start: string; end: string }[]   // "HH:mm" 本地于 timeZone
    offDayName?: string
  }
  peakBadge: string             // 如 "2×" / "0.5× credits"
  offPeakBadge: string          // 如 "1×"
  source?: string
  verifiedAt?: string
}
```

时段判定（纯函数，参考 `dsh-peak-indicator` 的 `currentPeriod` 泛化而来）：

```ts
function currentPeriod(profile: RateProfile, now: Date): {
  period: 'peak' | 'offPeak'
  minutesUntilSwitch: number
}
```

- 用 `Intl.DateTimeFormat(..., { timeZone })` 取该 profile 时区下的星期与 `HH:mm`，
  **不引入任何日期库**
- 当天在 `peakDays` 且当前 `HH:mm` 落在任一 `peakWindows`（start 含、end 不含）
  → `peak`；否则 `offPeak`
- `minutesUntilSwitch`：向后找到下一个状态翻转点（跨日、跨周末、跨 DST 都要正确），
  用于倒计时显示。实现要点（2026-09-12 修订）：
  1. **扫描上界 8 天**——已穷举 127 种非空 `peakDays` 子集验证其充分性（见 §13）；
  2. **按真实时间差计算，不按固定 1440 分钟/天**——夏令时切换当天只有 1380/1500
     分钟，按固定日长累加会差 1 小时（见 §13）。

## 4. 匹配规则（严格）

**只有 provider 与模型同时匹配到同一 profile 才显示**；任一不符 → 不显示任何内容。

### 4.1 provider 别名（内置默认，config 可覆盖）

DSH 的 provider id 与数据源里的 provider 展示名不同名，需要显式别名：

| DSH provider id | 数据源 provider 名 | 命中的 profile |
|---|---|---|
| `ollama` | Ollama | `ollama-deepseek-v4` |
| `deepseek-official` | DeepSeek | `deepseek-v4` |
| `xiaomi-token-plan-cn` | Xiaomi MiMo | `xiaomi-mimo-v2-5-token-plan` |

**OpenCode Go 系**（`ocg` / `ocg-1` / `opencode-go`）→ `deepseek-v4`。
依据其官方文档（<https://opencode.ai/docs/go/>）：

> DeepSeek V4.1 Flash / V4 Pro / V4 Flash / V4 Flash Vision Exp: **Peak hours are
> 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday**; all other hours,
> including weekends, are Off-Peak.

即**与 DeepSeek 官方窗口完全一致**（转售上游定价，峰值同为 2×）。

**有意不映射**（每条必写理由，见 `src/matching.ts` 的 `UNMATCHED_BY_DESIGN`）：

| provider | 理由 |
|---|---|
| `ocg-1-chat` | 仅提供 omen-alpha 等非峰谷计价模型 |
| `openrouter` | 聚合网关，同一 baseURL 服务数十家厂商，「provider 级」时段规则不成立 |

> **2026-09-12 教训（本条曾写错）**：原文把 `ocg` / `opencode-go` 也列入「数据源没有 → 不显示」。
> 错误在于把「**数据源覆盖率**」当成了「**上游是否有峰谷定价**」——后者是上游服务的性质，
> 与我的数据源是否收录无关。**转售方继承上游规则**，而数据源只收录直连厂商。
> 更糟的是这个错误结论被写进了 spec，看起来像「已验证的设计」。
> 防范机制见 §4.4。

### 4.2 模型归一化

1. 去掉 provider 侧 tag 后缀（如 ollama 的 `deepseek-v4-flash:0731` → `deepseek-v4-flash`）
2. 小写化、统一分隔符
3. 归属规则（**宽松 V4 系**，已确认）：
   - `deepseek-v4*` 前缀（含 `deepseek-v4.1-flash`）→ 归 `deepseek-v4` / `ollama-deepseek-v4`
   - `deepseek-flash`（其实现为 DeepSeek-V41-Flash）→ 同归 V4 系
   - `deepseek-v4-flash-vision-exp` → 同归 V4 系（profile 自述含 Vision）

### 4.3 当前配置下的实际命中（实现后的预期）

| provider | 模型 | profile | 时段规则 |
|---|---|---|---|
| `deepseek-official` | deepseek-flash、deepseek-v4-flash、deepseek-v4-pro、deepseek-v4-flash-vision-exp | `deepseek-v4` | Asia/Shanghai 周一–五 09:00-12:00、14:00-18:00 · 2× / 1× |
| `ollama` | deepseek-v4-flash:0731、deepseek-v4-pro:0813、deepseek-v4.1-flash | `ollama-deepseek-v4` | **UTC** 周一–五 12:00-18:00 · 2× / 1× |
| `xiaomi-token-plan-cn` | 该 provider 下的模型 | `xiaomi-mimo-v2-5-token-plan` | Asia/Shanghai 每天 08:00-00:00 · 1× / 0.8× credits |

**不显示**：`ollama` 下的 glm-5.3 / glm-5.3-flash / glm-5.2 / minimax-m3 / kimi-k3、
`ocg`·`opencode-go`·`ocg-1` 的 deepseek 系、`ocg-1-chat` 的 omen-alpha、
`openrouter` 的 stealth/ox-alpha。

### 4.4 防静默遗漏机制（2026-09-12 新增）

**根因**：漏掉 ocg 与之前的槽位遮蔽事故是**同一类 bug** —— 「缺少决策」被当成
「决策就是不做」：没注册 = 没 UI，不在数据源 = 不显示。两者都**静默退化**。

三层防护：

1. **代码清单 + 守卫测试**：`UNMATCHED_BY_DESIGN`（`src/matching.ts`）要求每个
   已知 provider **要么有映射、要么写明理由**；`test/matching.test.ts` 断言清单
   理由非空、不与别名表冲突、且清单内的 provider 确实匹配不到。
   另有一条具名回归测试禁止 ocg 系再次静默消失。
   **已反向验证**：移除 `ocg` 映射后测试失败并提示「曾漏配」。

2. **设置页实时覆盖表**：`settings.section` 的「模型峰谷倍率」页（§5.4）逐
   provider 列出模型与命中情况；**「整组零命中且无已知理由」的 provider 会被
   顶部告警高亮** —— 这正是 ocg 当初的形态。区分「整体零命中」（可疑）与
   「部分未命中」（正常，如同 provider 下混有非峰谷计价的模型），避免噪音。

3. **交付前穷举**（流程纪律，写入 AGENTS.md）：每次装机前打开设置页通读覆盖表，
   对每个「整体零命中」的 provider 逐一确认是「确实无峰谷定价」还是「漏配」。

> **为什么首选设置页而不是脚本**：它零依赖、读的是**运行时真实**的 provider×model
> （脚本只能读静态配置或依赖 Playwright 起浏览器），且用户自己也能随时查。

## 5. 显示规则

### 5.0 载体终案：**完整 fork 官方选择器 + 每行倍率徽章**（2026-09-12 二次修订）

**用户明确要求**在模型选择器**内部**看到各模型倍率。经技术核查：

- 官方 `@deepseek-ai/dsh-client-ui-model-selection`（**MIT**）注册
  `conversation.input.model` 时**不声明 `children`**，组件内 **0 处 `renderSlot`**
  → **内部没有任何扩展点**。
- 因此「在选择器里加一层」**只有一条路：完整重写该选择器**。

**决策**：采纳 fork 方案，但以**工程纪律**压制其风险：

| 风险 | 缓解 |
|---|---|
| 移植 402 行交互（键盘导航 / aria / portal 定位 / toast / effort / 加载与错误态）出错 → 又换不了模型 | **忠实移植**，不「简化」；逐项对照官方产物 |
| 依赖解析不出（图标 / react-dom） | 已核实官方 client 的 require 清单：`react` `react/jsx-runtime` `react-dom` `@deepseek-ai/dsh-client-ui-primitives` `@deepseek-ai/cordis` `@deepseek-ai/dsh-client-store` **均可解析**；图标名以官方实际使用为准 |
| 回归到「遮蔽自带 UI」 | 只替换**一个**槽位且**功能超集**；隔离实例逐条验证交互 |
| 官方后续更新不跟随 | 记录上游版本（`0.1.5-rc.1`）；升级时对照重移植 |

**保留** §5.1 的可加性徽章（`conversation.input.left`）：它是**免开菜单的随手可见**，
与本方案的「菜单内逐行对比」互补，不重复。

### 5.1 载体（历史）：**可加性槽位，不遮蔽自带 UI**（2026-09-12 首次修订）

**原方案「替换模型选择器」已被否决并废弃。** 理由（实机事故）：

- `conversation.input.model` 是 **single + `replaceRisk: shadows-shipped-ui`** 槽位，
  注册即**遮蔽自带选择器**；而本插件当时的替换实现是残缺的（只有简单菜单，
  没有 effort 选择、没有加载/错误态），**直接导致用户无法切换模型**。
- 教训：**「能替换」不等于「应该替换」**。用残缺实现接管核心交互入口，
  是把测试风险转嫁给用户的日常工具。

**现方案**：注册到 **`conversation.input.left`**——list 槽位、`replaceRisk: none`、
composer 工具行左侧（紧邻模型选择器），用**自己的 id** 做纯追加，不碰任何自带 UI。

| | 原（废弃） | 现 |
|---|---|---|
| 槽位 | `conversation.input.model` | `conversation.input.left` |
| 类型 | single · shadows-shipped-ui | **list · replaceRisk: none** |
| 注册键 | `name` | **`id: 'peakrate'`**（自有 id = 追加） |
| 数据来源 | 构建期注入快照 | **只读共享 `ctx.modelDirectories`**（官方服务，与自带选择器同一实例） |

### 5.2 显示内容

| 位置 | 内容 |
|---|---|
| composer 工具行左侧（当前模型已匹配） | 倍率徽章 **+ 倒计时**，如 `⚡2× · 2h30m 后切换` |
| hover | 精简详情：**当前时段名 + 倍率对照（峰 x× / 谷 y×）+ 核验日期** |
| 当前模型未匹配 | **什么都不显示**（渲染 null，无占位、无灰字） |

补充约定：

- 徽章文案与倍率**原样取自数据源**（`2×`、`0.5× credits`、`1× credits` 等），
  插件不自行换算或改写单位
- 倒计时格式：`<1h` 用 `Xm`；`<24h` 用 `Xh Ym`；`≥24h` 用 `Xd Yh`

**涨跌方向（2026-09-12 新增）**：倒计时后附 `↑`（之后**变贵**）/ `↓`（之后**变便宜**）。
动机：单看倒计时只知道**何时**变，不知道**变成什么** —— `2×→1×`（降价）与
`1×→2×`（涨价）的数字没区别。实现：从两侧徽章抽数字倍率比较
（`parseMultiplier`，支持 `2×` / `0.5×` / `1× credits`）。

**不猜**：任一侧徽章不含数字（如活动态的 `Campaign`）→ **不显示箭头**。
完整目标态（`Xh 后切换，转为 <时段名>（<徽章>）`）放在 tooltip 里。
- 每 30 秒重算一次，保证倒计时新鲜

### 5.4 设置页嵌入（`settings.models.footer`，追加式、可展开）

**2026-09-12 修订**：原先注册为独立的 `settings.section` 标签页；用户要求
**不要单独占一个标签页**，而是嵌进官方「设置 → 模型」页作为**可展开的一栏**。

现注册到 **`settings.models.footer`**（list · `replaceRisk: none` · 该槽位在无注册者时
不渲染任何内容），自有 `id: 'peakrate'` → **纯追加**。折叠态只显示一行标题
（含覆盖摘要），展开后显示完整内容：

1. **当前覆盖情况（实时）**：`useSessions` 取当前会话 → 读共享模型目录 →
   逐 provider 列出「模型 / 当前倍率 / 命中 profile」；未收录的标「未收录」。
   整组零命中且无已知理由者，顶部告警高亮。
2. **匹配规则**：内置别名表 + 有意不映射的 provider 及理由。
3. **如何自定义**：`providerAliases` / `modelMappings` 的 config 片段。

### 5.3 功能取舍（诚实记录）

**已恢复**（2026-09-12 二次修订）：模型选择器**每一行**的倍率徽章——通过
§5.0 的 fork 方案实现。曾因「替换选择器导致换不了模型」而放弃，现以
忠实移植 + 隔离验证的方式重新采纳。

**两级呈现**：
- **工具行徽章**（`conversation.input.left`，追加式）：免开菜单即见当前模型倍率与倒计时；
- **菜单内逐行徽章**（fork 的选择器）：展开菜单时对比各模型当前峰谷，选型时直接可比价。

## 6. 配置（完整）

```yaml
- id: peakrate
  name: dsh-peakrate
  config:
    enabled: true                 # 总开关
    refreshIntervalHours: 24      # 后台刷新间隔（0 = 不自动刷新）
    cachePath: ~/.dsh/dsh-peakrate/pricing.json
    catalogUrl: https://offpeakclock.com/pricing.json   # 可换镜像/自建
    providerAliases:              # 覆盖/补充 provider 别名
      ocg: Ollama                 # 例：把自建聚合路由指到某个 profile provider
    modelMappings:                # 覆盖/补充模型归属
      - provider: ollama
        match: "^deepseek-v4"     # 正则或前缀
        profile: ollama-deepseek-v4
    customProfiles: []            # 自定义 profile（新增或按 id 覆盖内置快照条目）
```

`customProfiles` 条目结构与 §3 的 `RateProfile` 一致（可只给 id + 需要覆盖的字段）。

## 7. 技术架构

**形态**：DSH bundle 插件（`package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`）
+ client 半边（`dsh.client.platform: web`），加入 profile 的 `dsh.profile.bundles` 即生效。

**零 npm 依赖**：时区与时段计算全部用原生 `Intl` + `Date` 实现（参考
`dsh-quota-panel` 的零依赖做法），不引入 luxon/date-fns 等。

模块划分（初步）：

```
dsh-peakrate/
├── package.json          # dsh.bundle.patch + dsh.client.platform
├── cordis.patch.yml      # 挂载自身
├── data/pricing.json     # 内置快照（构建期从数据源同步）
├── src/
│   ├── index.ts          # host：配置、拉取/缓存、对外提供 profile 数据
│   ├── schedule.ts       # 纯函数：currentPeriod / minutesUntilSwitch（可单测）
│   ├── matching.ts       # 纯函数：provider 别名 + 模型归一化 → profile（可单测）
│   └── client/
│       ├── index.tsx     # 替换模型选择器，渲染行内徽章 / 倒计时 / hover 详情
│       └── style.css     # 仅用 --dsw-* 设计 token
└── test/                 # 纯函数单测 + 匹配表快照测试
```

**关键 API**：模型目录走官方 `ctx.modelDirectories.directoryFor(sessionId)`
（与自带 `/model` 弹窗共享同一 `ModelDirectory`，参考 `dsh-model-picker`），
不自行枚举 provider 配置。

**host ↔ client 数据通路（2026-09-12 补记）**：DSH 的 host 树与 client 树是
**两套独立 cordis 实例**，client 侧**拿不到** host 的 `ctx.get('peakrate')`。
因此 profile 数据的供给方式是：

| 半边 | 职责 |
|---|---|
| host（`CatalogStore`） | 内置快照 / 本地缓存 / 远端刷新与降级；**权威数据源** |
| client | **自带一份构建期注入的快照**（`__PEAKRATE_PROFILES__`，由 `scripts/build-client.mjs` 烤进 bundle），保证 UI 立即可用 |

注册 slot 时必须传 `inject: () => ({ peakrate: DEFAULT_FACE })` 提供注入面，
否则组件读不到数据、**UI 一个徽章都不显示**（见 §13 的缺陷记录）。
若将来需要把 host 的刷新结果下发到 client，须另加 host↔client RPC 通道。

## 8. 边界与失败模式

| 场景 | 行为 |
|---|---|
| 首次安装、无网络 | 用内置快照，功能正常 |
| 远端拉取失败 / 超时 | 记日志，沿用缓存或快照；UI 不报错 |
| `schemaVersion` 不支持 / profiles 为空 | 丢弃本次结果，沿用上一份可用数据 |
| 模型匹配到多个 profile | 按 provider 别名精确命中；仍歧义时取 `defaultProfile` 之外**第一个匹配**并在日志告警（不猜） |
| 跨日 / 跨周末切换 | 由 `minutesUntilSwitch` 单测覆盖边界（周五末段、周日夜、窗口间隙） |
| 时区差异 | 一律按 profile 自带 `timeZone` 计算，与用户本地时区无关 |
| 子代理会话 | 与自带行为一致，不启用模型切换相关 UI |

## 9. 参考实现与许可

| 参考 | 借什么 | 许可 |
|---|---|---|
| `future007s/dsh-peak-indicator` | 峰谷判定 `currentPeriod`、倒计时格式化、徽标渲染思路 | MIT |
| `genius-alray/dsh-model-picker` | 模型选择器替换、`ctx.modelDirectories` 用法、行渲染结构 | MIT |
| `a1073097082/dsh-model-search` | 选择器增强的挂载方式（备选方案） | MIT |
| `wenzetan/dsh-quota-panel` | 零 npm 依赖 + provider 自动发现 + 双面插件结构 | MIT |
| `songoao25/dsh-bottom-info-bar` | provider/模型识别与三态展示思路 | MIT |

**不复制代码**：仅借鉴结构与算法思路；本项目自行实现，必要时在文件头注明灵感来源。

## 10. 测试与验收

**单测**（纯函数，不依赖 DSH 运行时）：

- `schedule.ts`：五类边界——两个峰时窗口内、窗口间隙、周末全天谷、
  周五末段跨周末、周日结束回峰时；以及 UTC 与 Asia/Shanghai 两种时区下的同一时刻判定
- `matching.ts`：provider 别名命中/未命中、`:` 后缀剥离、V4 系宽松归属、
  无匹配返回空、config 覆盖优先级

**验收**（装进 web profile 后开新会话）：

1. 打开模型选择器：`deepseek-official` 的 4 个模型与 `ollama` 的 3 个 DeepSeek 模型
   显示倍率徽章
2. 当前选中模型行显示倒计时；`ollama`（UTC）与 `deepseek-official`（北京时）
   的倒计时**各自正确**（这是本插件区别于现有 DeepSeek 专用插件的核心证据）
3. hover 匹配行显示「时段 + 倍率对照 + 倒计时」
4. 无匹配模型（ox-alpha、kimi-k3、hy3、omen-alpha 等）不显示任何内容
5. **E2E 审计**：通读模型选择器完整渲染输出（不只检查字段），确认无重复、
   无错位、无残留占位

## 11. 已实现/未决项

### 11.1 campaign 活动窗口（2026-09-12 **已实现**，原为 deferred）

**数据形态**（原 spec 漏看了）：活动窗口不在顶层 `campaign` 字段，而在
**`schedule.overrides`**：

```json
"schedule": {
  "timeZone": "Asia/Shanghai",
  "peakDays": [1,2,3,4,5],
  "peakWindows": [{ "start": "14:00", "end": "18:00" }],
  "overrides": [{
    "period": "campaign",
    "startDate": "2026-09-03",
    "endDate": "2026-09-20",
    "days": [0,1,2,3,4,5,6],
    "windows": [{ "start": "23:00", "end": "09:00" }]
  }]
}
```

对应 `periods.campaign`（第三种时段态）：`name` / `status` / `badge`（如 `"Campaign"`）/
`detail` / `tone: "special"`。

**判定规则**：**override 优先于常规峰谷** —— 当「当前日期落在 `[startDate, endDate]`
（按 profile 时区，闭区间）**且** 当天星期在 `days` 内**且** 当前时间落在任一
`windows`（start 含、end 不含）内」时，状态为 `campaign`；否则退回常规判定。

**为什么当初误判为「0 命中」**：只查了顶层 `campaign` 字段，没看 `schedule.overrides`。
又一次「**没找到 ≠ 不存在**」——与 §4.4 的 ocg 漏配是同一类错误。

### 11.2 明确不做

- **单价与花费计算**：本插件只显示倍率与倒计时，不显示金额。
- **非数据源覆盖的 provider**：不显示；若将来数据源扩充或用户用 `customProfiles`
  自建，可自然生效。

## 12. 实现阶段

1. **骨架**：包结构、`cordis.patch.yml`、内置快照同步脚本、纯函数模块 + 单测
2. **数据层**：拉取/缓存/校验/降级，`customProfiles` 与覆盖配置
3. **匹配层**：别名表 + 归一化 + 命中表单测
4. **UI 层**：替换选择器、行内徽章、当前行倒计时、hover 详情、手动刷新
5. **验证**：装进 web profile 实机验收（§10），并按项目规则做独立模型家族 review

## 13. 变更历史

> 按日期倒序。每条记「决策 + 理由 + 后续结果」，供复盘。

### 2026-09-12 — 选择器 fork：两个只有真实浏览器能暴露的缺陷

用户要求「在模型选择器里一览各模型倍率」。官方组件无扩展点（不声明 children、
0 处 renderSlot），故完整移植（MIT）。隔离实例验证过程中捕获两个缺陷：

1. **`single` 槽位遮蔽必须给 `priority`，且要低于官方**
   - 现象：注册直接抛 `single slot "conversation.input.model" already has a
     registration at priority 0 (registered by Z8) — register at a different
     priority to shadow it (lowest renders)`
   - 语义（读 `dsh-web-frontend` 的 slots 实现确认）：条目按 priority **升序**排列，
     `entriesOfSlot` 对 single **只取第一个** → **优先级最低者渲染**。故用 `priority: -1`。

2. **CSS 从未生效**（`--loader:.css=text` 只产出字符串，不会自动注入）
   - 现象：菜单 `position: static`、`maxHeight: none`、`width: 1280`（占满整行）
     → 菜单跑到视口外，只露出底部一行
   - 根因：构建配了 `--loader:.css=text`，但**没有任何代码把它插入 `document.head`**
   - 修复：与官方同构的注入函数（`style[data-plugin-css=…]` 去重）
   - **顺带发现**：官方 CSS 用的设计 token（`--dsw-alias-interactive-bg-hover` /
     `label-tertiary` / `border-l3` / `dsw-specific-menu` / `elevation-prominent` 等
     共 16 个）**比 Theme Inspect 列出的更多**。改为直接采用官方 CSS
     （类名前缀 `_7KE1Ra_` → `dsh-peakrate-ms-`），视觉与官方完全一致。

- **验证**（与官方逐项对照，两种配置行为一致）：根面板两项 · 19 行分组 ·
  9 行带倍率 · 未匹配无徽章 · 点当前模型关菜单 · 点其它模型发出
  `POST /api/session/selectModel` → 200 · Escape 逐级返回 · 页面错误 0。

### 2026-09-12 — 实机验证通过并装入 web profile

- **最终验证**（线上 3080 实例，Playwright 无头浏览器实测）：
  - 徽章渲染正常：`🌙1× · 2d 11h`，hover 详情完整；
  - **自带模型选择器完好**：菜单展开、按 provider 分组列出全部模型、当前项带 ✓；
  - **控制台错误：0**。
- **实际呈现位置**：composer 卡片的**工具行**（输入框下方那一行）靠左，
  形如 `+ @ 请求批准 ⌄  🌙1× · 2d 11h  ……  DeepSeek-V41-Flash High ↑`。
  **不在模型选择器下拉列表内**——那是刻意取舍（见 §5.3）。
- **状态**：`Status: implemented`。已装入 `~/.dsh/profiles/web`
  （dependencies + `dsh.profile.bundles` 各一条 + node_modules 软链），
  单注册路径，无 `duplicate loader entry id` 风险。
- **待办（可选增强）**：若希望「选模型时能看到各模型的倍率」，可加
  `conversation.input.overlay`（同为 `replaceRisk: none`）做一个可展开面板，
  列出全部匹配模型的倍率——**仍不替换选择器**。

### 2026-09-12 — 隔离实例实机验证：捕获 `remote.session` 运行时报错

- **方法（重要实践）**：不再拿用户正在用的实例试错，而是用
  `dsh --profile peakrate-test --from-default-profile web` 新建**独立 profile**，
  逐项软链复用原 profile 的包（**原 profile 零改动**），在 **3099** 端口独立启动，
  再用 Playwright 无头浏览器截图 + 交互验证。
- **捕获的缺陷（纯函数单测无法发现）**：
  1. 页面报 `cannot get property "remote.session" without inject`，堆栈直指
     `modelDirectories.directoryFor()`。
  2. **根因**：`modelDirectories.directoryFor()` 内部要解析会话的模型选择投影，
     依赖 `remote.session`。官方 `dsh-client-ui-model-selection` 的插件级
     `inject` 是 `["commandUi","locale","sessions","slots","remote","remote.session"]`
     —— 含 **`remote.session`**；本插件只声明了 `["slots","modelDirectories"]`。
  3. **附带发现**：取服务必须用**属性访问**（`scope.slots`）而非 `scope.get('slots')`
     —— cordis 服务代理只在属性访问时把 `this.ctx` 绑定到调用方上下文。
- **修复**：插件级 `inject` 补为
  `['slots','sessions','modelDirectories','remote','remote.session']`；
  服务一律属性访问。并新增静态契约断言（inject 必须含这 5 项）防回归。
- **验证结果**（3099 隔离实例，Playwright 实测）：
  - 徽章渲染：`🌙1× · 2d 11h`，hover 详情正确；
  - **自带模型选择器完全可用**：菜单展开、按 provider 分组列出全部模型
    （DeepSeek 4 / xiaomi 2 / Ollama 若干）、当前项带 ✓；
  - **页面错误：0**（修复前为 1）。
  - 数值正确性核对：Fri 13:44 UTC 对 `deepseek-v4`（UTC 01:00-04:00 & 06:00-10:00）
    → 确为 offPeak，下一翻转点周一 01:00 = 2d 11h ✅
- **教训**：
  - **必须用真实浏览器验证 client 插件**——服务端「产物存在」不等于「运行时无错」。
  - **注入依赖要对照官方同类插件的 `inject` 清单**，不要凭需要猜。
  - **隔离实例验证**应成为 client 插件发布前的标准动作：不拿用户的日常工具试错。

### 2026-09-12 — 实机事故：遮蔽自带模型选择器致用户无法切换模型（载体方案推翻重做）

- **事故**：插件注册到 `conversation.input.model`（single +
  `replaceRisk: shadows-shipped-ui`）**遮蔽了自带模型选择器**，而替换实现残缺
  （无 effort 选择、无加载/错误态）→ **用户无法切换模型**，只能回滚并重启。
- **根因（三层）**：
  1. **技术误判**：把「槽位允许替换」当成「应该替换」，未意识到该槽位是
     `shadows-shipped-ui` 语义——注册即**取代**官方实现。
  2. **测试盲区**：旧契约测试只验证「产物格式 + inject 注入面」，**从未验证
     注册到了哪个槽位**。因此「遮蔽官方 UI」这个致命行为**没有任何测试覆盖**。
  3. **流程错误**：让用户用**日常核心工具**（模型选择器）承担实机测试风险。
- **决策**：**废弃「替换选择器」方案**，改为注册到 `conversation.input.left`
  （list · `replaceRisk: none` · 当前无占用者），用**自有 id** 做纯追加。
  数据来源同时改为**只读共享的 `ctx.modelDirectories`**（官方 client 服务，
  与自带选择器同一实例），当前模型判定天然与选择器一致。
- **功能取舍**（诚实记录，见 §5.3）：**放弃**「选择器内每一行的倍率徽章」
  （该能力必须替换 UI 才能实现）；**保留**核心价值——当前模型的峰谷状态 +
  倍率 + 切换倒计时。
- **新增守卫测试**（`test/bundle-contract.test.ts`）：维护 `SHADOWING_SLOTS`
  清单（`conversation.input.model` / `conversation.composer.bar` / `sidebar` /
  `main` / `root` 等 `replaceRisk: shadows-shipped-ui` 槽位），断言
  **插件绝不注册到其中任何一个**，并断言注册到 `conversation.input.left`
  且用 `id`（而非 single 槽位的 `name`）。
  **已反向验证**：临时回退为旧写法后 4 项测试失败，报
  「禁止注册到遮蔽槽位：conversation.input.model」，证明守卫有效。
- **后续结果**：单测 111 项全绿。**不再自动装入用户 profile**——插件装机必须
  由用户明确同意，且装机前先确认核心交互入口未被接管。

### 2026-09-12 — 独立模型家族 review 的发现与处置

外部独立模型对源码做了对抗性审查。**逐条独立核验后**的处置：

| # | 报告等级 | 核验结果 | 处置 |
|---|---|---|---|
| 1 | 【严重】跨午夜漏候选 | **误报**——审的是改到一半的旧树，其 5 个案例在当前代码全部通过 | **拒绝**，未改动 |
| 2 | 【中等】`24:00` 被静默丢弃 | 属实：`isClock` 放行 `24:00` 而 `parseMinutes` 判 NaN，窗口被丢 → 永久谷时且无倒计时 | **已修**：`isClock` 与 `parseMinutes` 统一边界 |
| 3 | 【中等】缓存无过期检查 | 属实：`updatedAt: 2020` 的缓存压过 14-profile 新快照 | **已修**：加 `isCacheStale`（先比 updatedAt，回退比 mtime） |
| 4 | 【中等】client 忽略全部用户配置 | 属实：`DEFAULT_FACE.config` 恒为 `{}`，`providerAliases`/`modelMappings`/`customProfiles` 对 UI 无效 | **已修（文档化）**：README 增「已知限制」，spec §6 标注 host 侧生效 |
| 5 | 【轻微】`inPeakWindow` 死代码 | 属实，且语义与 `isPeakAt` 分叉（有重引入风险） | **已删** |
| 6 | 【轻微】校验漏洞 | 属实：`start===end` 变全天峰时、重复 id 静默遮蔽、非法 peakDays 静默丢弃 | **已修**：拒零长度窗口 + 按 id 去重 |
| 7 | 【轻微】别名门使映射静默失效 | 属实，原注释「可指向任意 profile」夸大 | **已修**：注释改为准确表述 |
| 8 | 【轻微】`<div>` 嵌在 `<button>` 内 | 属实（无效 HTML 嵌套）+ 注释写「每分钟」实为 30 秒 | **已修**（该 UI 随载体方案一并重写） |

- **同时确认无误的项**（review 用执行证据验证，本 spec 采纳其结论）：DST 各切换
  场景、相邻/重叠窗口、9 天扫描上界、边界含/不含语义、降级路径、纯洁性与零依赖。
- **教训**：review 报告的【严重】项**可能是误报**（本例因审查期间源码在变）。
  必须**逐条独立核验**再决定，不可照单全收——这与全局「Review 收到后必须理性
  独立判断」规则一致。

### 2026-09-12 — DST 切换日倒计时差 1 小时

- **缺陷**：`minutesUntilFlip` 用 `dayOffset * 1440` 累加天数，**把每天都当成
  1440 分钟**。夏令时切换当天实际只有 1380（春季前跳）或 1500（秋季回拨）分钟，
  导致切换日的 `minutesUntilSwitch` **整整差 60 分钟**。
- **影响面（实测数据源）**：14 个 profile 用到 3 个时区——`UTC`、`Asia/Shanghai`
  （两者均无 DST）与 `America/Los_Angeles`（**有 DST**，即 `swarms-swarm-completions`）。
  因此该缺陷只影响 1 个 profile，且仅在切换日附近显现——**但确属真错**。
- **决策**：不采用「按日累加」的近似，改为**墙上坐标 → 真实时间戳**两段式：
  1. 在墙上坐标系定位候选翻转点（第几天 + 当天第几分钟），跨午夜窗口的 `end`
     归属到次日；
  2. 用 `wallClockToTimestamp` 把墙上坐标解析成真实时间戳（含 DST 偏移修正，
     必要时二次迭代处理「猜测点恰好落在切换另一侧」）；
  3. 用真实毫秒差求分钟数。
  仍只用原生 `Intl` + `Date`，未引入任何日期库（守住 §7 的零依赖约束）。
- **验证**（对照「逐分钟扫描」的真值实现）：

  | 场景 | 修复前 | 修复后 |
  |---|---|---|
  | 春季前跳 2026-03-08 | 6/6 案例差 60min | 6/6 一致 |
  | 秋季回拨 2026-11-01 | 6/6 案例差 −60min | 6/6 一致 |
  | 真实 profile `swarms`（America/Los_Angeles） | 偏差 | 全部一致 |

- **顺带验证（原 spec 未论证的假设）**：§3 称「最多 8 天足以覆盖任意 peakDays
  组合」——本次以**穷举 127 种非空 `peakDays` 子集 × 8 天采样**证实该上界充分，
  无一例返回 `Infinity`，已固化为回归测试。
- **后续结果**：单测 94 项全绿（+5）。两处新增测试均**反向验证过**（临时回退修复
  后测试失败），确保不是空转。

### 2026-09-12 — 客户端数据供给修复（UI 本会一个徽章都不显示）

- **缺陷**：client 半边用 `(props as { peakrate?: PeakrateFace }).peakrate` 读
  profile 数据，但注册 slot 时**没有传 `inject` 注入面**，`props.peakrate` 恒为
  `undefined` → `profiles` 恒为 `[]` → `rateFor()` 全返回 undefined →
  **UI 一个徽章都不会显示**。插件加载成功、host 正常、单测全绿，但功能实际是死的。
- **根因**：DSH 的 **host 树与 client 树是两套独立 cordis 实例**，client 侧拿不到
  host 的 `ctx.get('peakrate')`。spec §7 只写了「host 对外提供 profile 数据」，
  未说明**这份数据如何跨树到达 client**——实现时想当然地以为 props 里会有。
- **决策**：client 半边**自带一份构建期注入的快照**。
  - `scripts/build-client.mjs` 用 esbuild `define` 把 `data/pricing.json` 经
    `parseCatalog` 校验后的 profiles 注入为 `__PEAKRATE_PROFILES__` 常量，
    直接烤进 client bundle（当前 14 个 profile）。
  - `apply()` 注册时传 `inject: () => ({ peakrate: DEFAULT_FACE })`，与官方
    `dsh-client-ui-model-selection` 的注册写法同构（已对照其产物确认）。
  - host 侧仍负责远端刷新与缓存（`CatalogStore`）；**将来若需把刷新结果下发到
    client，须另加 host↔client 的 RPC 通道**，本次不做（当前快照足够）。
- **测试盲区与补救**：原 83 项单测**全部通过**却没发现此缺陷——因为它们都直接给
  `rateFor()` 传 profiles，绕过了「数据如何到达组件」这一环。新增
  `test/bundle-contract.test.ts`（6 项）从**构建产物**出发验证契约：
  产物是 `__ModuleLoader__` 包裹的 CJS、可被 classic script 解析、`register` 必须带
  `inject` 且注入面能给出非空 profiles、端到端能算出正确判定。
  **已反向验证**：临时回退 inject 后该测试 3 项失败，证明测试不是空转。
- **后续结果**：修复后端到端验证通过——客户端拿到 14 个 profile，同一时刻
  `ollama` 判 peak 2×、`deepseek-official` 判 offPeak 1×（核心证据成立），
  未匹配模型返回 undefined。单测 89 项全绿。

### 2026-09-12 — 首次实机加载修复（两个致命坑）

首次装进 web profile 后启动失败，暴露两个 spec 未预见的宿主约束。两者均已修复并
验证，并写入项目 `AGENTS.md` 的「DSH 插件通用坑」。

1. **host 服务注册必须用 `ctx.provide`，不能用 `ctx.set`**
   - 现象：启动即崩 `cannot set property "peakrate" without provide`。
   - 根因：cordis 里 `ctx.set(name, …)` **只能覆写已注册**的服务；首次注册必须
     `ctx.provide(name, …)`。spec §7 只写了「注册为服务」，未指定 API，实现时想当然
     用了 `ctx.set`。
   - 验证：在真实 `Context` 下复现——`app.set('nonexistent-svc', …)` 抛
     `cannot set property "nonexistent-svc" without provide`；改用 `ctx.provide` 后
     `app.get('peakrate')` 正常返回、14 个 profile 可读。

2. **client 包必须是 `window.__ModuleLoader__.load({ id, factory })` 包裹的 CJS**
   - 现象：浏览器报 `Failed to load plugins`（`client-modules: bundle script … failed
     to load`），**整批插件脚本**一起挂掉。
   - 根因：服务端把各插件的 client bundle **原样拼接**成 classic `<script>` 批量
     bundle。原构建用 esbuild `--format=esm --external:react`，产出里留有裸
     `import * as React from "react"` → 拼进 classic script 后整批 SyntaxError。
   - 修复：`scripts/build-client.mjs` 改为 esbuild 打 **CJS**，再手工包一层
     `window.__ModuleLoader__.load({ id: "dsh-peakrate", factory: (require) => {…} })`，
     与官方/第三方插件 `lib/client.js` 格式完全一致（已逐字对照
     `dsh-client-ui-model-selection/lib/client.js` 确认）。

- **后续结果**：两个修复落地后，插件成功加载——证据是 host 侧写出了本地缓存
  `$DSH_HOME/dsh-peakrate/pricing.json`（14984 字节 / 14 profiles），说明 `apply()`
  完整跑通。**§10 的 UI 实机验收仍待人工确认。**
- **教训（已入 AGENTS.md）**：DSH 插件有两套独立的打包/注册契约，host 侧是 cordis
  服务生命周期、client 侧是 `__ModuleLoader__` 的 CJS 工厂协议；两者都不能凭对
  ESM/常规插件生态的直觉推断，必须对照官方插件产物核实。

### 2026-09-12 — 阶段 1–4 实现完成（代码落地）

- **决策**：按 §12 完成阶段 1–4——纯函数核心、host 数据层、client UI、构建与文档。
  共 83 项单测全绿，typecheck 干净，两半边可构建。
- **实现中偏离 spec 并已修正的项**：
  1. **§2 profile 数 12 → 14**：数据源 2026-09-11 版实为 14 个 profile（新增 Qoder
     系 4 个、Tencent Cloud 2 个、Swarms 1 个）。已在 §2 更正并注明「数量不是契约」。
  2. **config.modelMappings 的优先级语义**：原实现把用户映射与内置规则放在同一
     循环里，用户映射仍受 provider 展示名候选集约束，导致「把某 provider 指到
     官方 profile」这类覆盖静默失效。已改为**用户映射不受候选集限制**（可指向任意
     profile），内置规则才受约束以防跨 provider 误配。
  3. **CSS token 名**：初版凭印象写了 `--dsw-color-*` 系列，实际不存在。经 Theme
     Inspect 核实后改用真实 token（`--dsw-alias-label-primary` / `bg-overlay` /
     `border-l2` / `state-warn-primary` / `bg-layer-1|2`）。
- **新增实现细节（spec 未及写明、现补记）**：
  - 时段判定用 `Intl.DateTimeFormat.formatToParts` 取墙上时间，逐日向后扫描最多 8 天
    求下一个翻转点，从而天然覆盖跨日 / 跨周末 / 跨午夜窗口。
  - `parseCatalog` 对坏 profile **逐条丢弃**而非整体拒绝；仅当 schemaVersion 不支持、
    profiles 非数组/为空、或全部条目非法时才整体返回 undefined（触发沿用旧数据）。
  - 无峰时天或无峰时窗口的 profile 一律丢弃——它永远不会有峰时，对用户无意义。
  - 构建用 esbuild（types 用 tsc 单独产出）；**零运行时依赖**，`@types/node` 等
    全部为 devDependencies。
- **后续结果**：已 link 安装进 web profile（`dsh.profile.bundles` 加入
  `dsh-peakrate`，`node_modules/dsh-peakrate` 为符号链接指向项目目录），
  等待重启后按 §10 实机验收。**验收未完成前本 spec 的 Status 保持 proposed。**

### 2026-09-12 — 文档体系：plan / spec 分离，spec 转正为活文档

- **决策**：本文件从 `.plans/proposed/2026-09-11-dsh-peakrate.md` 转正为活文档
  `.plans/spec/dsh-peakrate-spec.md`，文件名去掉日期、不再随生命周期搬家；
  日期信息移入文件内（`创建于` / `最近更新`）。
- **理由**：全局规则里「Spec 先行规则」与「Plan 模式落盘规则」历史上都指向
  `.plans/`，导致「spec 是一份滚到底还是按日期分片」的语义矛盾。真根因是两种
  不同文档共用了目录：**plan** 是一次性快照（记录「当时为什么这么定」），
  **spec** 是当前真相（记录「现在是什么样」）。拆开后两条规则各自自洽。
- **后续结果**：全局规则已同步拆分（新增「Spec 落盘规则」章节 + 在「Spec 先行
  规则」下加 plan ≠ spec 澄清）。本插件后续所有设计迭代直接更新本文件。

### 2026-09-11 — 设计定稿（首版）

- **决策**：完成本插件全部设计——唯一数据源 `offpeakclock.com/pricing.json`、
  严格 provider+model 双匹配、替换模型选择器为载体、零 npm 依赖。
- **理由**：现有 30+ 个同类插件全部硬编码 DeepSeek 官方时段规则，换 provider 即失效；
  而同一模型经不同 provider 路由时时段规则并不相同（DeepSeek 官方北京时 vs
  Ollama Cloud 的 UTC），这构成本插件的核心价值。
- **后续结果**：spec 落盘，代码未开工。
