import { describe, expect, it, vi } from "vitest"

import {
  LAUNCHBAR_COMPONENTS,
  collectLaunchbarInputs,
  validateLaunchbarConfig,
} from "@/components/launchbar/registry"
import type {
  LaunchbarConfig,
  LaunchbarItem,
} from "@/components/launchbar/types"

describe("collectLaunchbarInputs", () => {
  it("passes through unknown static field ids without a host allowlist", () => {
    const items = [
      {
        id: "effort",
        component: "select" as const,
        label: "推理强度",
        options: [{ value: "high", label: "高" }],
      },
    ]
    expect(collectLaunchbarInputs(items, { effort: "high" })).toEqual({
      effort: "high",
    })
  })

  it("skips empty values and host-channel providerVendor", () => {
    const items = [
      {
        id: "provider",
        component: "select" as const,
        label: "服务商",
        optionsFrom: "providerVendor" as const,
      },
      {
        id: "model",
        component: "select" as const,
        label: "模型",
        optionsFrom: "providerModels" as const,
      },
      {
        id: "sandbox",
        component: "select" as const,
        label: "沙箱",
        options: [{ value: "read-only", label: "只读" }],
      },
    ]
    expect(
      collectLaunchbarInputs(items, {
        provider: "12",
        model: "",
        sandbox: "read-only",
      })
    ).toEqual({ sandbox: "read-only" })
  })

  it("coerces switch values to booleans", () => {
    const items = [
      {
        id: "continue",
        component: "switch" as const,
        label: "续接",
      },
    ]
    expect(collectLaunchbarInputs(items, { continue: "true" })).toEqual({
      continue: true,
    })
    expect(collectLaunchbarInputs(items, { continue: "false" })).toEqual({
      continue: false,
    })
  })
})

describe("validateLaunchbarConfig", () => {
  it("accepts optionsFrom selects without static options", () => {
    const config: LaunchbarConfig = {
      version: 1,
      items: [
        {
          id: "model",
          component: "select",
          label: "模型",
          optionsFrom: "providerModels",
          argvTemplate: ["-m", "{value}"],
        },
        {
          id: "session",
          component: "select",
          label: "会话",
          optionsFrom: "projectSessions",
        },
      ],
    }
    const { items, diagnostics } = validateLaunchbarConfig(config)
    expect(diagnostics).toEqual([])
    expect(items).toHaveLength(2)
  })

  it("still rejects static selects without options", () => {
    const config = {
      version: 1,
      items: [{ id: "sandbox", component: "select" as const, label: "沙箱" }],
    }
    const { diagnostics } = validateLaunchbarConfig(config)
    expect(diagnostics).toHaveLength(1)
  })

  it("rejects unknown optionsFrom and keeps known protocols", () => {
    const config: LaunchbarConfig = {
      version: 1,
      items: [
        // 外部 JSON 可能包含未知来源，保留运行时校验反例。
        {
          id: "broken",
          component: "select",
          label: "Bad",
          optionsFrom: "not-a-source",
        } as unknown as LaunchbarItem,
        {
          id: "provider",
          component: "select",
          label: "服务商",
          optionsFrom: "providerVendor",
          protocols: ["claude", "nope"],
        } as LaunchbarItem,
      ],
    }
    const { items, diagnostics } = validateLaunchbarConfig(config)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.itemId).toBe("broken")
    expect(items).toEqual([
      expect.objectContaining({
        id: "provider",
        protocols: ["claude"],
      }),
    ])
  })
})

describe("LAUNCHBAR_COMPONENTS.select", () => {
  it("renders trigger and allows selecting option from bottom popover menu", async () => {
    const { render, screen } = await import("@testing-library/react")
    const { default: userEvent } = await import("@testing-library/user-event")
    const { NextIntlClientProvider } = await import("next-intl")
    const en = (await import("@/i18n/messages/en.json")).default

    const handleChange = vi.fn()
    const item = {
      id: "effort",
      component: "select" as const,
      label: "Effort",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
    }

    const SelectComponent = LAUNCHBAR_COMPONENTS.select
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <SelectComponent item={item} value="medium" onChange={handleChange} />
      </NextIntlClientProvider>
    )

    const trigger = screen.getByRole("combobox", { name: "Effort" })
    expect(trigger).toHaveTextContent("Medium")

    const user = userEvent.setup()
    await user.click(trigger)

    const highOption = await screen.findByRole("option", { name: "High" })
    await user.click(highOption)

    expect(handleChange).toHaveBeenCalledWith("high")
  })

  it("renders search input when options count exceeds 5 and filters results", async () => {
    const { render, screen } = await import("@testing-library/react")
    const { default: userEvent } = await import("@testing-library/user-event")
    const { NextIntlClientProvider } = await import("next-intl")
    const en = (await import("@/i18n/messages/en.json")).default

    const handleChange = vi.fn()
    const item = {
      id: "model",
      component: "select" as const,
      label: "Model",
      options: [
        { value: "gpt-4o", label: "GPT-4o · openai/gpt-4o" },
        { value: "gpt-4o-mini", label: "GPT-4o Mini · openai/gpt-4o-mini" },
        {
          value: "claude-3-7-sonnet",
          label: "Claude 3.7 Sonnet · anthropic/claude-3-7-sonnet",
        },
        {
          value: "claude-3-5-haiku",
          label: "Claude 3.5 Haiku · anthropic/claude-3-5-haiku",
        },
        { value: "deepseek-r1", label: "DeepSeek R1 · deepseek/deepseek-r1" },
        { value: "deepseek-v3", label: "DeepSeek V3 · deepseek/deepseek-v3" },
      ],
    }

    const SelectComponent = LAUNCHBAR_COMPONENTS.select
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <SelectComponent item={item} value={null} onChange={handleChange} />
      </NextIntlClientProvider>
    )

    const trigger = screen.getByRole("combobox", { name: "Model" })
    // No value selected -> displays item.label as placeholder
    expect(trigger).toHaveTextContent("Model")

    const user = userEvent.setup()
    await user.click(trigger)

    const searchInput = await screen.findByPlaceholderText("Search options…")
    await user.type(searchInput, "sonnet")

    expect(
      screen.getByRole("option", { name: /Claude 3\.7 Sonnet/ })
    ).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /GPT-4o/ })).toBeNull()

    await user.click(screen.getByRole("option", { name: /Claude 3\.7 Sonnet/ }))
    expect(handleChange).toHaveBeenCalledWith("claude-3-7-sonnet")
  })

  it("exposes inspect on non-empty options when onInspect is provided", async () => {
    const { render, screen } = await import("@testing-library/react")
    const { default: userEvent } = await import("@testing-library/user-event")
    const { NextIntlClientProvider } = await import("next-intl")
    const en = (await import("@/i18n/messages/en.json")).default

    const handleChange = vi.fn()
    const handleInspect = vi.fn()
    const item = {
      id: "session",
      component: "select" as const,
      label: "Session",
      optionsFrom: "projectSessions" as const,
      options: [
        { value: "", label: "New session" },
        { value: "sess-1", label: "Yesterday" },
      ],
    }

    const SelectComponent = LAUNCHBAR_COMPONENTS.select
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <SelectComponent
          item={item}
          value={null}
          onChange={handleChange}
          onInspect={handleInspect}
        />
      </NextIntlClientProvider>
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole("combobox", { name: "Session" }))
    expect(
      screen.getByRole("option", { name: "New session" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "View" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "View" }))
    expect(handleChange).toHaveBeenCalledWith("sess-1")
    expect(handleInspect).toHaveBeenCalledWith("sess-1")
  })
})
