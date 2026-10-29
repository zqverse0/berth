import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { useLaunchbar } from "@/components/launchbar/use-launchbar"
import {
  AgentLaunchForm,
  AgentLaunchHeader,
  AgentLaunchMenu,
} from "@/components/layout/sidebar/agent-launch"
import { useStatusBarLaunchStore } from "@/stores/agent-launch-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useToolsSettingsStore } from "@/stores/tools-settings-store"

const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  createFolderTerminal: vi.fn(),
  loadLaunchbar: vi.fn(),
  listModelProviders: vi.fn(),
  listLoginCards: vi.fn(),
  reportAgentLaunchAlert: vi.fn(),
  getAgentProviderBinding: vi.fn(),
  setAgentProviderBinding: vi.fn(),
  resolveProjectAgentSession: vi.fn(),
  openTranscriptTab: vi.fn(),
  getPreviewToolStatus: vi.fn(),
  checkToolUpdate: vi.fn(),
  installPreviewTool: vi.fn(),
  sessionItems: [] as Array<{
    externalId: string
    title: string | null
    updatedAt: string
  }>,
}))

vi.mock("@/lib/terminal/create-and-open-primary-terminal", () => ({
  createAndOpenPrimaryTerminalDetailed: (...args: unknown[]) =>
    mocks.createTerminal(...args),
  createAndOpenFolderTerminal: (...args: unknown[]) =>
    mocks.createFolderTerminal(...args),
}))

vi.mock("@/lib/terminal/report-agent-launch-alert", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/terminal/report-agent-launch-alert")
    >()
  return {
    ...actual,
    reportAgentLaunchAlert: mocks.reportAgentLaunchAlert,
  }
})

vi.mock("@/lib/transport/launchbar", () => ({
  launchbar: (request: unknown) => mocks.loadLaunchbar(request),
}))

vi.mock("@/lib/api", () => ({
  listModelProviders: (...args: unknown[]) => mocks.listModelProviders(...args),
  resolveProjectAgentSession: (...args: unknown[]) =>
    mocks.resolveProjectAgentSession(...args),
  getPreviewToolStatus: (...args: unknown[]) =>
    mocks.getPreviewToolStatus(...args),
  checkToolUpdate: (...args: unknown[]) => mocks.checkToolUpdate(...args),
  installPreviewTool: (...args: unknown[]) => mocks.installPreviewTool(...args),
}))

vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  getTransport: () => ({ subscribe: () => Promise.resolve(() => undefined) }),
}))

vi.mock("@/sessions/project/use-project-agent-sessions", () => ({
  useProjectAgentSessions: () => ({
    items: mocks.sessionItems,
    loading: false,
    loadingMore: false,
    error: null,
    sourceWarning: null,
    scanComplete: true,
    hasMore: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    resolve: vi.fn(),
  }),
}))

vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({
    openTranscriptTab: mocks.openTranscriptTab,
  }),
}))

vi.mock("@/lib/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/model-provider")>()
  return {
    ...actual,
    listLoginCards: mocks.listLoginCards,
    getAgentProviderBinding: () => mocks.getAgentProviderBinding(),
    setAgentProviderBinding: (...args: unknown[]) =>
      mocks.setAgentProviderBinding(...args),
  }
})

const demoProfile = {
  id: "claude",
  name: "Claude Code",
  icon: null,
  description: null,
  projectType: "claude",
}

function installed(version: string | null) {
  return {
    installed: true,
    version,
    path: "/bin/claude",
    runtimeError: null,
    installScript: false,
    canUpdate: true,
  }
}

function renderShelf(
  props?: Partial<React.ComponentProps<typeof AgentLaunchForm>>
) {
  const defaultProps: React.ComponentProps<typeof AgentLaunchForm> = {
    agentId: "claude",
    workingDirectory: "/test/project",
    folderId: 42,
    onClose: vi.fn(),
    ...props,
  }
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AgentLaunchForm {...defaultProps} />
    </NextIntlClientProvider>
  )
}

describe("AgentLaunchForm", () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.createTerminal.mockReset().mockResolvedValue({ terminalId: "term-1" })
    mocks.loadLaunchbar
      .mockReset()
      .mockImplementation((request: { type: string }) =>
        Promise.resolve(
          request.type === "list_agents"
            ? { type: "agents", agents: [demoProfile], directory: "/tools" }
            : {
                type: "file",
                file: {
                  agent: "claude",
                  config: {
                    version: 1,
                    items: [
                      {
                        id: "verbose",
                        component: "switch",
                        label: "Verbose",
                        defaultValue: "false",
                      },
                    ],
                  },
                  diagnostics: [],
                },
              }
        )
      )
    mocks.listModelProviders.mockReset().mockResolvedValue([])
    mocks.listLoginCards.mockReset().mockResolvedValue([])
    mocks.reportAgentLaunchAlert.mockReset()
    mocks.getAgentProviderBinding.mockResolvedValue(null)
    mocks.resolveProjectAgentSession.mockReset()
    mocks.openTranscriptTab.mockReset()
    mocks.sessionItems.length = 0
    useToolsSettingsStore.setState({
      programs: {},
      updateChecks: {},
      installs: {},
    })
    mocks.getPreviewToolStatus.mockReset().mockResolvedValue(null)
    mocks.checkToolUpdate.mockReset().mockResolvedValue(null)
    mocks.installPreviewTool.mockReset()
  })

  it("loads the catalog without keys and keeps login cards when providers fail", async () => {
    mocks.loadLaunchbar.mockImplementation((request: { type: string }) =>
      Promise.resolve(
        request.type === "list_agents"
          ? { type: "agents", agents: [demoProfile], directory: "/tools" }
          : {
              type: "file",
              file: {
                agent: "claude",
                config: {
                  version: 1,
                  items: [
                    {
                      id: "provider",
                      component: "select",
                      label: "Provider",
                      optionsFrom: "providerVendor",
                      protocols: ["claude"],
                    },
                  ],
                },
                diagnostics: [],
              },
            }
      )
    )
    mocks.listModelProviders.mockRejectedValue(
      new Error("database unavailable")
    )
    mocks.listLoginCards.mockResolvedValue([
      {
        agentId: "claude",
        agentName: "Claude Code",
        loginId: "official",
        label: "Official login",
        hasUsage: false,
        hasModels: false,
      },
    ])
    const { result } = renderHook(
      () =>
        useLaunchbar({
          agentId: "claude",
          workingDirectory: "/test/project",
          folderId: 42,
        }),
      {
        wrapper: ({ children }) => (
          <NextIntlClientProvider locale="en" messages={en}>
            {children}
          </NextIntlClientProvider>
        ),
      }
    )
    await waitFor(() => expect(result.current.binding.loginId).toBe("official"))
    expect(mocks.listModelProviders).toHaveBeenCalledWith(false)
    expect(result.current.providers).toEqual([])
    expect(mocks.reportAgentLaunchAlert).toHaveBeenCalledWith(
      "Failed to load providers.",
      "database unavailable"
    )
  })

  it("stays quiet when the agent's program is installed and current", async () => {
    mocks.getPreviewToolStatus.mockResolvedValue(installed("2.1.288"))
    mocks.checkToolUpdate.mockResolvedValue({
      latest: "2.1.288",
      updateAvailable: false,
    })
    renderShelf()

    await screen.findByRole("button", { name: /^Start / })
    await waitFor(() => expect(mocks.checkToolUpdate).toHaveBeenCalled())
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("warns about a missing program above the form", async () => {
    mocks.getPreviewToolStatus.mockResolvedValue({
      ...installed(null),
      installed: false,
      path: null,
    })
    renderShelf()

    expect(await screen.findByText(/program was not found/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Details" })).toBeInTheDocument()
  })

  it("offers an update and runs it through the plugin", async () => {
    const user = userEvent.setup()
    mocks.getPreviewToolStatus.mockResolvedValue(installed("2.1.284"))
    mocks.checkToolUpdate.mockResolvedValue({
      latest: "2.1.288",
      updateAvailable: true,
    })
    mocks.installPreviewTool.mockResolvedValue(installed("2.1.288"))
    renderShelf()

    expect(await screen.findByText("2.1.288 available")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Update" }))
    expect(mocks.installPreviewTool).toHaveBeenCalledWith(
      expect.any(String),
      "",
      "claude",
      true
    )
  })

  it("leaves the agent identity to the sidebar header", async () => {
    renderShelf()

    await screen.findByRole("button", { name: /^Start / })
    expect(screen.queryByText("Claude Code")).toBeNull()
    expect(screen.queryByText("test-project")).toBeNull()
  })

  it("shows a compact usage summary in the header without refresh or plan", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <AgentLaunchHeader
          agentId="claude"
          name="Claude Code"
          onBack={vi.fn()}
          usageState={{
            subject: "claude",
            status: "ready",
            planType: "Pro",
            windows: [
              {
                id: "session",
                label: "5h",
                usedPercent: 42,
                resetsAt: Date.now() + 3_600_000,
              },
              {
                id: "weekly",
                label: "7d",
                usedPercent: 71,
                remaining: 15,
                unit: "tokens",
              },
            ],
            diagnostics: [],
          }}
        />
      </NextIntlClientProvider>
    )

    expect(screen.getByText("Claude Code")).toBeDefined()
    expect(screen.queryByText("Pro")).toBeNull()
    expect(screen.getByText("5h")).toBeDefined()
    expect(screen.getByText("42%")).toBeDefined()
    expect(screen.getByText("7d")).toBeDefined()
    expect(screen.getByText("71%")).toBeDefined()
    expect(screen.queryByTitle("Refresh")).toBeNull()
  })

  it("goes back to the agent list from the header", async () => {
    const onBack = vi.fn()
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <AgentLaunchHeader agentId="claude" name="Claude" onBack={onBack} />
      </NextIntlClientProvider>
    )
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Choose another agent" }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it("does not render usage error diagnostics in the launch shelf", async () => {
    renderShelf()

    await screen.findByRole("button", { name: /^Start / })
    expect(screen.queryByText("Usage request failed")).toBeNull()
    expect(screen.queryByText("Token expired")).toBeNull()
  })

  it("launches the CLI with inputs and closes the shelf", async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderShelf({ onClose })

    const launchButton = await screen.findByRole("button", { name: /^Start / })
    await user.click(launchButton)

    await waitFor(() => {
      expect(mocks.createTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/test/project",
          folderId: 42,
          agentContractId: "claude",
        })
      )
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it("does not render the terminal button inside the launch shelf", async () => {
    renderShelf()

    expect(screen.queryByRole("button", { name: "New Terminal" })).toBeNull()
  })

  it("launches the CLI when pressing Enter key", async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderShelf({ onClose })

    await screen.findByRole("button", { name: /^Start / })
    await user.keyboard("{Enter}")

    await waitFor(() => {
      expect(mocks.createTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/test/project",
          folderId: 42,
          agentContractId: "claude",
        })
      )
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it("renders launchbar diagnostics with role='alert'", async () => {
    mocks.loadLaunchbar.mockImplementation((request: { type: string }) =>
      Promise.resolve(
        request.type === "list_agents"
          ? { type: "agents", agents: [demoProfile], directory: "/tools" }
          : {
              type: "file",
              file: {
                agent: "claude",
                config: null,
                diagnostics: [
                  {
                    severity: "error",
                    message: "Missing required API credentials",
                  },
                ],
              },
            }
      )
    )

    renderShelf()

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Missing required API credentials")
  })
})

describe("AgentLaunchMenu", () => {
  beforeEach(() => {
    mocks.loadLaunchbar.mockImplementation((request: { type: string }) =>
      Promise.resolve(
        request.type === "list_agents"
          ? { type: "agents", agents: [demoProfile], directory: "/tools" }
          : {
              type: "file",
              file: { agent: "claude", config: null, diagnostics: [] },
            }
      )
    )
    useStatusBarLaunchStore.getState().closeLaunchShelf()
  })

  const renderMenu = () =>
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <AgentLaunchMenu />
      </NextIntlClientProvider>
    )

  it("picks an agent from the + menu, then shows its launch form", async () => {
    const user = userEvent.setup()
    renderMenu()

    await user.click(screen.getByRole("button", { name: "Launch agent" }))
    await user.click(
      await screen.findByRole("menuitem", { name: "Claude Code" })
    )

    expect(useStatusBarLaunchStore.getState().activeLaunchAgentId).toBe(
      "claude"
    )
    await screen.findByRole("button", { name: /^Start / })
    await user.click(
      screen.getByRole("button", { name: "Choose another agent" })
    )
    expect(
      await screen.findByRole("menuitem", { name: "Claude Code" })
    ).toBeDefined()
  })

  it("opens straight to the form when an entry point names the agent", async () => {
    renderMenu()
    act(() => {
      useStatusBarLaunchStore
        .getState()
        .openLaunchShelf("claude", { expert: "reviewer" })
    })

    await screen.findByRole("button", { name: /^Start / })
    expect(screen.queryByRole("menuitem")).toBeNull()
  })

  it("opens a plain terminal in the active project from the + menu", async () => {
    useAppWorkspaceStore.setState({
      activeFolderId: 7,
      allFolders: [{ id: 7, path: "/work/app" }],
    } as never)
    const user = userEvent.setup()
    renderMenu()

    await user.click(screen.getByRole("button", { name: "Launch agent" }))
    await user.click(
      await screen.findByRole("menuitem", { name: "New Terminal" })
    )

    expect(mocks.createFolderTerminal).toHaveBeenCalledWith(
      { cwd: "/work/app", folderId: 7 },
      expect.any(Function)
    )
    expect(useStatusBarLaunchStore.getState().launchOpen).toBe(false)
  })
})
