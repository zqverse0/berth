import { describe, expect, it } from "vitest"
import type { ModelProviderInfo } from "@/lib/types"
import {
  isProviderVisibleForLaunchbar,
  resolveProviderProtocolUrls,
} from "./visibility"

/** 档案工厂：只写本组用例关心的字段，其余取最小合法值。 */
function makeProvider(
  overrides: Partial<ModelProviderInfo> = {}
): ModelProviderInfo {
  return {
    id: 10,
    name: "Test Provider",
    api_url: "",
    api_key: "sk-test",
    api_key_masked: "sk-••••",
    agent_type: "",
    model: null,
    website: null,
    kind: "custom",
    agent_allowlist: [],
    overlays: [],
    created_at: "",
    updated_at: "",
    ...overrides,
  }
}

const EMPTY_URLS = { claude: "", chat: "", gemini: "", systemone: "" }

describe("resolveProviderProtocolUrls 是设置页与启动栏共用的唯一取值", () => {
  it("以结构化 endpoints 为准", () => {
    const urls = resolveProviderProtocolUrls(
      makeProvider({
        discovery_json: JSON.stringify({
          endpoints: { chat: { apiUrl: "https://chat.example/v1" } },
        }),
      })
    )
    expect(urls).toEqual({
      claude: "",
      chat: "https://chat.example/v1",
      gemini: "",
      systemone: "",
    })
  })

  it("没有端点的档案主地址按 chat 计", () => {
    const urls = resolveProviderProtocolUrls(
      makeProvider({ api_url: "https://legacy.example" })
    )
    expect(urls).toEqual({
      claude: "",
      chat: "https://legacy.example",
      gemini: "",
      systemone: "",
    })
  })

  it("endpoints 优先于主地址", () => {
    const urls = resolveProviderProtocolUrls(
      makeProvider({
        api_url: "https://legacy.example",
        agent_allowlist: ["claude_code"],
        discovery_json: JSON.stringify({
          endpoints: { chat: { apiUrl: "https://only-chat.example" } },
        }),
      })
    )
    expect(urls).toEqual({
      claude: "",
      chat: "https://only-chat.example",
      gemini: "",
      systemone: "",
    })
  })

  it("坏 JSON 与空档案返回空值，不抛错", () => {
    expect(
      resolveProviderProtocolUrls(makeProvider({ discovery_json: "{broken" }))
    ).toEqual(EMPTY_URLS)
    expect(resolveProviderProtocolUrls(makeProvider())).toEqual(EMPTY_URLS)
  })
})

describe("isProviderVisibleForLaunchbar 与设置页同一条规则", () => {
  const chatRelay = makeProvider({
    name: "Chat Relay",
    discovery_json: JSON.stringify({
      endpoints: { chat: { apiUrl: "https://chat.example/v1" } },
    }),
  })

  it("shows a chat relay when the bar declares chat", () => {
    expect(
      isProviderVisibleForLaunchbar(chatRelay, { protocols: ["chat"] })
    ).toBe(true)
    expect(
      isProviderVisibleForLaunchbar(chatRelay, { protocols: ["claude"] })
    ).toBe(false)
  })

  it("只有决策端点的档案不会被当成 chat 进入启动栏", () => {
    const decisionOnly = makeProvider({
      api_url: "https://api.typesafe.ai",
      discovery_json: JSON.stringify({
        endpoints: { systemone: { apiUrl: "https://api.typesafe.ai" } },
      }),
    })
    expect(resolveProviderProtocolUrls(decisionOnly)).toEqual({
      ...EMPTY_URLS,
      systemone: "https://api.typesafe.ai",
    })
    expect(
      isProviderVisibleForLaunchbar(decisionOnly, {
        protocols: ["chat", "claude", "gemini"],
      })
    ).toBe(false)
  })

  it("名单不再决定协议：只看端点（旧名单已由迁移改写成端点）", () => {
    const legacy = makeProvider({
      api_url: "https://newapi.zmoon.top",
      agent_allowlist: ["claude_code"],
      discovery_json: null,
    })
    expect(
      isProviderVisibleForLaunchbar(legacy, { protocols: ["claude"] })
    ).toBe(false)
    expect(isProviderVisibleForLaunchbar(legacy, { protocols: ["chat"] })).toBe(
      true
    )
  })

  it("没有端点的档案按 chat 显示", () => {
    const legacyNoAllowlist = makeProvider({
      api_url: "https://legacy.example",
      discovery_json: null,
    })
    expect(
      isProviderVisibleForLaunchbar(legacyNoAllowlist, { protocols: ["chat"] })
    ).toBe(true)
    expect(
      isProviderVisibleForLaunchbar(legacyNoAllowlist, {
        protocols: ["claude"],
      })
    ).toBe(false)
  })

  it("endpoints 优先于主地址", () => {
    const mixed = makeProvider({
      api_url: "https://legacy.example",
      agent_allowlist: ["claude_code"],
      discovery_json: JSON.stringify({
        endpoints: { chat: { apiUrl: "https://only-chat.example" } },
      }),
    })
    expect(isProviderVisibleForLaunchbar(mixed, { protocols: ["chat"] })).toBe(
      true
    )
    expect(
      isProviderVisibleForLaunchbar(mixed, { protocols: ["claude"] })
    ).toBe(false)
  })

  it("shows nothing when the bar did not declare protocols", () => {
    expect(isProviderVisibleForLaunchbar(chatRelay, { protocols: [] })).toBe(
      false
    )
    expect(isProviderVisibleForLaunchbar(chatRelay, {})).toBe(false)
  })

  it("matches whichever protocols the bar declared", () => {
    const claudeRelay = makeProvider({
      discovery_json: JSON.stringify({
        endpoints: { claude: { apiUrl: "https://claude.example" } },
      }),
    })
    expect(
      isProviderVisibleForLaunchbar(chatRelay, {
        protocols: ["chat", "claude"],
      })
    ).toBe(true)
    expect(
      isProviderVisibleForLaunchbar(claudeRelay, {
        protocols: ["chat", "claude"],
      })
    ).toBe(true)
  })

  it("gemini 只对声明 gemini 的启动栏可见", () => {
    const geminiRelay = makeProvider({
      discovery_json: JSON.stringify({
        endpoints: { gemini: { apiUrl: "https://gemini.example" } },
      }),
    })
    expect(
      isProviderVisibleForLaunchbar(geminiRelay, { protocols: ["gemini"] })
    ).toBe(true)
    expect(
      isProviderVisibleForLaunchbar(geminiRelay, { protocols: ["chat"] })
    ).toBe(false)
  })

  it("claims an official card by the agent file's own ids, not a brand list", () => {
    const official = makeProvider({
      kind: "official",
      agent_type: "claude_code",
      discovery_json: null,
    })
    expect(
      isProviderVisibleForLaunchbar(official, {
        protocols: ["claude"],
        ownerIds: ["claude", "claude_code"],
      })
    ).toBe(true)
    expect(
      isProviderVisibleForLaunchbar(official, {
        protocols: ["claude"],
        ownerIds: ["codex"],
      })
    ).toBe(false)
    expect(
      isProviderVisibleForLaunchbar(official, {
        protocols: [],
        ownerIds: ["claude_code"],
      })
    ).toBe(false)
  })
})
