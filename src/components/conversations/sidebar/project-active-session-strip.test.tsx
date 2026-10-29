import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import {
  DetachedTerminalStrip,
  ProjectActiveSessionStrip,
} from "./project-active-session-strip"
import { useTabStore } from "@/stores/tab-store"
import { useAppUiStore } from "@/stores/app-ui-store"

vi.mock("@/components/agent-icon", () => ({
  AgentIcon: ({ agentType }: { agentType: string }) => (
    <div data-testid={`agent-icon-${agentType}`} />
  ),
}))

vi.mock("@/components/layout/status-bar/status-bar-terminal", () => ({
  ColorTerminalIcon: () => <div data-testid="color-terminal-icon" />,
}))

describe("ProjectActiveSessionStrip", () => {
  beforeEach(() => {
    useTabStore.setState({
      rawTabs: [],
      activeTabId: null,
    })
  })

  it("renders null when there are no active sessions for the folder", () => {
    const { container } = render(
      <ProjectActiveSessionStrip folderId={1} indent="0" />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders agent icon for conversation tab and terminal icon for terminal tab", () => {
    useTabStore.setState({
      rawTabs: [
        {
          id: "tab-conv-1",
          kind: "conversation",
          folderId: 1,
          conversationId: 1,
          agentType: "claude_code",
          title: "Claude Task",
          isPinned: false,
        },
        {
          id: "tab-term-1",
          kind: "terminal",
          folderId: 1,
          terminalId: "term-1",
          backendInstanceId: "backend-1",
          initialCwd: "/path",
          shell: "/bin/bash",
          detachedFolderLabel: null,
          detachedFolderPath: null,
          title: "Build Shell",
          isPinned: false,
        },
      ],
      activeTabId: "tab-conv-1",
    })

    render(<ProjectActiveSessionStrip folderId={1} indent="0" />)

    expect(screen.getByTestId("agent-icon-claude_code")).toBeDefined()
    expect(screen.getByTestId("color-terminal-icon")).toBeDefined()

    const claudeButton = screen.getByLabelText("Claude Task")
    expect(claudeButton).toBeDefined()
    expect(claudeButton.className).toContain("border-primary/50")

    const terminalButton = screen.getByLabelText("Build Shell")
    expect(terminalButton).toBeDefined()
    expect(terminalButton.className).not.toContain("border-primary/50")
  })

  it("switches tab when clicked", () => {
    useAppUiStore.setState({ auxView: "group" })
    const switchTabSpy = vi.spyOn(useTabStore.getState(), "switchTab")

    useTabStore.setState({
      rawTabs: [
        {
          id: "tab-conv-1",
          kind: "conversation",
          folderId: 1,
          conversationId: 1,
          agentType: "codex",
          title: "Codex Refactor",
          isPinned: false,
        },
      ],
      activeTabId: null,
    })

    render(<ProjectActiveSessionStrip folderId={1} indent="0" />)

    const button = screen.getByLabelText("Codex Refactor")
    fireEvent.click(button)

    expect(switchTabSpy).toHaveBeenCalledWith("tab-conv-1")
    // 点 Agent 图标看的是终端，不是项目群组页
    expect(useAppUiStore.getState().auxView).toBe("terminals")
  })
})

describe("DetachedTerminalStrip", () => {
  it("renders one button per entry and reports selection", () => {
    const onSelect = vi.fn()

    render(
      <DetachedTerminalStrip
        ariaLabel="Detached terminals"
        entries={[
          {
            id: "terminal:cli-agent",
            title: "Pi · demo",
            agentType: "pi",
            active: false,
            onSelect,
          },
          {
            id: "terminal:stale",
            title: "bash · gone-project",
            agentType: null,
            active: true,
            onSelect: vi.fn(),
          },
        ]}
      />
    )

    expect(screen.getByTestId("agent-icon-pi")).toBeDefined()
    expect(screen.getByTestId("color-terminal-icon")).toBeDefined()

    const detached = screen.getByLabelText("Pi · demo")
    expect(detached.className).not.toContain("border-primary/50")
    expect(screen.getByLabelText("bash · gone-project").className).toContain(
      "border-primary/50"
    )

    fireEvent.click(detached)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it("renders nothing without entries", () => {
    const { container } = render(<DetachedTerminalStrip entries={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
