# dsh-peakrate — 模型选择器内的峰谷倍率指示插件

Status: proposed
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

**成功标准**：打开模型选择器，能一眼看出哪些模型当前处于峰时、倍率多少、
当前使用的模型还有多久切换时段；未收录的 provider/模型不显示任何多余信息。

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
- `minutesUntilSwitch`：向后找到下一个状态翻转点（跨日、跨周末都要正确），
  用于倒计时显示

## 4. 匹配规则（严格）

**只有 provider 与模型同时匹配到同一 profile 才显示**；任一不符 → 不显示任何内容。

### 4.1 provider 别名（内置默认，config 可覆盖）

DSH 的 provider id 与数据源里的 provider 展示名不同名，需要显式别名：

| DSH provider id | 数据源 provider 名 | 命中的 profile |
|---|---|---|
| `ollama` | Ollama | `ollama-deepseek-v4` |
| `deepseek-official` | DeepSeek | `deepseek-v4` |
| `xiaomi-token-plan-cn` | Xiaomi MiMo | `xiaomi-mimo-v2-5-token-plan` |

其余已配置 provider（`openrouter`、`ocg`、`opencode-go`、`ocg-1`、`ocg-1-chat`）
在数据源中**没有对应 provider**，因此其模型一律不显示。

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

## 5. 显示规则

载体：**替换模型选择器**（而非 overlay 叠加），以获得行内自由布局能力。

| 位置 | 内容 |
|---|---|
| 每一行（仅匹配到的模型） | 倍率徽章，如 `⚡2×`（峰）/ `🌙1×`（谷），按 `periods.*.badge` 原样呈现 |
| 当前选中模型那一行 | 倍率徽章 **+ 距切换倒计时**，如 `⚡2× · 2h30m 后切换` |
| 任意匹配行 hover | 精简详情：**当前时段名 + 倍率对照（峰 x× / 谷 y×）+ 倒计时** |
| 未匹配的模型 | **什么都不显示**（无占位、无灰字） |

补充约定：

- 徽章文案与倍率**原样取自数据源**（`2×`、`0.5× credits`、`1× credits` 等），
  插件不自行换算或改写单位
- 倒计时格式：`<1h` 用 `Xm`；`<24h` 用 `Xh Ym`；`≥24h` 用 `Xd Yh`
- 选择器内的手动刷新入口（一个轻量图标按钮）触发强制拉取，并在刷新中给出状态

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

## 11. 未决项（deferred）

- **campaign 活动窗口**：数据源里有该概念（如 `zai-glm-5-3-flash` 带 `campaign`），
  但当前严格匹配下 **0 命中**（用户配置命中的 3 个 profile 均无 campaign）。
  本次实现**只预留字段**（解析但不渲染第三态），待将来命中时再开 UI 分支。
- **单价与花费计算**：明确不做（本插件只显示倍率与倒计时，不显示金额）。
- **非 offpeakclock 覆盖的 provider**：不显示；若将来数据源扩充或用户用
  `customProfiles` 自建，可自然生效。

## 12. 实现阶段

1. **骨架**：包结构、`cordis.patch.yml`、内置快照同步脚本、纯函数模块 + 单测
2. **数据层**：拉取/缓存/校验/降级，`customProfiles` 与覆盖配置
3. **匹配层**：别名表 + 归一化 + 命中表单测
4. **UI 层**：替换选择器、行内徽章、当前行倒计时、hover 详情、手动刷新
5. **验证**：装进 web profile 实机验收（§10），并按项目规则做独立模型家族 review

## 13. 变更历史

> 按日期倒序。每条记「决策 + 理由 + 后续结果」，供复盘。

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
