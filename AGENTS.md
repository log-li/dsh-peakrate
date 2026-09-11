# AGENTS.md — dsh-peakrate

DSH 生态插件：在**模型选择器**里为匹配到的模型显示**当前时段倍率**（峰/谷），
当前选中模型额外显示**切换倒计时**，hover 看精简详情。

**设计真相见 spec**：`.plans/spec/dsh-peakrate-spec.md ` —— 改行为前先读它，
改行为后先更新它（全局「Spec 先行规则」）。

## 形态

DSH bundle 插件 + client 半边，加入 profile 的 `dsh.profile.bundles` 即生效：

- `dsh.bundle.patch: ./cordis.patch.yml`（host 侧挂载自身）
- `dsh.client.platform: web`（client 侧替换模型选择器）

## 硬约束（违反即偏离 spec）

1. **零 npm 依赖**：时区与时段计算只用原生 `Intl.DateTimeFormat` + `Date`。
   **禁止**引入 luxon / date-fns / dayjs 等任何日期库。
2. **不复制参考实现的代码**：`dsh-peak-indicator`、`dsh-model-picker`、
   `dsh-quota-panel` 等（均 MIT）只借结构与算法思路，本项目自行实现；
   确有借鉴时在文件头注明灵感来源。
3. **样式只用 `--dsw-*` 设计 token**，不硬编码颜色。
4. **不显示金额**：本插件只显示倍率与倒计时，不做单价/花费计算。

## 结构

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

**`schedule.ts` 与 `matching.ts` 必须保持纯函数**（不依赖 DSH 运行时），
所有时段边界与匹配规则都靠它们的单测覆盖。

## 关键 API

模型目录走官方 `ctx.modelDirectories.directoryFor(sessionId)`（与自带 `/model`
弹窗共享同一 `ModelDirectory`），**不自行枚举 provider 配置**。

## DSH 插件通用坑（踩过的）

- **host 侧 `ctx.set` 必须先 `ctx.provide`**：cordis 里 `ctx.set(name, …)` 只能
  **覆写已注册**的服务；首次注册必须 `ctx.provide(name, …)`，否则启动即崩
  `cannot set property "X" without provide`（实测：dsh-peakrate 首发踩坑）。
- **client 包必须是 `window.__ModuleLoader__.load({ id, factory })` 包裹的 CJS**：
  服务端把各插件 client bundle **原样拼接**成 classic `<script>` 批量 bundle，
  esbuild `--format=esm` + `--external:react` 会留下裸 `import * as React`，
  整批 12.9MB 脚本 SyntaxError → 浏览器报 `Failed to load plugins`（`client-modules:
  bundle script … failed to load`）。正确做法：esbuild 打 CJS 后手工包一层
  `window.__ModuleLoader__.load({ id, factory: (require) => { …return module.exports } })`
  （与官方/第三方插件 lib/client.js 格式一致）。
- **client 拿不到 host 的服务，且注册 slot 必须传 `inject`**：host 树与 client 树是
  两套独立 cordis 实例，client 侧 `ctx.get('peakrate')` 拿不到 host 的服务。数据要靠
  ① 构建期注入（`__PEAKRATE_PROFILES__` 烤进 bundle）+ ② 注册时传
  `inject: () => ({ peakrate: … })` 提供注入面。**漏掉 inject 的后果极隐蔽**：
  插件加载成功、host 正常、单测全绿，但组件读到的数据恒为空 → **UI 一个徽章都不显示**。
  回归测试见 `test/bundle-contract.test.ts`（从构建产物验证，而非直接喂纯函数）。

- **一条插件只能有一条注册路径**：要么 profile `package.json` 的
  `dsh.profile.bundles`，要么 `cordis.patch.yml` 手动 `insert`，**绝不能两者都做**
  → 否则启动即崩：`duplicate loader entry id: <id>`。
- **host 树 ≠ client 树**：`cordis.patch.yml` 的 `disabled: true` 只命中 host 树，
  管不住 `client.inject` 拉入的 client 侧插件。client 侧报错要顺
  `lib/client.js` 的 require 链找第一个 missing 模块。
- **不得在 `dependencies` 声明 DSH 共享宿主包**（`@deepseek-ai/dsh`、
  `@deepseek-ai/cordis` 等）——会遮蔽宿主版本。用 `peerDependencies`。

## 验证

**单测**（纯函数，不依赖 DSH 运行时）：

- `schedule.ts`：五类边界——峰时窗口内、窗口间隙、周末全天谷、周五末段跨周末、
  周日结束回峰时；以及同一时刻在 UTC 与 Asia/Shanghai 两种时区下的判定
- `matching.ts`：别名命中/未命中、`:` 后缀剥离、V4 系宽松归属、无匹配返回空、
  config 覆盖优先级

**实机验收**（装进 web profile 后开新会话）——见 spec §10，其中两条是核心证据：

1. `ollama`（**UTC**）与 `deepseek-official`（**北京时**）的倒计时**各自正确**
   ——同一模型不同 provider 时段规则不同，这是本插件区别于现有 DeepSeek 专用插件的价值所在
2. **E2E 审计**：通读模型选择器**完整渲染输出**（不只检查字段），确认无重复、
   无错位、无残留占位；未匹配的模型必须**什么都不显示**

## 提交门禁

- **Spec 先行**：行为/配置变化 → 先更新 spec（`.plans/spec/dsh-peakrate-spec.md `）
- **README 同步**：配置项/命令/默认值变化 → 一并更新 README
- **独立模型家族 review 在验证之前**：顺序固定为
  **写代码 → 独立 review → 按 review 修正 → 验证 → commit → push**。
  review 未过（有【严重】问题）不得进入验证；验证通过后再改代码须重新验证。
- **push 前敏感信息检查**：不落本机绝对路径、用户名、本地 provider 路由组合

## 文档落位

- **spec（活文档）**：`.plans/spec/dsh-peakrate-spec.md ` —— 描述项目**现在是什么样**，
  文件名不带日期、永不搬家，滚动更新；日期与变更历史写在文件内，历史靠 `git log` 回溯。
- **plan（一次性快照）**：`.plans/proposed/YYYY-MM-DD-<slug>.md` → 实现后移
  `.plans/implemented/` —— 记录**当时为什么这么定**，与 spec 分工不重叠。
