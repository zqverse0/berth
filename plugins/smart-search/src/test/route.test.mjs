import assert from "node:assert/strict"
import test from "node:test"

import * as config from "../../private/core/config.js"
import * as route from "../../private/core/route.js"
import { common, deps, fixtures, stable } from "./fake.mjs"

for (const item of fixtures("search"))
  test(`search: ${item.name}`, async () => {
    const d = deps({ responses: item.responses, config: { ...item.env, SMART_SEARCH_RETRY_MAX_ATTEMPTS: "1" } })
    const output = await route.search(d, await config.resolve(d), item.input)
    for (const key of ["ok", "error_type", "error", "query", "content", "primary_sources", "extra_sources", "provider_attempts", "fallback_used"])
      assert.ok(key in output, `missing ${key}`)
    if (item.output.error_type === "config_error") {
      assert.equal(output.error, item.output.error)
      return
    }
    // 主搜索出错的消息里带宿主的错误文本，只比前缀
    const attempts = (list) => list.map(({ error, ...rest }) => ({ ...rest, error: error.split(":")[0] }))
    assert.deepEqual(attempts(stable(output.provider_attempts)), attempts(stable(item.output.provider_attempts)))
    const { provider_attempts: _, ...js } = output
    const { provider_attempts: __, ...py } = item.output
    assert.deepEqual(stable(js), common(js, py))
  })

test("sources mode only walks the source chains", async () => {
  const d = deps({
    responses: {
      "POST https://open.bigmodel.cn/api/paas/v4/web_search": { status: 429, body: "" },
      "POST https://api.tavily.com/search": { status: 200, body: JSON.stringify({ results: [{ title: "T", url: "https://t.test", content: "c" }] }) },
    },
    config: { ZHIPU_API_KEY: "z", TAVILY_API_KEY: "t", XAI_API_KEY: "x" },
  })
  const output = await route.search(d, await config.resolve(d), { query: "最新新闻", mode: "sources" })
  assert.equal(output.ok, true)
  assert.deepEqual(output.primary_sources.map((item) => [item.provider, item.url]), [["tavily", "https://t.test"]])
  assert.deepEqual(output.provider_attempts.map((item) => [item.provider, item.status]), [["zhipu", "error"], ["tavily", "ok"]])
  assert.ok(!d.http.calls.some((call) => call.key.includes("x.ai")), "AI 搜索不该被调用")
})

test("cancellation propagates instead of becoming a provider error", async () => {
  const d = deps({ config: { ZHIPU_API_KEY: "z" } })
  d.http.fetch = async () => {
    throw Object.assign(new Error("cancelled"), { reason: "cancelled" })
  }
  await assert.rejects(route.search(d, await config.resolve(d), { query: "q", mode: "sources" }), { reason: "cancelled" })
})

test("main search sends retry and the AI timeout from config", async () => {
  const d = deps({
    responses: { "POST https://api.x.ai/v1/responses": { status: 200, body: JSON.stringify({ output: [] }) } },
    config: { XAI_API_KEY: "x", TAVILY_API_KEY: "t", AI_TIMEOUT_SECONDS: "60", SMART_SEARCH_RETRY_MAX_ATTEMPTS: "2" },
  })
  await route.search(d, await config.resolve(d), { query: "q" })
  const { spec } = d.http.calls.find((call) => call.key.endsWith("/responses"))
  assert.equal(spec.timeoutMs, 60_000)
  assert.deepEqual(spec.retry, { attempts: 3, maxWaitMs: 10_000 })
  assert.match(JSON.parse(spec.body).input[0].content, /^\[Current Time Context\]\n- Date: 2026-11-11 \(星期三\)/)
})
