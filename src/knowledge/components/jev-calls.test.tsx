import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"
import en from "@/i18n/messages/en.json"
import type { DecisionCall } from "@/lib/model-provider"
import { JevCalls } from "./jev-calls"

const call: DecisionCall = {
  id: "c1",
  at: "2026-10-15T01:50:33Z",
  caller: "knowledge.classify",
  subject: { project: "/p", session: "08aeee8b-1234", turn: 2 },
  profile: "TypeSafe Jev",
  model: "jev-1.13.0",
  state: { user_message: "确认" },
  questions: {
    approval: {
      type: "noul",
      instructions: "是否批准？",
      criteria: { true: "是", false: "否" },
    },
    "s0.pitfall": {
      type: "noul",
      instructions: "是不是坑？",
      criteria: { true: "是", false: "否" },
    },
  },
  answers: {
    approval: { type: "noul", noul: 0.97 },
    "s0.pitfall": { type: "noul", noul: 0.12 },
  },
  usage: { input_tokens: 390, output_tokens: 20 },
  ms: 1640,
}

describe("JevCalls", () => {
  it("summarises who called, for which round, and the answers leaning yes", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <JevCalls
          calls={[
            call,
            { ...call, id: "c2", answers: undefined, error: "HTTP 400" },
          ]}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getAllByText("session 08aeee8b prompt 2")).toHaveLength(2)
    expect(screen.getAllByText("1640 ms · 410 tokens")).toHaveLength(2)
    // 摘要只列偏「是」的题；展开表里每道题都有。
    expect(screen.getByText("2 questions · approval 0.97")).toBeInTheDocument()
    expect(screen.getAllByText("0.12")).toHaveLength(1)
    expect(screen.getByText("HTTP 400")).toBeInTheDocument()
    expect(screen.getAllByText(/"user_message": "确认"/)).toHaveLength(2)
  })
})
