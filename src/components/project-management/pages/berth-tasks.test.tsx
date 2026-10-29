import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock(
  "@/components/project-management/berth-tasks/berth-tasks-console",
  () => ({
    BerthTasksConsole: () => <div>dev-task-surface</div>,
  })
)

import { BerthTasksPage } from "./berth-tasks"

describe("BerthTasksPage", () => {
  it("shows the project tasks; schedules live on each task", () => {
    render(
      <BerthTasksPage
        folderId={7}
        folderPath="/repo"
        visible
        active
        selectedAgent="claude_code"
        onSelectAgent={vi.fn()}
      />
    )
    expect(screen.getByText("dev-task-surface")).toBeTruthy()
  })
})
