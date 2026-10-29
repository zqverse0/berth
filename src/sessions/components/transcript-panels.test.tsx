import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { DbConversationDetail } from "@/lib/types"
import { useTranscriptViewStore } from "@/sessions/transcript-view-store"
import { TranscriptOutline } from "./transcript-outline"
import { TranscriptToolbar } from "./transcript-toolbar"

const openFilePreview = vi.fn()
vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({ openFilePreview }),
}))

vi.mock("@/components/conversations/session-details-content", () => ({
  SessionDetailsContent: () => <div>details</div>,
}))

const detail = {
  summary: { id: 9, model: null },
  session_stats: null,
  context: [
    { source: "skills", tokens: 3, text: "abc" },
    {
      source: "instructions",
      name: "/w/AGENTS.md",
      path: "/w/AGENTS.md",
      tokens: 12,
      text: "rule one\nmore",
    },
  ],
  turns: [
    {
      id: "u1",
      role: "user",
      timestamp: "2026-09-29T00:00:00.000Z",
      blocks: [{ type: "text", text: "Why is CI slow?" }],
    },
    {
      id: "a1",
      role: "assistant",
      timestamp: "2026-09-29T00:00:01.000Z",
      blocks: [
        {
          type: "tool_use",
          tool_use_id: "c1",
          tool_name: "Bash",
          input_preview: "cat .agents/skills/diagnose/SKILL.md",
          meta: { "berth.skills": ["diagnose"] },
        },
        { type: "text", text: "Cache is cold." },
      ],
    },
    {
      id: "r1",
      role: "user",
      timestamp: "2026-09-29T00:00:02.000Z",
      blocks: [
        {
          type: "tool_result",
          tool_use_id: "c1",
          output_preview: "…",
          output_tokens: 2500,
          is_error: false,
        },
      ],
    },
  ],
} as unknown as DbConversationDetail

vi.mock("@/lib/api", () => ({
  getFolderConversation: () => Promise.resolve(detail),
}))

function renderWithIntl(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {node}
    </NextIntlClientProvider>
  )
}

describe("transcript toolbar and outline", () => {
  it("share view state and jump requests through the store", async () => {
    renderWithIntl(
      <>
        <TranscriptToolbar conversationId={9} />
        <TranscriptOutline conversationId={9} />
      </>
    )

    fireEvent.click(screen.getByRole("button", { name: "Prompts" }))
    expect(useTranscriptViewStore.getState().views[9].level).toBe("prompts")

    fireEvent.click(await screen.findByRole("button", { name: "diagnose 1" }))
    expect(useTranscriptViewStore.getState().views[9].filter.skill).toBe(
      "diagnose"
    )
    // 工具栏显示当前收窄条件，点击即清除
    fireEvent.click(screen.getByRole("button", { name: /Skill: diagnose/ }))
    expect(useTranscriptViewStore.getState().views[9].filter.skill).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /Why is CI slow/ }))
    expect(useTranscriptViewStore.getState().jump).toMatchObject({
      conversationId: 9,
      exchangeId: "u1",
    })
  })

  it("links the startup context line to the reader and shows tool result tokens", async () => {
    renderWithIntl(<TranscriptOutline conversationId={9} />)
    fireEvent.click(
      await screen.findByRole("button", { name: /Startup context.*2 items/ })
    )
    expect(useTranscriptViewStore.getState().jump).toMatchObject({
      conversationId: 9,
      exchangeId: "startup-context",
    })
    expect(
      screen.getByRole("button", { name: /^Bash 1 · ≈2.5K/ })
    ).toHaveAttribute("title", "results ≈2.5K tokens")
  })
})
