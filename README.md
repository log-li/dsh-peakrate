# dsh-peakrate

在 DeepSeek Harness 的**模型选择器**里，按 **provider + 模型**分别判定峰谷时段，
显示当前倍率徽章、切换倒计时与 hover 详情。

## 为什么需要它

DSH 生态里的「峰谷/时段」类插件**几乎全部硬编码 DeepSeek 官方时段规则**，换 provider
就失去意义。但同一批模型常常经不同 provider 路由，而**各家时段与倍率规则并不相同**：

| provider | 时区 | 峰时窗口 | 倍率 |
|---|---|---|---|
| DeepSeek 官方 | UTC（= 北京时 09:00-12:00 / 14:00-18:00） | 周一–五 01:00-04:00、06:00-10:00 | 2× / 1× |
| Ollama Cloud | **UTC** | 周一–五 12:00-18:00 | 2× / 1× |
| Xiaomi MiMo Token Plan | Asia/Shanghai | 每天 08:00-00:00 | 1× / 0.8× credits |

**同一个 `deepseek-v4-flash`，经 DeepSeek 官方与经 Ollama 路由，此刻的峰谷状态可能完全相反。**
本插件按每个 profile 自带的时区独立计算，这正是它区别于 DeepSeek 专用插件的价值。

## 功能

| 位置 | 内容 |
|---|---|
| 每一行（仅匹配到的模型） | 倍率徽章，如 `⚡2×`（峰）/ `🌙1×`（谷），文案原样取自数据源 |
| 当前选中模型那一行 | 倍率徽章 **+ 距切换倒计时**，如 `⚡2× 2h 30m 后切换` |
| 任意匹配行 hover | 精简详情：当前时段名 + 倍率对照 + 倒计时 + 核验日期 |
| 未匹配的模型 | **什么都不显示**（无占位、无灰字） |

倒计时格式：`<1h` 用 `Xm`；`<24h` 用 `Xh Ym`；`≥24h` 用 `Xd Yh`。

## 安装

```bash
dsh plugin --profile web add dsh-peakrate
```

插件自带 `cordis.patch.yml`，安装即挂载（bundle 通道）。

> ⚠️ **不要**再往 profile 的 `cordis.patch.yml` 手动加 `- insert: [id: peakrate, ...]`：
> 一条插件只能有一条注册路径，双重注册会导致启动崩溃
> （`duplicate loader entry id: peakrate`）。

## 配置

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
    modelMappings:                # 覆盖/补充模型归属（优先于内置规则）
      - provider: ollama
        match: "^deepseek-v4"     # 前缀（默认）或正则（matchIsRegex: true）
        profile: ollama-deepseek-v4
    customProfiles: []            # 自定义 profile（新增，或按 id 覆盖内置快照条目）
```

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关；`false` 时不注册任何内容 |
| `refreshIntervalHours` | number | `24` | 后台刷新间隔（小时）；`0` = 不自动刷新 |
| `cachePath` | string | `$DSH_HOME/dsh-peakrate/pricing.json` | 本地缓存路径 |
| `catalogUrl` | string | `https://offpeakclock.com/pricing.json` | 数据源地址 |
| `providerAliases` | object | `{}` | DSH provider id → 数据源 provider 展示名 |
| `modelMappings` | array | `[]` | 模型归属覆盖，**优先于内置规则且不受 provider 名约束** |
| `customProfiles` | array | `[]` | 自定义 profile，按 `id` 覆盖内置条目或追加新条目 |

`customProfiles` 条目结构与数据源 profile 一致（至少需要 `id` / `provider` /
`schedule` / `periods`）。

## 匹配规则

**只有 provider 与模型同时匹配到同一 profile 才显示**；任一不符 → 不显示任何内容。

内置别名（可用 `providerAliases` 覆盖）：

| DSH provider id | 数据源 provider 名 | 命中 profile |
|---|---|---|
| `deepseek-official` | DeepSeek | `deepseek-v4` |
| `ollama` | Ollama | `ollama-deepseek-v4` |
| `xiaomi-token-plan-cn` | Xiaomi MiMo | `xiaomi-mimo-v2-5-token-plan` |
| `bai` / `zai` / `qoder` / `tencent-cloud` / `alibaba-cloud` / `swarms` | 同名 | 各自的 profile |

模型归一化：去掉 provider 侧 tag 后缀（`deepseek-v4-flash:0731` → `deepseek-v4-flash`）、
小写化。**V4 系为宽松归属**：`deepseek-v4*` 前缀全系（含 `deepseek-v4.1-flash`、
`deepseek-v4-flash-vision-exp`）以及历史别名 `deepseek-flash` 都归 V4 系。

数据源里没有对应 provider 的（如 `openrouter`、`ocg`、`opencode-go`、`ocg-1`），
其模型一律不显示。

## 数据源

唯一数据源：[offpeakclock.com/pricing.json](https://offpeakclock.com/pricing.json)
（schemaVersion 1）。每个 profile 携带 `schedule`（时区 / 峰时天 / 峰时窗口）、
`periods`（峰谷倍率文案）、`source`（官方定价页）与 `verifiedAt`（人工核验日期）。

获取策略：**内置快照 + 后台刷新 + 本地缓存**

1. 插件包内打包一份 `pricing.json` 快照 —— 安装即用、离线可用
2. 启动后后台拉取远端，成功后写入本地缓存
3. 读取优先级：**本地缓存 → 内置快照**
4. 远端失败 / `schemaVersion` 不支持 / `profiles` 为空 → 丢弃本次结果，
   沿用上一份可用数据，只记日志，**UI 不受影响**

## 开发

```bash
npm install
npm test          # 83 项单测（纯函数，不依赖 DSH 运行时）
npm run typecheck
```

架构：

```
src/
├── index.ts        # host：配置、拉取/缓存/校验/降级，注册 peakrate 服务
├── schedule.ts     # 纯函数：currentPeriod / formatCountdown
├── matching.ts     # 纯函数：provider 别名 + 模型归一化 → profile
├── catalog.ts      # 纯函数：数据源解析与校验
└── client/
    ├── index.tsx   # 替换模型选择器，渲染徽章 / 倒计时 / hover 详情
    └── style.css   # 仅用 --dsw-* 设计 token
```

**零 npm 运行时依赖**：时区与时段计算全部用原生 `Intl` + `Date` 实现。

设计文档见 [`.plans/spec/dsh-peakrate-spec.md`](.plans/spec/dsh-peakrate-spec.md)。

## 许可

MIT
