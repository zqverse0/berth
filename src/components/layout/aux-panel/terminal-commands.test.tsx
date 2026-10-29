import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { TerminalCommands } from "@/components/layout/aux-panel/terminal-commands"
import { useTabStore } from "@/stores/tab-store"
import { useTerminalRuntimeStore } from "@/stores/terminal-runtime-store"

const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  listFolderCommands: vi.fn(),
  quickMessagesList: vi.fn(),
  createFolderCommand: vi.fn(),
  updateFolderCommand: vi.fn(),
  deleteFolderCommand: vi.fn(),
  quickMessagesCreate: vi.fn(),
  quickMessagesUpdate: vi.fn(),
  quickMessagesDelete: vi.fn(),
}))

vi.mock("@/lib/terminal/create-and-open-primary-terminal", () => ({
  createAndOpenPrimaryTerminalDetailed: (...args: unknown[]) =>
    mocks.createTerminal(...args),
}))
vi.mock("@/lib/terminal/report-agent-launch-alert", () => ({
  reportAgentLaunchAlert: vi.fn(),
}))
vi.mock("@/lib/api", () => mocks)

function renderView() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <TerminalCommands folderId={1} folderPath="/workspace/project" />
    </NextIntlClientProvider>
  )
}

describe("TerminalCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createTerminal.mockResolvedValue({ terminalId: "term-new" })
    mocks.listFolderCommands.mockResolvedValue([
      { id: 101, folder_id: 1, name: "Dev Server", command: "npm run dev" },
    ])
    mocks.quickMessagesList.mockResolvedValue([
      { id: 202, title: "Git Status", content: "git status" },
    ])
    useTabStore.setState({ tabs: [], activeTabId: null })
  })

  it("lists project and global commands as rows", async () => {
    renderView()
    expect(await screen.findByText("Dev Server")).toBeDefined()
    expect(screen.getByText("npm run dev")).toBeDefined()
    expect(screen.getByText("Git Status")).toBeDefined()
  })

  it("runs a command in the active terminal on row click", async () => {
    const sendInput = vi.fn()
    useTerminalRuntimeStore.setState({ sendInput })
    useTabStore.setState({
      tabs: [
        {
          kind: "terminal",
          id: "terminal:t1",
          terminalId: "t1",
        } as never,
      ],
      activeTabId: "terminal:t1",
    })
    const user = userEvent.setup()
    renderView()
    await user.click(
      await screen.findByRole("button", { name: "Git Status git status" })
    )
    expect(sendInput).toHaveBeenCalledWith("t1", "git status\n")
    expect(mocks.createTerminal).not.toHaveBeenCalled()
  })

  it("opens a new terminal for the command when none is active", async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(
      await screen.findByRole("button", { name: "Dev Server npm run dev" })
    )
    await waitFor(() =>
      expect(mocks.createTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/workspace/project", folderId: 1 })
      )
    )
  })

  it("creates, edits and deletes commands inline", async () => {
    mocks.createFolderCommand.mockResolvedValue({})
    mocks.quickMessagesUpdate.mockResolvedValue({})
    mocks.deleteFolderCommand.mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderView()
    await screen.findByText("Dev Server")

    await user.click(
      screen.getByRole("button", { name: "New project command" })
    )
    await user.type(screen.getByPlaceholderText("Name this command"), "Test")
    await user.type(
      screen.getByPlaceholderText("Write the content to insert"),
      "pnpm test"
    )
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(mocks.createFolderCommand).toHaveBeenCalledWith(
      1,
      "Test",
      "pnpm test"
    )

    await user.click(screen.getByRole("button", { name: "Edit Git Status" }))
    const name = screen.getByDisplayValue("Git Status")
    await user.clear(name)
    await user.type(name, "Status")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(mocks.quickMessagesUpdate).toHaveBeenCalledWith({
      id: 202,
      title: "Status",
      content: "git status",
    })

    await user.click(
      await screen.findByRole("button", { name: "Delete Dev Server" })
    )
    expect(mocks.deleteFolderCommand).toHaveBeenCalledWith(101)
  })
})
