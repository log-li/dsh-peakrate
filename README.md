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

两处**互补**呈现：

| 位置 | 内容 |
|---|---|
| **composer 工具行**（免开菜单） | 当前模型的倍率 + 倒计时，如 `🌙1× · 2d 10h` |
| **模型选择器菜单内**（每行） | 各模型此刻的峰谷倍率，选型时可直接比价 |
| hover 任一徽章 | 详情：provider · 模型、当前时段名、峰谷倍率对照、核验日期 |
| **未匹配的模型** | **什么都不显示**（无占位、无灰字） |

效果（菜单内逐行倍率）：

```
DeepSeek                          ← 分组标题
  DeepSeek-V41-Flash    🌙1× · 2d 10h  ✓
  DeepSeek-V4-Flash     🌙1× · 2d 10h
  DeepSeek-V4-Pro       🌙1× · 2d 10h
xiaomi-token-plan-cn
  MiMo-V2.5             ⚡1× credits · 1h 39m
Ollama
  MiniMax M3                            ← 未收录 → 无徽章
```

倒计时格式：`<1h` 用 `Xm`；`<24h` 用 `Xh Ym`；`≥24h` 用 `Xd Yh`。

**三种时段态**：峰 `2×` / 谷 `1×` / **活动**（限时促销，如 Z.ai GLM-5.3-Flash 的
「ZCode 不计额度 · 其他 agent 半价」，带日期区间）。活动窗口优先于常规峰谷。

## 覆盖面板（设置 → 模型 页脚）

**设置 → 模型** 页面底部有一个**可展开**的「模型峰谷倍率」栏（默认收起，不占独立标签页）：

- **当前覆盖情况**（实时）：逐 provider 列出模型、当前倍率、命中哪个 profile；
  未收录的明确标「未收录」；
- **⚠ 告警**：某个 provider **整组都没有命中**时会高亮 —— 这通常意味着漏配
  （同一 provider 下混有非峰谷计价的模型属正常，不会告警）；
- **匹配规则**：内置 provider 映射表 + 有意不映射的 provider 及理由；
- **如何自定义**：`providerAliases` / `modelMappings` 的配置示例。

已在覆盖内的 provider：`deepseek-official`、`ollama`、`xiaomi-token-plan-cn`、
`ocg` / `ocg-1` / `opencode-go`（OpenCode Go 与 DeepSeek 官方窗口一致）、
`bai`、`zai`、`qoder`、`tencent-cloud`、`alibaba-cloud`、`swarms`。

已知**有意不映射**：`openrouter`（聚合网关，provider 级规则不成立）、
`ocg-1-chat`（仅 omen-alpha 等非峰谷计价模型）。

### 关于「替换模型选择器」

菜单内逐行倍率**必须**接管官方选择器（`conversation.input.model`，single +
`replaceRisk: shadows-shipped-ui`）——经核查官方组件不声明 children、内部
0 处 `renderSlot`，**没有任何扩展点**。

因此本项目**完整移植**了官方实现（`@deepseek-ai/dsh-client-ui-model-selection`，
**MIT**，上游 `0.1.5-rc.1`），要求**功能超集**：键盘导航、aria、portal 定位、
toast、加载/错误/重试、effort 两级菜单等**全部保留**，仅增加每行倍率徽章。
样式亦取自官方 CSS，仅改类名前缀，保证视觉一致。

> **历史教训**：早期版本曾用**残缺的**替换实现接管该槽位（无 effort、无加载态），
> **直接导致无法切换模型**。因此「接管」在本项目是**有纪律的行为**：
> 必须在 `INTENTIONALLY_SHADOWED` 清单登记理由、功能超集、并经隔离实例
> 与官方**逐项对照验证**。守卫测试见 `test/bundle-contract.test.ts`。

## 已知限制

- **`providerAliases` / `modelMappings` / `customProfiles` 目前只影响 host 侧**
  （`CatalogStore` 的数据加载），**不影响 UI 渲染**——client 用的是构建期打包的
  快照 + 内置映射。原因是 host 树与 client 树是两套独立 cordis 实例，client 拿不到
  host 服务；要把配置送到 client 需要另加 RPC 通道（尚未实现）。
- **不显示单价 / 花费 / 余额**（刻意不做）。
- **不显示「选择器内每一行」的倍率徽章**（见上）。

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
npm test          # 111 项单测（纯函数 + 构建产物契约 + 槽位守卫）
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
scripts/
└── build-client.mjs  # client 半边打包（见下方「两个宿主契约」）
```

**零 npm 运行时依赖**：时区与时段计算全部用原生 `Intl` + `Date` 实现。

### 三个宿主契约（改代码前务必知道）

DSH 插件的 host 侧与 client 侧走**两套独立 cordis 实例**，都不能凭对常规 ESM 插件
生态的直觉推断：

1. **host 侧服务注册必须 `ctx.provide(name, …)`**，不能用 `ctx.set`。
   `ctx.set` 只能**覆写已注册**的服务，首次注册会崩
   `cannot set property "X" without provide`。
2. **client 半边必须是 `window.__ModuleLoader__.load({ id, factory })` 包裹的 CJS**。
   服务端把各插件 client bundle **原样拼接**成 classic `<script>` 批量 bundle，
   裸 ESM `import` 会让**整批**脚本 SyntaxError（浏览器报 `Failed to load plugins`）。
   因此 `build:client` 走 `scripts/build-client.mjs`（esbuild CJS + 手工包壳），
   格式与官方插件 `lib/client.js` 一致。
3. **client 拿不到 host 的服务**——两棵树互相隔离。profile 数据由
   `scripts/build-client.mjs` 在**构建期注入**（`__PEAKRATE_PROFILES__`）烤进
   client bundle；注册 slot 时还必须传 `inject: () => ({ peakrate: … })` 提供注入面。
   **漏掉 inject 的后果是 UI 一个徽章都不显示**（插件加载正常、单测全绿，功能却是死的）。

   > 该缺陷的回归测试见 `test/bundle-contract.test.ts`——它从**构建产物**出发验证契约，
   > 而不是直接给纯函数喂数据（后者正是当初漏掉此缺陷的原因）。

设计文档见 [`.plans/spec/dsh-peakrate-spec.md`](.plans/spec/dsh-peakrate-spec.md)。

## 许可

MIT
