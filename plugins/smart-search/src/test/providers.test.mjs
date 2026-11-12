import assert from "node:assert/strict"
import test from "node:test"

import * as config from "../../private/core/config.js"
import * as openai from "../../private/core/providers/openai-compatible.js"
import * as xai from "../../private/core/providers/xai-responses.js"
import * as route from "../../private/core/route.js"
import { common, deps, fixtures, stable } from "./fake.mjs"

for (const item of fixtures("parse"))
  test(`parse: ${item.name}`, () => {
    const parse = item.provider === "openai" ? openai.parseSearch : xai.parseSearch
    const content = parse({ status: 200, headers: {}, text: item.body })
    // Python 的 sources(...) 用带空格的 JSON 分隔符；拆分后两边一致即可
    assert.equal(content.replace(/\nsources\(.*\)$/s, ""), item.output.replace(/\nsources\(.*\)$/s, ""))
    const tail = (text) => JSON.parse(text.match(/sources\((.*)\)$/s)?.[1] ?? "[]")
    assert.deepEqual(tail(content), tail(item.output))
  })

const call = (d, cfg, input) => {
  switch (input.fn) {
    case "zhipu":
      return route.zhipuSearch(d, cfg, { query: input.query, count: input.count })
    case "exa":
      return route.exaSearch(d, cfg, input)
    case "c7-library":
      return route.context7Library(d, cfg, input.name, input.query)
    case "c7-docs":
      return route.context7Docs(d, cfg, input.libraryId, input.query)
    case "fetch":
      return route.fetchPage(d, cfg, input.url)
  }
}

for (const item of fixtures("providers"))
  test(`provider: ${item.name}`, async () => {
    const d = deps({ responses: item.responses, config: { ...item.env, SMART_SEARCH_RETRY_MAX_ATTEMPTS: "1" } })
    const output = await call(d, await config.resolve(d), item.input)
    if (item.output.error_type === "config_error") {
      // 未配置的提示文字指向 Berth 配置页，与 CLI 不同；只比类型。本插件不为没配置的服务商记 attempt。
      assert.equal(output.ok, false)
      assert.equal(output.error_type, "config_error")
      return
    }
    if (item.name.startsWith("context7-docs")) {
      // content 是 JSON 序列化文本，分隔符风格不同；比解析后的值
      assert.deepEqual(JSON.parse(output.content), JSON.parse(item.output.content))
      delete output.content
      // text 是本插件新增的文档正文字段
      assert.equal(output.text, item.name.endsWith("text") ? "plain docs" : JSON.stringify([{ c: 1 }, { i: 1 }], null, 2))
      delete output.text
    }
    assert.deepEqual(stable(output), common(output, item.output))
  })
