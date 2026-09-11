# AGENTS.md — dsh-peakrate

DSH 生态插件：显示模型的峰谷倍率与切换倒计时，三处呈现：

1. **composer 工具行**（追加式，`conversation.input.left`）——免开菜单即见当前模型倍率；
2. **模型选择器菜单内**（有意接管 `conversation.input.model`）——每行显示该模型此刻的峰谷，
   选型时可直接比价；
3. **设置 → 插件 → 插件配置 卡片**（追加式，`settings.plugin.item`）——可展开的实时覆盖面板
   + 规则说明；并让插件的 `enabled` / `refreshIntervalHours` 可在界面里编辑。

第 2 项是**有意遮蔽**自带 UI，必须遵守「**功能超集**」纪律（见下方槽位坑）。

**三种时段态**：`peak`（峰）/ `offPeak`（谷）/ **`campaign`（限时活动，来自
`schedule.overrides`，带日期区间与星期过滤，优先级高于常规峰谷）**。

**设计真相见 spec**：`.plans/spec/dsh-peakrate-spec.md ` —— 改行为前先读它，
改行为后先更新它（全局「Spec 先行规则」）。

## 形态

DSH bundle 插件 + client 半边，加入 profile 的 `dsh.profile.bundles` 即生效：

- `dsh.bundle.patch: ./cordis.patch.yml`（host 侧挂载自身）
- `dsh.client.platform: web`（client 侧：追加徽章 + 有意接管模型选择器）

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
│   ├── coverage.ts       # 纯函数：覆盖率计算（设置页与审计共用）
│   ├── catalog-route.ts  # 带信任围栏的 /peakrate/catalog 路由
│   └── client/
│       ├── index.tsx     # 注册三处 + locale 文案
│       ├── live.ts       # 运行时目录拉取 + 内置快照回退
│       ├── ModelSelect.tsx    # fork 官方选择器（功能超集）+ 每行倍率徽章
│       ├── SettingsSection.tsx # 「设置→插件」里的可展开配置卡片
│       ├── rate.ts       # 倍率判定共享层
│       ├── icons.tsx     # DSH 风格单色描边 SVG 图标
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

- **★ 遮蔽 `shadows-shipped-ui` 槽位的纪律**（2026-09-12 两次教训）：
  这类槽位注册即**遮蔽（取代）官方实现**。
  - **默认禁止**：优先用 `replaceRisk: none` 的 **list/keyed** 槽位做纯追加。
    查法：Client Slots Inspect `listSubTree` 给出 `kind` / `replaceRisk`。
  - **确有必要时**（如官方组件内部毫无扩展点，只能重写）：
    1. 在 `src/client/index.tsx` 的 **`INTENTIONALLY_SHADOWED`** 清单登记并**写明理由**；
    2. **必须功能超集**——官方有的交互（键盘/aria/portal/toast/错误态…）一个都不能少；
    3. 官方包须 **MIT**（或兼容许可），否则只可借鉴思路不可照搬；
    4. 隔离实例逐项对照验证（见下方「隔离实例实机验证」）；
    5. 记录上游版本（当前 `0.1.5-rc.1`），DSH 升级时对照重移植。
  - **血的教训**：本插件曾用**残缺的**替换实现接管
    `conversation.input.model`（无 effort 选择、无加载/错误态）→
    **用户无法切换模型**。**「槽位允许替换」≠「应该替换」**。
  - **守卫测试**：`test/bundle-contract.test.ts` 读 `INTENTIONALLY_SHADOWED`：
    清单**之外**的 shadowing 槽位一律禁止注册；清单内的必须写明理由。**改 slot 必跑它**。

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

- **★ esbuild 的 `--loader:.css=text` 只把 CSS 变成字符串，必须自己注入 DOM**
  （2026-09-12 实测）：缺了注入这一步，**所有 CSS 类名都没有样式** ——
  表现为菜单 `position: static` 跑到视口外、`max-height` 失效、布局全乱。
  做法与官方同构（**带去重**）：
  ```js
  const tagId = 'dsh-peakrate/style.css'
  if (document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-peakrate'
    tag.dataset.pluginCss = tagId
    tag.textContent = css          // import css from './style.css'
    document.head.appendChild(tag)
  }
  ```
  **契约测试与 DOM 断言都发现不了**——只有真实浏览器量 `getComputedStyle` 才暴露。

- **★ 防静默遗漏：新 provider 必须有明确归属**（2026-09-12 教训）：
  匹配的默认行为是「匹配不到就什么都不显示」——**缺少决策会被当成决策就是不做**。
  因此每个已知 provider 必须**要么在 `DEFAULT_PROVIDER_ALIASES` 有映射、
  要么在 `UNMATCHED_BY_DESIGN` 写明理由**（守卫测试强制）。
  - **判断依据是上游是否有峰谷定价，不是数据源是否收录**：转售方（如 OpenCode Go
    转售 DeepSeek）**继承上游规则**，而数据源只收录直连厂商。
  - 新增 provider 时：先查其文档/定价页 → 有峰谷则加映射（附依据链接进 spec §4.3），
    无则进 `UNMATCHED_BY_DESIGN` 写理由。
  - 交付前跑「覆盖穷举」审计（见下方验证节）。

- **★ `settings.plugin.item` 的 key 必须是 Host 提供的 settings 命名空间**
  （2026-09-12 实测）：该页签只渲染 key ∈ `settings.describe().namespaces` 的卡片
  （见 dsh-client-ui-settings-plugins 的 `publish()`）。
  **光在 settings.yaml 加一个顶层 key 不会被 serve** —— 必须在 **host 半边**
  调 `ctx.inject(['settings'], c => c.settings.installSection(ctx, ns, schema, entry, hooks))`
  声明命名空间（范例 `dsh-tool-subagent/lib/model-selection-settings.js`），
  schema 用 `@deepseek-ai/schemastery`（共享包 → peerDependency）。
  收益不止「卡片能渲染」：**插件的配置项由此变成界面可编辑**。

- **★ `settings.installSection` 的钩子契约：`setSource` 只交接一次，`onChange` 才是变更信号**
  （2026-09-12 用**写文件探针**实测）。契约是「**存读取器 + 按需再拉**」：
  - `setSource(reader)` **只在安装时调用一次**，把「读当前用户设置」的函数交给你；
  - 用户之后每次编辑**只触发 `onChange`**，**不会**再调 `setSource`；
  - 因此**不能在 `setSource` 里一次性取值就完事**，必须在 `onChange`（或每个使用点）
    调 `reader()` 重新拉取。官方两个使用方（`dsh-agent-loop` / `dsh-tool-subagent`）
    都是 `setSource: (s) => { source = s }` + 用时读 `source()`。
  - 反例：本插件曾写 `setSource: (s) => applySettings(s())` + `onChange: () => {}`
    → 用户编辑**永远到不了运行中的实例**（静默失效，UI 看着正常）。
  - 探针方法（可靠且可复用）：在回调里 `fs.appendFileSync('/tmp/probe.log', …)`，
    重启实例后改一次 `settings.yaml`，读文件即可看出哪个回调被触发。

- **★ 请求处理路径上访问未 inject 的服务 → 抛错 → webserver 兜底成 HTTP 400**
  （2026-09-12 实测）：`ctx.webRuntime` 这类属性访问在未声明 inject 时抛
  `cannot get property "webRuntime" without inject`；而**路由 handler 抛出的异常会被
  dsh-host-webserver 兜成 `writeHead(400)`** —— 症状是「路由匹配上了（未知路径 404、
  本路由 400）却全 400」，且**日志里什么都看不到**（插件 logger 不进 stdout）。
  排查法：`curl -i` 看是谁返回的；对照一个不存在的路径拿到 404 即可确认路由已匹配。
  修法：用 `ctx.get('x')` 或把整段包 try/catch —— **围栏类代码宁可退化成保守行为，
  也不能让路由 400/500**。

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
- 除 `INTENTIONALLY_SHADOWED` 清单外，**不得注册任何 shadowing 槽位**
- 清单内的槽位**必须写明理由**（>20 字符，防无理由遮蔽）
- `conversation.input.left` 用 `id`（追加）；`conversation.input.model` 用 `name` +
  `priority: -1`（遮蔽）
- 接管选择器时**必须同时保留**工具行徽章（两者互补，不可二选一）
- 注入面能给出非空 profiles，端到端能算出正确判定
- `inject` 含 `slots`/`sessions`/`modelDirectories`/`remote`/`remote.session`

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
ln -sfn "$(pwd)" "$TEST/node_modules/dsh-peakrate"   # 在插件仓库根目录执行

# 3) 注册插件并启动到**另一个端口**
#    （package.json 的 dependencies + dsh.profile.bundles 各加一条）
dsh --profile peakrate-test --host 127.0.0.1 --port 3099 --no-open

# 4) Playwright 无头截图 + 交互（Chromium 在 ~/Library/Caches/ms-playwright）
#    关键断言：徽章渲染 + 自带选择器可用 + **控制台错误为 0**
```

**必查三项**：① 控制台/pageerror **为 0**；② 自带 UI 仍可用（真的去点它）；
③ 徽章渲染且数值正确。**「服务端下发了产物」≠「运行时无错」** —— 本次
`remote.session` 缺陷正是服务端一切正常、浏览器才报错。

**与官方逐项对照**（fork 的槽位尤其重要——曾在此翻车）：同一脚本分别跑
「启用插件」与「禁用插件」两种配置，行为必须一致。已验证一致的项目：
根面板两项 · 列表行数与分组 · 点当前模型关菜单 · 点其它模型发出
`POST /api/session/selectModel` → 200 · Escape 逐级返回 · 页面错误 0。

> **注意**：隔离 profile 的 `selectModel` 虽返回 200，但 UI 投影不刷新
> （官方同样如此）——属该环境的限制，**不能据此判断切换成功**。
> 真实切换需在用户 profile 由人确认。

### ★ 交付前「覆盖穷举」审计（2026-09-12 教训，必做）

**背景**：ocg/opencode-go 曾因「数据源没收录」被静默漏掉 —— 把「数据源覆盖率」
误当成「上游是否有峰谷定价」。防范机制见 spec §4.4。

**做法**（每次装机前）：
1. 打开 **设置 → 插件 → 插件配置 → 模型峰谷倍率**，通读「当前覆盖情况」表；
2. 若顶部出现 **⚠ N 个 provider 完全没有命中** 告警 → **逐个确认**：
   - 「确实没有峰谷定价」→ 在 `src/matching.ts` 的 `UNMATCHED_BY_DESIGN` 写明理由；
   - 「endpoint 未被识别 / 漏配」→ 补 `DEFAULT_PROVIDER_ALIASES` + 映射 + 回归测试。
3. 确认每一条排除都有依据（**附链接**），并把结论同步进 spec §4.3。

**⚠ 判据是「整组零命中」，不是「有未命中」** —— 同一 provider 下混有非峰谷计价的
模型（如 ollama 下的 GLM/Kimi）是正常的，全部提示等于没提示。

**实机验收**（装进 web profile 后开新会话）——见 spec §10：

1. **确认模型选择器可用**：能打开、能切换模型、切换后触发器更新
2. 菜单内每行显示倍率；未匹配的模型（如 kimi-k3）**什么都不显示**
3. composer 工具行的当前模型徽章仍在（与菜单呈现互补）
4. `ollama`（UTC）与 `deepseek-official`（北京时）的倒计时**各自正确**
5. **设置 → 插件 → 插件配置** 出现「模型峰谷倍率」卡片，展开后覆盖表正常且**无 ⚠ 告警**

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
