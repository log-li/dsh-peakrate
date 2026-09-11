# AGENTS.md — dsh-peakrate

DSH 生态插件：在 **composer 工具行左侧**显示**当前模型**的峰谷倍率与切换倒计时，
hover 看精简详情。**不替换任何自带 UI**（见下方槽位坑）。

**设计真相见 spec**：`.plans/spec/dsh-peakrate-spec.md ` —— 改行为前先读它，
改行为后先更新它（全局「Spec 先行规则」）。

## 形态

DSH bundle 插件 + client 半边，加入 profile 的 `dsh.profile.bundles` 即生效：

- `dsh.bundle.patch: ./cordis.patch.yml`（host 侧挂载自身）
- `dsh.client.platform: web`（client 侧**追加**到 `conversation.input.left`）

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
│       ├── index.tsx     # 追加到 conversation.input.left，渲染当前模型徽章/倒计时
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

- **★ 绝不注册到 `replaceRisk: shadows-shipped-ui` 的槽位**（2026-09-12 事故）：
  这类槽位注册即**遮蔽官方实现**。本插件曾注册到 `conversation.input.model`
  （single + shadows-shipped-ui）做「替换选择器」，替换实现残缺 →
  **用户无法切换模型**。教训：**「槽位允许替换」≠「应该替换」**；
  用残缺实现接管核心交互入口，是把测试风险转嫁给用户的日常工具。
  - **正确做法**：注册到 `replaceRisk: none` 的 **list** 槽位做纯追加。
    本插件用 `conversation.input.left`（composer 工具行左侧）。
  - **查槽位安全性**：Client Slots Inspect `listSubTree` 会给出每个槽位的
    `kind` / `replaceRisk`。`single` + `shadows-shipped-ui` = 危险；
    `list` + `none` = 安全（可追加）。
  - **守卫测试**：`test/bundle-contract.test.ts` 维护 `SHADOWING_SLOTS` 清单并断言
    绝不注册其中任何一个。**改 slot 必跑它**。

- **★ client 插件的 `inject` 必须含 `remote.session`**（2026-09-12 实测）：
  `modelDirectories.directoryFor()` 内部要解析会话的模型选择投影，依赖
  `remote.session`。缺了它会在**浏览器运行时**抛
  `cannot get property "remote.session" without inject`——服务端产物、类型检查、
  单测**全部正常**，只有真实浏览器能暴露。
  官方 `dsh-client-ui-model-selection` 的 inject 为
  `["commandUi","locale","sessions","slots","remote","remote.session"]`。
  **新增消费服务时，先对照官方同类插件的 inject 清单，不要凭需要猜。**

- **取服务用属性访问，不要用 `ctx.get()`**：cordis 的服务代理只在**属性访问**
  （`scope.slots`）时把 `this.ctx` 绑定到调用方上下文；`get()` 拿到未绑定实例，
  其内部依赖解析不到。用 `scope.get('modelDirectories')` 实测会触发上面的报错。

- **★ 想遮蔽 `single` 槽位必须给 `priority`，且要**低于**对方**（2026-09-12 实测）：
  `single` 槽位**同一优先级只允许一个注册**，官方占 `0`；不给 `priority` 会直接抛
  `single slot "X" already has a registration at priority 0 (registered by Z8)
  — register at a different priority to shadow it (lowest renders)`。
  源码语义（`dsh-web-frontend` 的 slots 实现）：
  ```js
  p.sort(kind === 'list'
    ? (a, b) => priority - priority || order - order
    : (a, b) => priority - priority)   // single/keyed：按 priority 升序
  ```
  条目按 priority **升序**排列，而 `entriesOfSlot` 对 single **只取第一个**
  → **优先级最低者渲染**。所以遮蔽官方（0）要用 **`priority: -1`**。

- **list 槽位的 `register` 必须同时传 `name` 与 `id`**：`name` = 槽位键（决定注册到
  哪儿），`id` = **自己的** cell 键（自有 id = 追加，复用别人的 id = 占用其单元格）。
  **只传 `id` 会注册失败**。写法对照真实产物：
  `slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: 'memory', order: 100 }, C))`
  （见 dsh-plugin-memory / dsh-mcp-manager / dshmarket 的 `lib/client.js`）。

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

**构建产物契约**（`test/bundle-contract.test.ts`，从 `lib/client.js` 验证）：

- 产物是 `__ModuleLoader__` 包裹的 CJS、可被 classic script 解析
- **绝不注册到 `SHADOWING_SLOTS` 中的任何槽位**（含 `conversation.input.model`）
- 注册到 `conversation.input.left`，且**同时**传 `name`（槽位键）与 `id`（自有 cell 键）
- 注入面能给出非空 profiles，端到端能算出正确判定

### ★ 隔离实例实机验证（client 插件发布前的**标准动作**）

**不要拿用户正在用的实例试错。** 用独立 profile + 独立端口 + 无头浏览器验证：

```bash
# 1) 从出厂模板新建独立 profile（不碰用户的 profile）
dsh --profile peakrate-test --from-default-profile web --dump-config > /dev/null

# 2) 给它独立的 node_modules（逐项软链复用原 profile 的包，原 profile 零改动）
TEST=~/.dsh/profiles/peakrate-test; WEB=~/.dsh/profiles/web
mkdir -p "$TEST/node_modules"
for e in "$WEB"/node_modules/* "$WEB"/node_modules/.[!.]*; do
  [ -e "$e" ] || continue; b=$(basename "$e"); [ "$b" = dsh-peakrate ] || ln -sfn "$e" "$TEST/node_modules/$b"
done
ln -sfn /Users/logan/Projects/dsh-peakrate "$TEST/node_modules/dsh-peakrate"

# 3) 注册插件并启动到**另一个端口**
#    （package.json 的 dependencies + dsh.profile.bundles 各加一条）
dsh --profile peakrate-test --host 127.0.0.1 --port 3099 --no-open

# 4) Playwright 无头截图 + 交互（Chromium 在 ~/Library/Caches/ms-playwright）
#    关键断言：徽章渲染 + 自带选择器可用 + **控制台错误为 0**
```

**必查三项**：① 控制台/pageerror **为 0**；② 自带 UI 仍可用（真的去点它）；
③ 徽章渲染且数值正确。**「服务端下发了产物」≠「运行时无错」** —— 本次
`remote.session` 缺陷正是服务端一切正常、浏览器才报错。

**实机验收**（装进 web profile 后开新会话）——见 spec §10：

1. **确认自带模型选择器仍可用**（最高优先级——上一版就是在这里翻车的）
2. composer 工具行左侧出现当前模型的徽章；`ollama`（UTC）与 `deepseek-official`
   （北京时）的倒计时**各自正确**——同一模型不同 provider 时段规则不同，这是本插件
   区别于 DeepSeek 专用插件的价值所在
3. 未匹配的模型（如 kimi-k3）**什么都不显示**

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
