import assert from "node:assert/strict"
import test from "node:test"

import * as config from "../../private/core/config.js"
import { deps } from "./fake.mjs"

test("keys are stored 0600 and only shown masked", async () => {
  const d = deps()
  await config.set(d, "ZHIPU_API_KEY", "  secret-abcd1234 ")
  assert.equal(d.fs.modes.get("/state/config.json"), 0o600)
  const view = await config.view(d)
  assert.deepEqual(view.ZHIPU_API_KEY, { value: "…1234", default: null, saved: true, secret: true })
  assert.equal(view.ZHIPU_SEARCH_ENGINE.value, null)
  assert.equal(view.ZHIPU_SEARCH_ENGINE.default, "search_std")
  assert.ok(!JSON.stringify(view).includes("secret-abcd"))
  assert.equal((await config.resolve(d)).zhipu.key, "secret-abcd1234")
  await config.unset(d, "ZHIPU_API_KEY")
  assert.equal((await config.resolve(d)).zhipu, null)
})

test("values are validated", () => {
  assert.throws(() => config.validate("NOPE", "x"), /unknown/)
  assert.throws(() => config.validate("SMART_SEARCH_FALLBACK_MODE", "maybe"), /one of/)
  assert.throws(() => config.validate("EXA_TIMEOUT_SECONDS", "0"), /positive/)
  assert.throws(() => config.validate("XAI_TOOLS", "web_search,bogus"), /bogus/)
  assert.throws(() => config.validate("ZHIPU_API_URL", "ftp://x"), /http/)
  assert.equal(config.validate("SMART_SEARCH_RETRY_MAX_ATTEMPTS", "0"), "0")
  assert.equal(config.validate("OPENAI_COMPATIBLE_STREAM", "TRUE"), "true")
})

test("import takes only known, valid keys from the old CLI config", async () => {
  const legacy = { XAI_API_KEY: "xk-1", SMART_SEARCH_DEBUG: "true", SSL_VERIFY: "false", EXA_TIMEOUT_SECONDS: "-1", XAI_TOOLS: "web_search" }
  const d = deps({ files: { "/legacy.json": JSON.stringify(legacy) } })
  assert.deepEqual((await config.importLegacy(d, "/legacy.json")).sort(), ["XAI_API_KEY", "XAI_TOOLS"])
  const cfg = await config.resolve(d)
  assert.deepEqual(cfg.xai.tools, ["web_search"])
  assert.equal(cfg.retry.attempts, 4, "3 retries by default → 4 attempts")
  assert.equal(cfg.context7.url, "https://context7.com")
})

test("openrouter models get the :online suffix", async () => {
  const d = deps({ config: { OPENAI_COMPATIBLE_API_URL: "https://openrouter.ai/api/v1", OPENAI_COMPATIBLE_API_KEY: "k", OPENAI_COMPATIBLE_MODEL: "x/grok" } })
  assert.equal((await config.resolve(d)).openai.model, "x/grok:online")
})
