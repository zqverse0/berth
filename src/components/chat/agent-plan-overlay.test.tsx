import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { AgentPlanOverlay } from "./agent-plan-overlay"
import enMessages from "@/i18n/messages/en.json"
import type { PlanEntryInfo } from "@/lib/types"

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const sampleEntries: PlanEntryInfo[] = [
  { content: "First step", priority: "high", status: "completed" },
  { content: "Second step", priority: "medium", status: "in_progress" },
  { content: "Third step", priority: "low", status: "pending" },
]

describe("AgentPlanOverlay", () => {
  it("renders nothing when entries are empty or hidden", () => {
    expect(
      renderWithIntl(<AgentPlanOverlay entries={[]} planKey="p-empty" />)
        .container.firstChild
    ).toBeNull()
    expect(
      renderWithIntl(
        <AgentPlanOverlay
          entries={sampleEntries}
          planKey="p-hidden"
          visible={false}
        />
      ).container.firstChild
    ).toBeNull()
  })

  it("renders historical plan entries when expanded", () => {
    renderWithIntl(
      <AgentPlanOverlay entries={sampleEntries} planKey="p-1" defaultExpanded />
    )
    expect(screen.getByText("Agent Plan")).toBeInTheDocument()
    expect(screen.getByText("1/3")).toBeInTheDocument()
    expect(screen.getByText("First step")).toBeInTheDocument()
    expect(screen.getByText("Second step")).toBeInTheDocument()
    expect(screen.getByText("Third step")).toBeInTheDocument()
  })

  it("keeps completed plans collapsed and lets the user expand them", () => {
    const entries: PlanEntryInfo[] = [
      { content: "Done A", priority: "high", status: "completed" },
    ]
    renderWithIntl(
      <AgentPlanOverlay entries={entries} planKey="p-done" defaultExpanded />
    )
    expect(screen.getByText("Plan 1/1")).toBeInTheDocument()
    expect(screen.queryByText("Done A")).not.toBeInTheDocument()

    const toggle = screen.getByText("Plan 1/1").closest("button")
    expect(toggle).not.toBeNull()
    if (toggle) fireEvent.click(toggle)
    expect(screen.getByText("Done A")).toBeInTheDocument()
  })

  it("stays collapsed for an ordinary historical plan", () => {
    renderWithIntl(
      <AgentPlanOverlay entries={sampleEntries} planKey="p-open" />
    )
    expect(screen.getByText("Plan 1/3")).toBeInTheDocument()
    expect(screen.queryByText("First step")).not.toBeInTheDocument()
  })
})
