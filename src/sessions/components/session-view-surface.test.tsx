import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { DbConversationDetail } from "@/lib/types"

vi.mock("@/sessions/components/session-analysis-view", () => ({
  SessionAnalysisView: () => <div>Session transcript</div>,
}))

import { SessionViewSurface } from "./session-view-surface"

const detail: Pick<DbConversationDetail, "turns"> = {
  turns: [
    {
      id: "user-1",
      role: "user",
      timestamp: "2026-09-17T00:00:00.000Z",
      blocks: [{ type: "text", text: "Question" }],
    },
  ],
}

function renderSurface() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SessionViewSurface
        conversationId={7}
        detail={detail}
        isActive
        detailLoading={false}
        detailError={null}
        hasPersistedConversation
      />
    </NextIntlClientProvider>
  )
}

describe("SessionViewSurface", () => {
  it("renders persisted turns instead of the live empty transcript", async () => {
    renderSurface()

    expect(await screen.findByText("Session transcript")).toBeTruthy()
    expect(screen.queryByText(/no messages/i)).not.toBeInTheDocument()
  })
})
