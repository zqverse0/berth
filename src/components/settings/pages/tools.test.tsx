import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import en from "@/i18n/messages/en.json"
import { useStatusBarLaunchStore } from "@/stores/agent-launch-store"
import { useToolsSettingsStore } from "@/stores/tools-settings-store"
import { ToolsSettingsPage } from "./tools"

const toolAssets = vi.fn()

vi.mock("@/lib/transport/tool-assets", () => ({
  toolAssets: (...args: unknown[]) => toolAssets(...args),
}))

const getPreviewToolStatus = vi.fn()
const installPreviewTool = vi.fn()
const checkToolUpdate = vi.fn()

vi.mock("@/lib/api", () => ({
  getPreviewToolStatus: (...args: unknown[]) => getPreviewToolStatus(...args),
  installPreviewTool: (...args: unknown[]) => installPreviewTool(...args),
  checkToolUpdate: (...args: unknown[]) => checkToolUpdate(...args),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ subscribe: () => Promise.resolve(() => undefined) }),
}))

const saveFileDialog = vi.fn()

vi.mock("@/lib/platform", () => ({
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
  saveFileDialog: (...args: unknown[]) => saveFileDialog(...args),
}))

vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div>{children}</div>
  ),
}))

describe("ToolsSettingsPage", () => {
  beforeEach(() => {
    // SettingsSplit 用 matchMedia 判断窄屏；jsdom 没有这个 API。
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })
    useToolsSettingsStore.setState({
      selectedToolId: null,
      programs: {},
      updateChecks: {},
    })
    useStatusBarLaunchStore.setState({ activeLaunchAgentId: null })
    checkToolUpdate.mockReset().mockResolvedValue(null)
    installPreviewTool.mockReset()
    toolAssets.mockReset()
    toolAssets.mockImplementation(
      (request: { type: string; enabled?: boolean }) => {
        if (request.type === "pack") return Promise.resolve({ type: "packed" })
        if (
          request.type === "list" ||
          request.type === "set_enabled" ||
          request.type === "remove"
        ) {
          return Promise.resolve({
            type: "list",
            directory: "/home/user/.berth/tools",
            tools: [
              {
                id: "codex",
                name: "Codex CLI",
                description: "Coding agent",
                protocol: "berth.tool/1",
                contributes: ["launchbar", "agent"],
                enabled: request.enabled ?? true,
                diagnostics: [],
              },
            ],
          })
        }
        return Promise.resolve({
          type: "detail",
          detail: {
            summary: {
              id: "codex",
              name: "Codex CLI",
              description: "Coding agent",
              version: "1.0.0",
              protocol: "berth.tool/1",
              contributes: ["launchbar", "agent"],
              enabled: true,
              diagnostics: [],
            },
            directory: "/home/user/.berth/tools/codex",
            usage: "# Usage\nRun Codex from the launch bar",
            raw: {
              extensions: { "org.berth.agent": { projectType: "codex" } },
              configuration: { model: {} },
              resources: {},
              evidence: {},
              knowledge: {},
              views: {},
            },
          },
        })
      }
    )
  })

  it("groups agents and opens an agent's launch bar from its card", async () => {
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ToolsSettingsPage />
      </NextIntlClientProvider>
    )

    await user.click(
      await screen.findByRole("button", { name: "Open launch bar" })
    )
    expect(useStatusBarLaunchStore.getState().activeLaunchAgentId).toBe("codex")
    expect(screen.getByText("Agents")).toBeInTheDocument()
    expect(screen.getByText("/home/user/.berth/tools")).toBeInTheDocument()
    expect(screen.getByText("2 capabilities")).toBeInTheDocument()
    await user.click(screen.getByRole("tab", { name: "For agents" }))
    expect(
      await screen.findByText(/Run Codex from the launch bar/)
    ).toBeInTheDocument()
  })

  it("packs a plugin into a zip named after its id and version", async () => {
    const user = userEvent.setup()
    saveFileDialog.mockResolvedValue("/tmp/codex-1.0.0.zip")
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ToolsSettingsPage />
      </NextIntlClientProvider>
    )

    expect(await screen.findByText("v1.0.0")).toBeInTheDocument()
    await user.click(screen.getByRole("tab", { name: "Develop" }))
    await user.click(await screen.findByRole("button", { name: "Pack" }))
    expect(saveFileDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "codex-1.0.0.zip" })
    )
    expect(toolAssets).toHaveBeenCalledWith({
      type: "pack",
      id: "codex",
      path: "/tmp/codex-1.0.0.zip",
    })
  })

  it("disables a plugin and marks it in the list", async () => {
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ToolsSettingsPage />
      </NextIntlClientProvider>
    )

    await user.click(await screen.findByRole("switch"))
    expect(toolAssets).toHaveBeenCalledWith({
      type: "set_enabled",
      id: "codex",
      enabled: false,
    })
    expect(await screen.findByText("Disabled")).toBeInTheDocument()
    expect(screen.getByRole("switch")).toHaveAttribute(
      "data-state",
      "unchecked"
    )
  })

  it("shows a missing program and installs it by tool id", async () => {
    const officecli = {
      id: "officecli",
      name: "OfficeCLI",
      protocol: "berth.tool/1",
      contributes: ["preview", "install"],
      enabled: true,
      diagnostics: [],
    }
    toolAssets.mockImplementation((request: { type: string }) =>
      Promise.resolve(
        request.type === "list"
          ? { type: "list", directory: "/t", tools: [officecli] }
          : {
              type: "detail",
              detail: {
                summary: officecli,
                directory: "/t/officecli",
                raw: {
                  extensions: {
                    "org.berth.preview": { extensions: ["docx", "pptx"] },
                  },
                },
              },
            }
      )
    )
    getPreviewToolStatus.mockResolvedValue({
      installed: false,
      version: null,
      path: null,
      runtimeError: null,
      installScript: true,
      canUpdate: false,
    })
    installPreviewTool.mockResolvedValue({
      installed: true,
      version: "1.0.152",
      path: "/home/user/.local/bin/officecli",
      runtimeError: null,
      installScript: true,
      canUpdate: true,
    })
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ToolsSettingsPage />
      </NextIntlClientProvider>
    )

    expect(
      await screen.findByText("Previews .docx / .pptx files in Berth")
    ).toBeInTheDocument()
    expect(await screen.findByText("Not installed")).toBeInTheDocument()
    await user.click(await screen.findByRole("button", { name: "Install" }))
    expect(installPreviewTool).toHaveBeenCalledWith(
      expect.any(String),
      "",
      "officecli",
      false
    )
    expect(
      await screen.findByText("1.0.152 installed and working")
    ).toBeInTheDocument()
  })

  it("shows a newer release and updates through the plugin", async () => {
    const claude = {
      id: "claude",
      name: "Claude Code",
      protocol: "berth.tool/1",
      contributes: ["install"],
      enabled: true,
      diagnostics: [],
    }
    toolAssets.mockImplementation((request: { type: string }) =>
      Promise.resolve(
        request.type === "list"
          ? { type: "list", directory: "/t", tools: [claude] }
          : {
              type: "detail",
              detail: { summary: claude, directory: "/t/claude", raw: {} },
            }
      )
    )
    const installed = (version: string) => ({
      installed: true,
      version,
      path: "/bin/claude",
      runtimeError: null,
      installScript: false,
      canUpdate: true,
    })
    getPreviewToolStatus.mockResolvedValue(installed("2.1.284 (Claude Code)"))
    checkToolUpdate
      .mockResolvedValueOnce({ latest: "2.1.288", updateAvailable: true })
      .mockResolvedValueOnce({ latest: "2.1.288", updateAvailable: false })
    installPreviewTool.mockResolvedValue(installed("2.1.288 (Claude Code)"))
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ToolsSettingsPage />
      </NextIntlClientProvider>
    )

    expect(await screen.findByText("2.1.288 available")).toBeInTheDocument()
    expect(screen.getByText("Update to 2.1.288")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Update" }))
    expect(installPreviewTool).toHaveBeenCalledWith(
      expect.any(String),
      "",
      "claude",
      true
    )
    expect(await screen.findByText("Up to date")).toBeInTheDocument()
    expect(checkToolUpdate).toHaveBeenCalledTimes(2)
  })

  it("opens the plugin repository when nothing is installed and installs from it", async () => {
    const pi = {
      id: "pi",
      name: "Pi",
      contributes: ["agent"],
      enabled: true,
      diagnostics: [],
    }
    let tools: unknown[] = []
    toolAssets.mockImplementation((request: { type: string }) => {
      if (request.type === "catalog") {
        return Promise.resolve({
          type: "catalog",
          repository: "https://github.com/zqverse0/berth-plugins",
          plugins: [
            {
              source: "https://github.com/zqverse0/berth-plugins#pi",
              id: "pi",
              name: "Pi",
              description: "Pi coding agent",
              version: "1.0.0",
              icon: "data:image/svg+xml;base64,PHN2Zy8+",
              installed: false,
            },
          ],
        })
      }
      if (request.type === "install") tools = [pi]
      if (request.type === "detail" || request.type === "load") {
        return Promise.resolve({
          type: "detail",
          detail: { summary: pi, directory: "/t/pi", raw: {} },
        })
      }
      return Promise.resolve({ type: "list", directory: "/t", tools })
    })
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ToolsSettingsPage />
      </NextIntlClientProvider>
    )

    expect(await screen.findByText("Pi coding agent")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Install" }))
    expect(toolAssets).toHaveBeenCalledWith({
      type: "install",
      source: "https://github.com/zqverse0/berth-plugins#pi",
    })
    expect(
      await screen.findByRole("button", { name: "Installed" })
    ).toBeInTheDocument()
  })

  it("removes a plugin only after confirming", async () => {
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ToolsSettingsPage />
      </NextIntlClientProvider>
    )

    await user.click(await screen.findByRole("tab", { name: "Develop" }))
    await user.click(await screen.findByRole("button", { name: "Remove" }))
    expect(toolAssets).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "remove" })
    )
    expect(screen.getByText("Remove Codex CLI?")).toBeInTheDocument()
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Remove",
      })
    )
    expect(toolAssets).toHaveBeenCalledWith({ type: "remove", id: "codex" })
  })
})
