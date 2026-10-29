import { type ReactNode } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { ContextSource, MessageTurn } from "@/lib/types"
import { useTranscriptViewStore } from "@/sessions/transcript-view-store"
import { SessionAnalysisView } from "./session-analysis-view"

const openFilePreview = vi.fn()
vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({ openFilePreview }),
}))

vi.mock("virtua", () => ({
  Virtualizer: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))

let nextConversationId = 1

function renderView(turns: MessageTurn[], context?: ContextSource[]) {
  const conversationId = nextConversationId++
  const view = render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SessionAnalysisView
        conversationId={conversationId}
        detail={{ turns, context }}
      />
    </NextIntlClientProvider>
  )
  return { ...view, conversationId }
}

describe("SessionAnalysisView", () => {
  it("opens with the startup context: exact first-request total, estimated items and the unlisted rest", () => {
    renderView(
      [
        {
          id: "user-1",
          role: "user",
          timestamp: "2026-09-17T00:00:00.000Z",
          blocks: [{ type: "text", text: "Hello question" }],
        },
        {
          id: "assistant-1",
          role: "assistant",
          timestamp: "2026-09-17T00:00:01.000Z",
          blocks: [{ type: "text", text: "answer" }],
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 900,
          },
        },
      ],
      [
        { source: "skills", tokens: 300, text: "skill list" },
        {
          source: "instructions",
          name: "/w/AGENTS.md",
          path: "/w/AGENTS.md",
          tokens: 400,
          text: "rule one\nmore",
        },
      ]
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: /Startup context.*2 items · first request 1K tokens/,
      })
    )
    const rows = screen.getAllByRole("button", { expanded: false })
    expect(rows[0]).toHaveTextContent("/w/AGENTS.md")
    expect(rows[0]).toHaveTextContent("≈400")
    // 首次请求 1000 − 列出的 700 = 会话文件里没有的部分
    expect(
      screen.getByText(/Not in the session file/).parentElement
    ).toHaveTextContent("≈300")
    fireEvent.click(rows[0])
    expect(screen.getByText(/rule one/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Open /w/AGENTS.md" }))
    expect(openFilePreview).toHaveBeenCalledWith("/w/AGENTS.md")
  })

  it("renders user and assistant text from projected turns", () => {
    renderView([
      {
        id: "user-1",
        role: "user",
        timestamp: "2026-09-17T00:00:00.000Z",
        blocks: [{ type: "text", text: "Hello question" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        timestamp: "2026-09-17T00:00:01.000Z",
        blocks: [{ type: "text", text: "Here is the answer" }],
      },
    ])

    expect(screen.getByText("Hello question")).toBeInTheDocument()
    expect(screen.getByText("Here is the answer")).toBeInTheDocument()
    expect(screen.queryByText("source")).not.toBeInTheDocument()
  })

  it("does not render raw declaration fields as the transcript", () => {
    renderView([
      {
        id: "user-1",
        role: "user",
        timestamp: "2026-09-17T00:00:00.000Z",
        blocks: [{ type: "text", text: "visible body" }],
        fields: {
          source: {
            id: "evt-1",
            type: "message",
            sessionId: "session-1",
          },
        },
      },
    ])

    expect(screen.getByText("visible body")).toBeInTheDocument()
    expect(screen.queryByText("sessionId")).not.toBeInTheDocument()
    expect(screen.queryByText("evt-1")).not.toBeInTheDocument()
  })

  it("collapses process by default and hides answers in prompts mode", () => {
    const { conversationId } = renderView([
      {
        id: "user-1",
        role: "user",
        timestamp: "2026-09-17T00:00:00.000Z",
        blocks: [{ type: "text", text: "Fix the build" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        timestamp: "2026-09-17T00:00:01.000Z",
        blocks: [
          { type: "text", text: "Checking logs first" },
          {
            type: "tool_use",
            tool_use_id: "call-1",
            tool_name: "Bash",
            input_preview: null,
          },
        ],
      },
      {
        id: "assistant-2",
        role: "assistant",
        timestamp: "2026-09-17T00:00:02.000Z",
        blocks: [{ type: "text", text: "Build fixed" }],
      },
    ])

    expect(screen.getByText("Build fixed")).toBeInTheDocument()
    expect(screen.queryByText("Checking logs first")).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole("button", { name: "Process: 1 tool call" })
    )
    expect(screen.getByText("Checking logs first")).toBeInTheDocument()

    act(() =>
      useTranscriptViewStore
        .getState()
        .updateView(conversationId, (view) => ({ ...view, level: "prompts" }))
    )
    expect(screen.queryByText("Build fixed")).not.toBeInTheDocument()
    expect(screen.getByText("Fix the build")).toBeInTheDocument()
  })

  it("skips turns that have no readable content", () => {
    renderView([
      {
        id: "meta-1",
        role: "system",
        timestamp: "2026-09-17T00:00:00.000Z",
        blocks: [],
        fields: { source: { id: "only-meta" } },
      },
    ])

    expect(screen.getByText(/no messages/i)).toBeInTheDocument()
    expect(screen.queryByText("only-meta")).not.toBeInTheDocument()
  })
})
