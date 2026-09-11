/**
 * 信任围栏单测 —— 与官方 `isTrustedApiRequest` 同语义，防两类 confused-deputy：
 * DNS rebinding（Host 指向攻击者域名）与跨站请求（恶意页面发起）。
 */
import { describe, expect, it } from 'vitest'
import { isTrustedRequest } from '../src/catalog-route.js'

/** 构造一个只带 headers 的请求。 */
const req = (headers: Record<string, string>) => ({ headers }) as never

describe('isTrustedRequest —— 信任围栏', () => {
  it('回环 Host 通过（含端口与 IPv6）', () => {
    expect(isTrustedRequest(req({ host: '127.0.0.1:3080' }), [])).toBe(true)
    expect(isTrustedRequest(req({ host: 'localhost:3080' }), [])).toBe(true)
    expect(isTrustedRequest(req({ host: '[::1]:3080' }), [])).toBe(true)
  })

  it('回环允许带无 Origin 的裸请求（非浏览器客户端）', () => {
    expect(isTrustedRequest(req({ host: '127.0.0.1:3080' }), [])).toBe(true)
  })

  it('★ DNS rebinding：非回环且未声明的 Host 一律拒绝', () => {
    expect(isTrustedRequest(req({ host: 'evil.example.com' }), [])).toBe(false)
    expect(isTrustedRequest(req({ host: 'evil.example.com', origin: 'http://evil.example.com' }), [])).toBe(false)
  })

  it('缺 Host 一律拒绝（Host 是 rebinding 无法伪造的那个头）', () => {
    expect(isTrustedRequest(req({}), [])).toBe(false)
    expect(isTrustedRequest(req({ host: '' }), [])).toBe(false)
  })

  it('部署声明的可信 authority 通过（精确 host:port / 省略端口匹配任意端口）', () => {
    expect(isTrustedRequest(req({ host: 'box.tailnet.ts.net' }), ['box.tailnet.ts.net'])).toBe(true)
    expect(isTrustedRequest(req({ host: 'box.tailnet.ts.net:3080' }), ['box.tailnet.ts.net'])).toBe(true)
    expect(isTrustedRequest(req({ host: 'box.tailnet.ts.net:9999' }), ['box.tailnet.ts.net:3080'])).toBe(false)
    expect(isTrustedRequest(req({ host: 'other.ts.net' }), ['box.tailnet.ts.net'])).toBe(false)
  })

  it('★ 跨站请求拒绝（sec-fetch-site: cross-site）', () => {
    expect(isTrustedRequest(req({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }), [])).toBe(false)
  })

  it('★ 带 Origin 时必须与 Host 同源', () => {
    expect(isTrustedRequest(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }), [])).toBe(true)
    // 端口不同 → 不同源
    expect(isTrustedRequest(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' }), [])).toBe(false)
    // 域名不同 → 不同源
    expect(isTrustedRequest(req({ host: '127.0.0.1:3080', origin: 'http://evil.example.com' }), [])).toBe(false)
    // Origin 非法 → 拒绝（不猜）
    expect(isTrustedRequest(req({ host: '127.0.0.1:3080', origin: 'not-a-url' }), [])).toBe(false)
  })

  it('非回环可信主机 + 同源 Origin 通过（tailnet 场景）', () => {
    const hosts = ['box.tailnet.ts.net']
    expect(
      isTrustedRequest(
        req({ host: 'box.tailnet.ts.net', origin: 'https://box.tailnet.ts.net' }),
        hosts,
      ),
    ).toBe(true)
  })
})
