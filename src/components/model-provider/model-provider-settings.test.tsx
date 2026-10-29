import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { ModelProviderInfo } from "@/lib/types"
import { ModelProviderSettings } from "./model-provider-settings"

const mocks = vi.hoisted(() => ({
  listModelProviders: vi.fn(),
  fetchProviderModels: vi.fn(),
  fetchLoginModels: vi.fn(),
  saveLoginPresets: vi.fn(),
  updateModelProvider: vi.fn(),
  createModelProvider: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  listModelProviders: () => mocks.listModelProviders(),
  createModelProvider: (...args: unknown[]) =>
    mocks.createModelProvider(...args),
  updateModelProvider: (...args: unknown[]) =>
    mocks.updateModelProvider(...args),
  deleteModelProvider: vi.fn(),
}))

vi.mock("@/lib/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/model-provider")>()
  return {
    ...actual,
    fetchProviderModels: (...args: unknown[]) =>
      mocks.fetchProviderModels(...args),
    importCcSwitchProviders: vi.fn(),
    getProxyAccess: async () => ({
      baseUrl: "http://127.0.0.1:15723",
      listening: true,
      token: "berth-tk-test",
    }),
    listLoginCards: async () => [
      {
        agentId: "codex",
        agentName: "Codex",
        agentType: "codex",
        hasUsage: false,
        loginId: "chatgpt",
        label: "ChatGPT subscription",
        credentialPresent: true,
        hasModels: true,
      },
      {
        agentId: "pi",
        agentName: "Pi",
        agentType: "pi",
        hasUsage: false,
        loginId: "chatgpt",
        label: "ChatGPT subscription",
        credentialPresent: false,
        hasModels: true,
      },
    ],
    fetchLoginModels: (agentId: string, loginId: string) =>
      mocks.fetchLoginModels(agentId, loginId),
    saveLoginPresets: (...args: unknown[]) => mocks.saveLoginPresets(...args),
  }
})

// 档位选项来自各 Agent tool.json 的 providerInjection.slots
vi.mock("@/hooks/use-agent-profiles", () => ({
  useAgentProfiles: () => ({
    agents: [
      { id: "claude", name: "Claude", providerSlots: ["opus", "sonnet"] },
    ],
  }),
}))

vi.mock("@/lib/platform", () => ({
  openPath: vi.fn(),
}))

const relay: ModelProviderInfo = {
  id: 2,
  name: "Relay",
  api_url: "https://relay.example",
  api_key: "sk-test",
  api_key_masked: "sk-t••••est",
  agent_type: "claude_code",
  model: null,
  website: null,
  kind: "custom",
  agent_allowlist: ["claude_code"],
  overlays: [],
  created_at: "",
  updated_at: "",
}

const groupedProvider: ModelProviderInfo = {
  id: 3,
  name: "Multi Group Provider",
  api_url: "https://api.openai.com/v1",
  api_key: "sk-standard",
  api_key_masked: "sk-s••••rd",
  agent_type: "codex",
  model: JSON.stringify([
    { name: "gpt-4o", id: "gpt-4o" },
    { name: "gpt-4o-mini", id: "gpt-4o-mini" },
  ]),
  website: "https://openai.com",
  kind: "custom",
  agent_allowlist: ["codex"],
  discovery_json: JSON.stringify({
    endpoints: {
      chat: { apiUrl: "https://api.openai.com/v1" },
    },
    keyGroups: [
      {
        id: "1",
        name: "standard",
        key: "sk-standard",
        models: [{ name: "gpt-4o-mini", id: "gpt-4o-mini" }],
      },
      {
        id: "2",
        name: "vip",
        key: "sk-vip",
        models: [{ name: "gpt-4o", id: "gpt-4o" }],
      },
    ],
  }),
  overlays: [],
  created_at: "",
  updated_at: "",
}

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ModelProviderSettings />
    </NextIntlClientProvider>
  )
}

// SettingsSplit 用 useIsMobile；jsdom 没有 matchMedia（同 settings-sidebar.test.tsx）
beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
})

describe("ModelProviderSettings login credentials", () => {
  beforeEach(() => {
    mocks.listModelProviders.mockReset().mockResolvedValue([relay])
  })

  it("merges declared logins by id into one card and reads models on open", async () => {
    mocks.fetchLoginModels.mockImplementation(async (agentId: string) =>
      agentId === "pi"
        ? { models: [{ id: "openai-codex/gpt-5.5", name: "gpt-5.5" }] }
        : { models: [], error: "codex not found" }
    )
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText("Login credentials")).toBeInTheDocument()
    expect(await screen.findByText("Relay")).toBeInTheDocument()
    // 两个 Agent 的同 id 声明只出一张卡。
    await user.click(
      screen.getByRole("button", { name: /ChatGPT subscription/ })
    )

    expect(screen.getByText("Credential found")).toBeInTheDocument()
    expect(screen.getByText("Credential not found")).toBeInTheDocument()
    // 打开即读取，无需手动点；读取失败如实显示原因。
    expect(
      await screen.findByDisplayValue("openai-codex/gpt-5.5")
    ).toBeInTheDocument()
    expect(
      await screen.findByText(/Failed to read models: codex not found/)
    ).toBeInTheDocument()
    // 不落库：没有保存 / 删除档案按钮。
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull()
  })

  it("adds a preset model even when the login source cannot be read", async () => {
    mocks.saveLoginPresets.mockReset().mockResolvedValue(undefined)
    mocks.fetchLoginModels.mockResolvedValue({ models: [], error: "missing" })
    const user = userEvent.setup()
    renderPage()
    await user.click(
      await screen.findByRole("button", { name: /ChatGPT subscription/ })
    )

    // 预选项复用服务商页的模型编辑器：添加行 → 填 id → 保存。
    await user.click(
      (await screen.findAllByRole("button", { name: "Add Model" }))[0]
    )
    await user.type(
      screen.getAllByPlaceholderText("Upstream Model ID")[0],
      "gpt-5.5"
    )
    mocks.fetchLoginModels.mockResolvedValue({
      models: [{ id: "gpt-5.5", name: "gpt-5.5", preset: true }],
    })
    await user.click(screen.getAllByRole("button", { name: "Save presets" })[0])

    expect(mocks.saveLoginPresets).toHaveBeenCalledWith("codex", "chatgpt", [
      { id: "gpt-5.5", name: "gpt-5.5" },
    ])
  })
})

describe("ModelProviderSettings key groups", () => {
  beforeEach(() => {
    mocks.listModelProviders.mockReset().mockResolvedValue([groupedProvider])
    mocks.updateModelProvider
      .mockReset()
      .mockResolvedValue({ affectedRunningSessions: 0 })
  })

  it("renders key groups with independent keys and models", async () => {
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText("Multi Group Provider")).toBeInTheDocument()
    await user.click(
      screen.getByRole("button", { name: /Multi Group Provider/ })
    )

    // 应该显示分组 1 和 分组 2
    expect(await screen.findByDisplayValue("standard")).toBeInTheDocument()
    expect(screen.getByDisplayValue("vip")).toBeInTheDocument()
    expect(screen.getByDisplayValue("sk-standard")).toBeInTheDocument()
    expect(screen.getByDisplayValue("sk-vip")).toBeInTheDocument()
    expect(screen.getByDisplayValue("gpt-4o-mini")).toBeInTheDocument()
    expect(screen.getByDisplayValue("gpt-4o")).toBeInTheDocument()

    // 每个分组拥有自己独立的获取按钮
    expect(
      screen.getAllByRole("button", { name: /Fetch Models/i })
    ).toHaveLength(2)
  })

  it("fetches models for specific key group using that group's key", async () => {
    mocks.fetchProviderModels.mockResolvedValue([
      { id: "custom-model-1", apis: [] },
    ])
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole("button", { name: /Multi Group Provider/ })
    )

    const fetchButtons = await screen.findAllByRole("button", {
      name: /Fetch Models/i,
    })
    // 点击第二个分组（vip）的 Fetch
    await user.click(fetchButtons[1])

    expect(mocks.fetchProviderModels).toHaveBeenCalledWith({
      protocol: "chat",
      apiUrl: "https://api.openai.com/v1",
      apiKey: "sk-vip",
    })
    expect(
      await screen.findByDisplayValue("custom-model-1")
    ).toBeInTheDocument()
  })

  it("shows a classified auth error instead of a generic fetch failure", async () => {
    const authError = new Error(
      JSON.stringify({
        code: "authentication_failed",
        message: "model list auth failed with HTTP 401 Unauthorized",
        i18n_key: "fetchError.auth",
        i18n_params: {
          status: "401",
          url: "https://api.openai.com/v1/models",
          providerMessage: "Incorrect API key provided",
        },
      })
    )
    mocks.fetchProviderModels.mockRejectedValue(authError)
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole("button", { name: /Multi Group Provider/ })
    )
    await user.click(
      (await screen.findAllByRole("button", { name: /Fetch Models/i }))[0]
    )

    expect(
      await screen.findByText(/Authentication failed \(HTTP 401\)/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/Incorrect API key provided/i)).toBeInTheDocument()
    expect(
      screen.queryByText("Failed to fetch model list.")
    ).not.toBeInTheDocument()
  })

  it("falls back to the Claude protocol URL when Chat listing fails", async () => {
    const dualProtocolProvider: ModelProviderInfo = {
      ...groupedProvider,
      discovery_json: JSON.stringify({
        endpoints: {
          chat: { apiUrl: "https://chat.example/v1" },
          claude: { apiUrl: "https://claude.example" },
        },
        keyGroups: groupedProvider.discovery_json
          ? JSON.parse(groupedProvider.discovery_json).keyGroups
          : [],
      }),
    }
    mocks.listModelProviders
      .mockReset()
      .mockResolvedValue([dualProtocolProvider])
    mocks.fetchProviderModels.mockReset()
    mocks.fetchProviderModels
      .mockRejectedValueOnce(
        new Error(
          JSON.stringify({
            code: "not_found",
            message: "missing",
            i18n_key: "fetchError.notFound",
            i18n_params: {
              status: "404",
              url: "https://chat.example/v1/models",
            },
          })
        )
      )
      .mockResolvedValueOnce([{ id: "claude-sonnet-4-5", apis: ["anthropic"] }])
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole("button", { name: /Multi Group Provider/ })
    )
    expect(
      await screen.findByDisplayValue("https://chat.example/v1")
    ).toBeInTheDocument()
    expect(
      screen.getByDisplayValue("https://claude.example")
    ).toBeInTheDocument()
    await user.click(
      (await screen.findAllByRole("button", { name: /Fetch Models/i }))[1]
    )

    expect(mocks.fetchProviderModels).toHaveBeenNthCalledWith(1, {
      protocol: "chat",
      apiUrl: "https://chat.example/v1",
      apiKey: "sk-vip",
    })
    expect(mocks.fetchProviderModels).toHaveBeenNthCalledWith(2, {
      protocol: "claude",
      apiUrl: "https://claude.example",
      apiKey: "sk-vip",
    })
    expect(
      await screen.findByDisplayValue("claude-sonnet-4-5")
    ).toBeInTheDocument()
    // 上游 supported_endpoint_types 预填到模型的接口：行尾摘要显示，展开后为已勾选
    const summary = screen.getByRole("button", {
      name: "API and context settings for claude-sonnet-4-5",
    })
    expect(summary).toHaveTextContent("Anthropic")
    await user.click(summary)
    expect(
      screen
        .getByRole("button", { name: "claude-sonnet-4-5 supports Anthropic" })
        .getAttribute("aria-pressed")
    ).toBe("true")
  })

  it("stops after an auth failure instead of trying the next protocol", async () => {
    mocks.listModelProviders.mockReset().mockResolvedValue([
      {
        ...groupedProvider,
        discovery_json: JSON.stringify({
          endpoints: {
            chat: { apiUrl: "https://chat.example/v1" },
            claude: { apiUrl: "https://claude.example" },
          },
          keyGroups: JSON.parse(groupedProvider.discovery_json!).keyGroups,
        }),
      },
    ])
    mocks.fetchProviderModels.mockReset().mockRejectedValue(
      new Error(
        JSON.stringify({
          code: "authentication_failed",
          message: "401",
          i18n_key: "fetchError.auth",
          i18n_params: { status: "401", url: "https://chat.example/v1/models" },
        })
      )
    )
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole("button", { name: /Multi Group Provider/ })
    )
    await user.click(
      (await screen.findAllByRole("button", { name: /Fetch Models/i }))[0]
    )

    expect(
      await screen.findByText(/Authentication failed \(HTTP 401\)/i)
    ).toBeInTheDocument()
    expect(mocks.fetchProviderModels).toHaveBeenCalledTimes(1)
  })

  it("saves aggregated models and preserves keyGroups in discoveryJson", async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole("button", { name: /Multi Group Provider/ })
    )
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(mocks.updateModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 3,
        apiKey: "sk-standard",
        discoveryJson: expect.stringContaining('"keyGroups"'),
      })
    )
    const saved = mocks.updateModelProvider.mock.lastCall?.[0]
    expect(JSON.parse(saved.discoveryJson)).not.toHaveProperty("groupKeys")
    // 不按 Agent 写白名单与逐 Agent 模型副本；空 overlays 清掉旧副本
    expect(saved).toMatchObject({
      agentType: "",
      agentAllowlist: [],
      overlays: [],
    })
  })

  it("saves provider default APIs and per-model limits", async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole("button", { name: /Multi Group Provider/ })
    )
    await user.click(
      await screen.findByRole("button", {
        name: "Models support Responses by default",
      })
    )
    const summary = screen.getByRole("button", {
      name: "API and context settings for gpt-4o",
    })
    expect(summary).toHaveTextContent("Default API")
    await user.click(summary)
    await user.type(screen.getByLabelText("Context window"), "200k")
    await user.type(screen.getByLabelText("Max output"), "32000")
    // 档位下拉只在有 Agent 声明 slots 时出现（这里 mock 了 opus / sonnet）
    expect(screen.getByRole("combobox", { name: /Slot/ })).toBeInTheDocument()
    expect(summary).toHaveTextContent("Default API · 200k · 32k")
    await user.click(screen.getByRole("button", { name: "Save" }))

    const saved = mocks.updateModelProvider.mock.lastCall?.[0]
    const discovery = JSON.parse(saved.discoveryJson)
    expect(discovery.defaultApis).toEqual(["openai-responses"])
    expect(discovery.keyGroups[1].models).toEqual([
      { id: "gpt-4o", contextWindow: 200000, maxOutput: 32000 },
    ])
    expect(JSON.parse(saved.model)).toContainEqual({
      id: "gpt-4o",
      contextWindow: 200000,
      maxOutput: 32000,
    })
  })

  it("keeps manual model settings when models are fetched again", async () => {
    mocks.fetchProviderModels.mockResolvedValue([
      { id: "gpt-4o", apis: [] },
      { id: "gpt-5", apis: ["openai-responses"] },
    ])
    mocks.listModelProviders.mockReset().mockResolvedValue([
      {
        ...groupedProvider,
        discovery_json: JSON.stringify({
          endpoints: { chat: { apiUrl: "https://api.openai.com/v1" } },
          keyGroups: [
            {
              id: "1",
              name: "only",
              key: "sk-only",
              models: [
                { id: "gpt-4o", apis: ["openai-chat"], contextWindow: 128000 },
              ],
            },
          ],
        }),
      },
    ])
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole("button", { name: /Multi Group Provider/ })
    )
    await user.click(
      await screen.findByRole("button", { name: /Fetch Models/i })
    )
    expect(await screen.findByDisplayValue("gpt-5")).toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: "API and context settings for gpt-4o",
      })
    ).toHaveTextContent("Chat · 128k")
  })

  it("keeps other endpoints and shows their proxy call address", async () => {
    mocks.listModelProviders.mockReset().mockResolvedValue([
      {
        ...groupedProvider,
        discovery_json: JSON.stringify({
          endpoints: {
            chat: { apiUrl: "https://api.openai.com/v1" },
            search: { apiUrl: "https://search.example" },
          },
          keyGroups: JSON.parse(groupedProvider.discovery_json!).keyGroups,
        }),
      },
    ])
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole("button", { name: /Multi Group Provider/ })
    )
    expect(await screen.findByDisplayValue("search")).toBeInTheDocument()
    expect(
      await screen.findByText("http://127.0.0.1:15723/p/3/search")
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Save" }))
    const saved = mocks.updateModelProvider.mock.lastCall?.[0]
    expect(JSON.parse(saved.discoveryJson).endpoints).toEqual({
      chat: { apiUrl: "https://api.openai.com/v1" },
      search: { apiUrl: "https://search.example" },
    })
  })

  it("stores the Berth proxy switch in discoveryJson", async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole("button", { name: /Multi Group Provider/ })
    )
    const toggle = screen.getByRole("switch", {
      name: "Launch through Berth proxy",
    })
    expect(toggle).not.toBeChecked()
    await user.click(toggle)
    await user.click(screen.getByRole("button", { name: "Save" }))
    const saved = mocks.updateModelProvider.mock.lastCall?.[0]
    expect(JSON.parse(saved.discoveryJson).viaProxy).toBe(true)

    await user.click(toggle)
    await user.click(screen.getByRole("button", { name: "Save" }))
    const cleared = mocks.updateModelProvider.mock.lastCall?.[0]
    expect(JSON.parse(cleared.discoveryJson)).not.toHaveProperty("viaProxy")
  })
})
