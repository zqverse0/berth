import { describe, expect, it } from "vitest"
import type { ModelProviderInfo } from "@/lib/types"
import { modelUsableBy, providerDefaultApis } from "./models"
import { providerCatalogModels, serializeModels } from "./overlays"

const provider: ModelProviderInfo = {
  id: 1,
  name: "Relay",
  api_url: "https://gw.example",
  api_key: "",
  api_key_masked: "",
  agent_type: "",
  model: JSON.stringify([{ name: "Catalog", id: "gpt-4" }]),
  website: null,
  kind: "custom",
  overlays: [
    {
      agent_type: "claude_code",
      models: JSON.stringify([
        { slot: "sonnet", id: "claude-sonnet-4", name: "Sonnet 4" },
      ]),
    },
    {
      agent_type: "codex",
      models: JSON.stringify([{ id: "gpt-4.1", name: "GPT 4.1" }]),
    },
  ],
  created_at: "",
  updated_at: "",
}

describe("providerCatalogModels", () => {
  it("uses the shared catalog for every agent", () => {
    expect(providerCatalogModels(provider).map((item) => item.id)).toEqual([
      "gpt-4",
    ])
    expect(providerCatalogModels(provider).map((item) => item.id)).toEqual([
      "gpt-4",
    ])
  })

  it("does not leak other agent overlays when queried with specific agentType", () => {
    const providerWithoutRootModel: ModelProviderInfo = {
      ...provider,
      model: null,
      overlays: [
        {
          agent_type: "grok",
          models: JSON.stringify([{ id: "grok-4", name: "Grok 4" }]),
        },
      ],
    }

    // codex 查找不应泄露 grok 的 overlay 模型
    expect(
      providerCatalogModels(providerWithoutRootModel, "codex").map(
        (item) => item.id
      )
    ).toEqual([])

    // grok 查找能正常找到 grok 的 overlay 模型
    expect(
      providerCatalogModels(providerWithoutRootModel, "grok").map(
        (item) => item.id
      )
    ).toEqual(["grok-4"])
  })
})

describe("model APIs", () => {
  it("round-trips per-model APIs and filters by what the agent speaks", () => {
    const model = serializeModels([
      { name: "a", id: "gpt-6-astra", apis: ["openai-responses"] },
      { name: "c", id: "claude-x", apis: ["anthropic", "openai-chat"] },
      { name: "m", id: "mystery" },
    ])
    const models = providerCatalogModels({ ...provider, model })
    expect(models.map((item) => item.apis)).toEqual([
      ["openai-responses"],
      ["openai-chat", "anthropic"],
      undefined,
    ])
    const codex = ["openai-responses"]
    expect(
      models.filter((item) => modelUsableBy(item, codex)).map((item) => item.id)
    ).toEqual(["gpt-6-astra", "mystery"])
    // Agent 未声明接口：不筛
    expect(models.filter((item) => modelUsableBy(item, null))).toHaveLength(3)
  })
})

describe("provider default APIs", () => {
  it("reads defaultApis from discovery_json and tolerates junk", () => {
    expect(
      providerDefaultApis({
        discovery_json: JSON.stringify({ defaultApis: ["anthropic", "x"] }),
      })
    ).toEqual(["anthropic"])
    expect(providerDefaultApis({ discovery_json: "{" })).toBeUndefined()
    expect(providerDefaultApis(null)).toBeUndefined()
  })
})
