import { createTranslator, IntlErrorCode } from "next-intl"
import { describe, expect, it } from "vitest"

import en from "./messages/en.json"
import zhCN from "./messages/zh-CN.json"

type MessageNode = string | { [key: string]: MessageNode }

function collectKeys(node: MessageNode, prefix = ""): string[] {
  if (typeof node === "string") {
    return [prefix]
  }
  const out: string[] = []
  for (const [key, value] of Object.entries(node)) {
    const next = prefix ? `${prefix}.${key}` : key
    out.push(...collectKeys(value, next))
  }
  return out
}

const reference = new Set(collectKeys(en as MessageNode))

// `en.json` is the source of truth. Any missing key in another locale fails
// the test with the exact dotted path, making translation gaps grep-able.
describe("i18n locale key parity vs en.json", () => {
  it.each([["zh-CN", zhCN]] as const)(
    "%s has the same key set as en",
    (_locale, messages) => {
      const localeKeys = new Set(collectKeys(messages as MessageNode))
      const missing = [...reference].filter((k) => !localeKeys.has(k))
      const extra = [...localeKeys].filter((k) => !reference.has(k))
      expect({ missing, extra }).toEqual({ missing: [], extra: [] })
    }
  )
})

// 一条 ICU 语法错误的文案（如未转义的 `<tool-id>` 被当成标签）会让 next-intl 的
// 编译期加载整页 500；逐条格式化，只认语法错误，缺参数之类的格式化错误不算。
describe("every message is valid ICU", () => {
  it.each([
    ["en", en],
    ["zh-CN", zhCN],
  ] as const)("%s parses", (locale, messages) => {
    expect(invalidMessages(locale, messages as MessageNode)).toEqual([])
  })

  it("catches an unescaped tag", () => {
    expect(invalidMessages("en", { bad: "replace <tool-id> here" })).toEqual([
      "bad",
    ])
  })
})

function invalidMessages(
  locale: "en" | "zh-CN",
  messages: MessageNode
): string[] {
  const invalid: string[] = []
  const t = createTranslator({
    locale,
    messages: messages as Record<string, MessageNode>,
    onError: (error) => {
      if (error.code === IntlErrorCode.INVALID_MESSAGE) invalid.push(current)
    },
  })
  let current = ""
  for (const key of collectKeys(messages)) {
    current = key
    try {
      ;(t as unknown as (key: string) => string)(key)
    } catch {
      invalid.push(key)
    }
  }
  return [...new Set(invalid)]
}
