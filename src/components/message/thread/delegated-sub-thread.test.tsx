import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { DelegatedSubThread } from "./delegated-sub-thread"
import enMessages from "@/i18n/messages/en.json"

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("DelegatedSubThread", () => {
  it("renders nothing when the transcript has no delegation details", () => {
    const { container } = renderWithIntl(
      <DelegatedSubThread parentToolUseId="pt-1" />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders a static agent/task record from tool input", () => {
    const input = JSON.stringify({
      agent_type: "codex",
      task: "summarize the failing tests",
    })
    renderWithIntl(<DelegatedSubThread parentToolUseId="pt-1" input={input} />)

    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0)
    expect(screen.getByText("summarize the failing tests")).toBeInTheDocument()
    expect(screen.getByText("starting")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("renders persisted broker metadata without live-session controls", () => {
    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="pt-1"
        input="{}"
        meta={{
          "berth.delegation": {
            status: "completed",
            child_conversation_id: 321,
            task_preview: "执行 pnpm build",
            task_id: "task-uuid-9",
          },
        }}
      />
    )

    expect(screen.getByText("执行 pnpm build")).toBeInTheDocument()
    expect(screen.getByText("#task-uui")).toBeInTheDocument()
    expect(screen.getByText("done")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("keeps an async acknowledgement as running without exposing a child dialog", () => {
    const input = JSON.stringify({ agent_type: "codex", task: "do x" })
    const output = JSON.stringify({
      content: [{ type: "text", text: "Delegated" }],
      isError: false,
      structuredContent: {
        task_id: "t1",
        status: "running",
        child_conversation_id: 99,
      },
    })

    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="pt-1"
        input={input}
        output={output}
        state="output-available"
      />
    )

    expect(screen.getByText("running")).toBeInTheDocument()
    expect(screen.getByText("#t1")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it.each<{ input: string; task: string }>([
    {
      input: JSON.stringify({
        name: "delegate_to_agent",
        arguments: { agent_type: "codex", task: "wrapped via arguments" },
      }),
      task: "wrapped via arguments",
    },
    {
      input: JSON.stringify({
        params: {
          input: { agent_type: "codex", task: "wrapped via params.input" },
        },
      }),
      task: "wrapped via params.input",
    },
  ])("extracts $task", ({ input, task }) => {
    renderWithIntl(<DelegatedSubThread parentToolUseId="pt-1" input={input} />)
    expect(screen.getByText(task)).toBeInTheDocument()
  })
})
