import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { type GroupEvent } from "@/lib/agent/berth-group"
import { GroupTimeline } from "./group-timeline"

vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <pre>{children}</pre>
  ),
}))
vi.mock("@/components/agents/profile/agent-profile-icon", () => ({
  AgentProfileIcon: () => <span />,
}))
vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => <span /> }))
const event = (seq: number): GroupEvent => ({
  schema_version: 1,
  seq,
  kind: "message",
  author: "a",
  text: `message ${seq}`,
  timestamp_ms: seq * 1000,
})
function timeline(events: GroupEvent[], scopeKey = "all") {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <GroupTimeline
        events={events}
        delivery={{}}
        agentOf={() => null}
        scopeKey={scopeKey}
      />
    </NextIntlClientProvider>
  )
}

describe("GroupTimeline reading position", () => {
  it("keeps historical reading position and counts new messages", () => {
    const view = render(timeline([event(1), event(2)]))
    const node = document.querySelector<HTMLDivElement>(
      "[data-group-timeline]"
    )!
    Object.defineProperties(node, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 100, configurable: true },
    })
    node.scrollTop = 200
    fireEvent.scroll(node)
    view.rerender(timeline([event(1), event(2), event(3)]))
    expect(node.scrollTop).toBe(200)
    expect(screen.getByRole("button", { name: "1 new messages" })).toBeVisible()
  })

  it("restores the full conversation position after viewing another Agent", () => {
    const view = render(timeline([event(1), event(2)]))
    const node = document.querySelector<HTMLDivElement>(
      "[data-group-timeline]"
    )!
    Object.defineProperties(node, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 100, configurable: true },
    })
    node.scrollTop = 250
    fireEvent.scroll(node)
    view.rerender(timeline([event(2)], "member:b"))
    expect(node.scrollTop).toBe(1000)
    view.rerender(timeline([event(1), event(2)]))
    expect(node.scrollTop).toBe(250)
  })

  it("follows new messages only while the user is near the bottom", () => {
    const view = render(timeline([event(1)]))
    const node = document.querySelector<HTMLDivElement>(
      "[data-group-timeline]"
    )!
    Object.defineProperties(node, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 100, configurable: true },
    })
    node.scrollTop = 900
    fireEvent.scroll(node)
    Object.defineProperty(node, "scrollHeight", {
      value: 1200,
      configurable: true,
    })
    view.rerender(timeline([event(1), event(2)]))
    expect(node.scrollTop).toBe(1200)
    expect(screen.queryByRole("button", { name: /new messages/ })).toBeNull()
  })
})

describe("Agent reply preview", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const height = (pixels: number) =>
    vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute("data-agent-message-content") ? pixels : 0
      })
  it("folds replies longer than thirty lines and toggles the complete text", () => {
    height(900)
    const text = "full reply ".repeat(100)
    render(
      timeline([
        { ...event(1), source: "transcript", digest: "short old digest", text },
      ])
    )
    const preview = document.querySelector("[data-agent-message-preview]")!
    expect(preview).toHaveClass("max-h-[30rem]", "overflow-hidden")
    expect(screen.getByText(text.trim())).toBeVisible()
    expect(screen.queryByText("short old digest")).toBeNull()
    const expand = screen.getByRole("button", { name: /Show full reply/ })
    expect(expand).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(expand)
    expect(preview).not.toHaveClass("max-h-[30rem]")
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
    expect(preview).toHaveClass("max-h-[30rem]")
  })
  it("does not offer expansion for short replies", () => {
    height(48)
    render(timeline([event(1)]))
    expect(screen.queryByRole("button", { name: /Show full reply/ })).toBeNull()
  })
  it("also folds long ordinary Agent messages without a backend digest", () => {
    height(900)
    render(timeline([{ ...event(1), text: "a long ordinary message" }]))
    expect(
      screen.getByRole("button", { name: /Show full reply/ })
    ).toBeVisible()
  })
  it("rechecks overflow as content or available width changes", () => {
    let pixels = 48
    let remeasure: (() => void) | undefined
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-agent-message-content") ? pixels : 0
      }
    )
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: () => void) {}
        observe(node: Element) {
          if (node.hasAttribute("data-agent-message-content"))
            remeasure = this.callback
        }
        disconnect() {}
      }
    )
    render(timeline([event(1)]))
    expect(screen.queryByRole("button", { name: /Show full reply/ })).toBeNull()
    pixels = 900
    act(() => remeasure!())
    expect(
      screen.getByRole("button", { name: /Show full reply/ })
    ).toBeVisible()
    pixels = 48
    act(() => remeasure!())
    expect(screen.queryByRole("button", { name: /Show full reply/ })).toBeNull()
  })
  it("does not fold replies that fit exactly thirty lines", () => {
    height(720)
    render(timeline([event(1)]))
    expect(screen.queryByRole("button", { name: /Show full reply/ })).toBeNull()
  })
})

describe("GroupTimeline delegation progress", () => {
  const ask = (seq: number, to: string): GroupEvent => ({
    ...event(seq),
    author: "user",
    to,
  })
  const result = (
    seq: number,
    author: string,
    reply_to?: number
  ): GroupEvent => ({
    ...event(seq),
    author,
    source: "transcript",
    reply_to,
  })
  const states = (events: GroupEvent[]) => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <GroupTimeline
          events={events}
          delivery={{ 1: "delivered", 2: "delivered", 3: "queued" }}
          agentOf={() => null}
          onContext={() => {}}
        />
      </NextIntlClientProvider>
    )
    return [...document.querySelectorAll<HTMLElement>("[data-delivery]")].map(
      (node) => node.dataset.delivery
    )
  }

  it("derives working, done and queued from delivery and result links", () => {
    expect(
      states([ask(1, "b"), ask(2, "c"), ask(3, "b"), result(4, "b", 1)])
    ).toEqual(["done", "working", "queued"])
  })

  it("files each answer under the question it replies to, whatever order they arrive in", () => {
    states([
      ask(1, "b"),
      ask(2, "c"),
      ask(3, "b"),
      result(4, "c", 2),
      result(5, "b", 1),
    ])
    const seqs = [
      ...document.querySelectorAll<HTMLElement>("[data-event-seqs]"),
    ].map((node) => node.dataset.eventSeqs)
    expect(seqs).toEqual(["1 5", "2 4", "3"])
    // 已回答的不再报「处理中」；没回答的那句显示收件人在排队。
    expect(document.querySelector("[data-answer-pending]")).toHaveAttribute(
      "data-answer-pending",
      "queued"
    )
  })

  it("marks a delivered delegation interrupted once the recipient left without a result", () => {
    expect(
      states([
        ask(1, "b"),
        ask(2, "c"),
        { ...event(3), kind: "left", author: "b" },
      ])
    ).toEqual(["interrupted", "working"])
  })

  it("falls back to delivered when the recipient reported without a link", () => {
    expect(states([ask(1, "b"), result(2, "b")])).toEqual(["delivered"])
  })

  it("highlights the recipient of a member's delegation but not of a result", () => {
    states([
      { ...event(1), author: "a", to: "b" },
      { ...result(2, "b", 1), to: "a" },
    ])
    // Agent 之间的消息折成一行：点开看全文。
    const relays = [
      ...document.querySelectorAll<HTMLElement>("[data-relay] > button"),
    ]
    expect(relays).toHaveLength(2)
    relays.forEach((relay) => fireEvent.click(relay))
    const marked = [
      ...document.querySelectorAll<HTMLElement>("[data-delegate-to]"),
    ]
    expect(marked.map((node) => node.dataset.delegateTo)).toEqual(["b"])
    expect(marked[0]).toHaveClass("text-link")
  })
})

describe("GroupTimeline turn files", () => {
  it("lists the files a reply changed and opens them in the workspace", () => {
    const onOpenFile = vi.fn()
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <GroupTimeline
          events={[
            {
              ...event(1),
              source: "transcript",
              root: "/repo",
              files: [
                { path: "src/a.ts", status: "modified", added: 3, removed: 1 },
                { path: "old.md", status: "deleted" },
              ],
            },
          ]}
          delivery={{}}
          agentOf={() => null}
          onOpenFile={onOpenFile}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("2 files changed")).toBeInTheDocument()
    expect(screen.getAllByText("+3")).toHaveLength(2)
    fireEvent.click(screen.getByText("src/a.ts"))
    expect(onOpenFile).toHaveBeenCalledWith("/repo/src/a.ts")
    expect(screen.getByText("old.md").closest("button")).toBeDisabled()
  })
})
