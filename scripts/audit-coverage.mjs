#!/usr/bin/env node
/**
 * 覆盖穷举审计 —— 从**运行实例的设置页**读出「provider × model」覆盖表并汇总。
 *
 * ## 为什么需要它（2026-09-12 教训）
 *
 * `ocg` / `opencode-go` 曾因「数据源没收录」被静默漏掉：把「数据源覆盖率」
 * 误当成「上游是否有峰谷定价」。防范机制见 spec §4.4，本脚本是其中的
 * 「交付前穷举」一环。
 *
 * ## 用法
 *
 * ```bash
 * # 需要实例已在跑，并拿到它的 token（启动时打印）
 * node scripts/audit-coverage.mjs "http://127.0.0.1:3080/?token=<token>"
 * ```
 *
 * 依赖 Playwright（本机已全局安装；不在 package.json 里，因为这是开发工具，
 * 不是插件运行时依赖 —— **插件保持零 npm 运行时依赖**）。
 *
 * ## 判读
 *
 * - **整组零命中** → 必须确认：是「确实没有峰谷定价」（→ 写进
 *   `src/matching.ts` 的 `UNMATCHED_BY_DESIGN`）还是「漏配 / endpoint 未被识别」
 *   （→ 补别名与映射）。
 * - **部分未命中**属正常：同一 provider 下常混有非峰谷计价的模型
 *   （如 ollama 下的 GLM / Kimi），全部提示等于没提示。
 *
 * 退出码：0 = 无需确认的整组零命中；1 = 存在待确认项（或运行失败）。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 优先从全局安装解析 Playwright，其次从本地。 */
function loadPlaywright() {
  const candidates = [
    '/Users/logan/.npm-global/lib/node_modules/playwright',
    'playwright',
  ]
  for (const id of candidates) {
    try {
      return require(id)
    } catch {
      /* 继续尝试下一个 */
    }
  }
  throw new Error('未找到 Playwright。请先 `npm i -g playwright` 或 `npx playwright install`。')
}

const url = process.argv[2]
if (url === undefined) {
  console.error('用法: node scripts/audit-coverage.mjs "http://127.0.0.1:3080/?token=<token>"')
  process.exit(2)
}

const { chromium } = loadPlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(10_000)
  await page.click('text=设置')
  await page.waitForTimeout(2_000)
  await page.click('text=模型峰谷倍率')
  await page.waitForTimeout(2_500)

  const out = await page.evaluate(() => {
    const tbody = document.querySelector('.dsh-peakrate-settings-table tbody')
    if (tbody === null) return { error: '未找到覆盖表（设置页未渲染？）' }
    const groups = []
    let cur = null
    for (const tr of tbody.querySelectorAll('tr')) {
      const tds = [...tr.querySelectorAll('td')].map((td) =>
        td.innerText.replace(/\s+/g, ' ').trim(),
      )
      const [prov, model, rate] = tds
      // provider 名只出现在每组首行，需按序跟踪
      if (prov !== undefined && prov !== '') {
        cur = { name: prov, rows: [] }
        groups.push(cur)
      }
      if (cur !== null && model !== undefined && model !== '' && !/未提供模型/.test(model)) {
        cur.rows.push({ model, covered: !/未收录/.test(rate ?? '') })
      }
    }
    const alert = document.querySelector('.dsh-peakrate-settings-alert')
    return { groups, alert: alert === null ? null : alert.innerText.replace(/\n/g, ' | ') }
  })

  if (out.error !== undefined) {
    console.error('❌', out.error)
    process.exit(1)
  }

  console.log('=== 覆盖穷举（设置页实时数据）===')
  let unconfirmed = 0
  for (const g of out.groups) {
    const total = g.rows.length
    const covered = g.rows.filter((r) => r.covered).length
    const flag =
      covered === 0 ? '⚠ 整组零命中' : covered < total ? '部分未命中(正常)' : '全部命中'
    if (covered === 0) unconfirmed++
    console.log(`  ${g.name.padEnd(44)} ${covered}/${total}  ${flag}`)
  }
  console.log()
  console.log('设置页告警：', out.alert ?? '(无)')

  if (unconfirmed > 0) {
    console.log(
      `\n⚠ 有 ${unconfirmed} 组「整组零命中」——若其中某组未在 UNMATCHED_BY_DESIGN 写明理由，` +
        '设置页会给告警；此处仅作提示，请逐个确认是「确实无峰谷定价」还是「漏配」。',
    )
    process.exitCode = 1
  } else {
    console.log('\n✅ 无待确认项')
  }
} finally {
  await browser.close()
}
