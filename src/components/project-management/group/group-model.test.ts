import { describe, expect, it } from "vitest"
import {
  builtinMember,
  type GroupEvent,
  type GroupMember,
} from "@/lib/agent/berth-group"
import type { AgentPaneRow } from "@/lib/terminal/agent-panes"
import {
  activeDelegations,
  delegationProgress,
  memberRows,
  filterMemberEvents,
  reportBody,
  splitCommit,
  timelineItems,
} from "./group-model"

function member(name: string, extra: Partial<GroupMember> = {}): GroupMember {
  return {
    name,
    bodies: [
      {
        target_ref: `ref-${name}`,
        agent: "claude",
        cwd: "/wt",
        collect: true,
        derived: true,
        joined_seq: 1,
        joined_at: 1_000,
      },
    ],
    joined_seq: 1,
    joined_at: 1_000,
    leftAt: null,
    ...extra,
  }
}

function pane(
  ref: string,
  state: AgentPaneRow["state"],
  since = 5_000
): AgentPaneRow {
  return {
    descriptor: {
      terminalId: `t-${ref}`,
      targetRef: ref,
    } as AgentPaneRow["descriptor"],
    state,
    since,
  }
}

function message(
  seq: number,
  author: string,
  extra: Partial<GroupEvent> = {}
): GroupEvent {
  return {
    schema_version: 1,
    seq,
    timestamp_ms: seq * 1_000,
    kind: "message",
    author,
    ...extra,
  }
}

describe("memberRows", () => {
  it("shows the built-in Berth member as working or idle without a terminal", () => {
    const status = (busy: boolean) =>
      memberRows([builtinMember({ name: "berth", busy })], [], [], {})[0].status
    expect(status(true)).toBe("working")
    expect(status(false)).toBe("idle")
  })

  it("joins members to their panes, marks unread attention and sorts by urgency", () => {
    const rows = memberRows(
      [
        member("claude-1", { joined_seq: 1 }),
        member("claude-2", { joined_seq: 2 }),
        member("claude-3", { joined_seq: 3 }),
        member("codex-1", { joined_seq: 4, leftAt: 9_000 }),
      ],
      [message(7, "claude-1")],
      [
        pane("ref-claude-1", "idle", 2_000),
        pane("ref-claude-2", "attention", 6_000),
      ],
      {}
    )
    expect(rows.map((row) => [row.member.name, row.status])).toEqual([
      ["claude-2", "attention"],
      ["claude-1", "idle"],
      ["claude-3", "offline"],
      ["codex-1", "left"],
    ])
    expect(rows[0].unread).toBe(true)
    expect(rows[1].lastActivity).toBe(7_000)
    expect(rows[3].pane).toBeNull()
  })

  it("shows attention the user already saw as idle until the agent signals again", () => {
    const seen = { "t-ref-claude-1": 6_000 }
    const [row] = memberRows(
      [member("claude-1")],
      [],
      [pane("ref-claude-1", "attention", 6_000)],
      seen
    )
    expect([row.status, row.unread]).toEqual(["idle", false])
    const [again] = memberRows(
      [member("claude-1")],
      [],
      [pane("ref-claude-1", "attention", 9_000)],
      seen
    )
    expect([again.status, again.unread]).toEqual(["attention", true])
  })
})

describe("reports", () => {
  it("drops the commit suffix from the digest when commits are shown structurally", () => {
    const event = message(1, "claude-1", {
      source: "transcript",
      text: "done",
      digest: "done\n\n新提交：\nabc123 feat: x\n 1 file changed",
      commits: ["abc123 feat: x"],
    })
    expect(reportBody(event)).toBe("done")
    expect(splitCommit("abc123 feat: x")).toEqual({
      hash: "abc123",
      subject: "feat: x",
    })
  })
})

describe("timelineItems", () => {
  it("folds one send to several members into a single item", () => {
    const user = (seq: number, to: string, key?: string) =>
      message(seq, "user", { to, text: "go", idempotency_key: key })
    const items = timelineItems([
      user(1, "a", "gui-1-x:a"),
      user(2, "b", "gui-1-x:b"),
      message(3, "a", { text: "ok" }),
      user(4, "a", "gui-2-y:a"),
      user(5, "b"),
    ])
    expect(
      items.map((item) =>
        item.kind === "ask"
          ? item.events.map((event) => event.seq)
          : item.event.seq
      )
    ).toEqual([[1, 2], 3, [4], [5]])
  })

  it("files answers under the question they reply to, whatever order they arrive in", () => {
    const user = (seq: number, to: string) =>
      message(seq, "user", { to, text: "go", idempotency_key: `gui-1-x:${to}` })
    const answer = (seq: number, author: string, reply_to: number) =>
      message(seq, author, { source: "transcript", reply_to })
    const items = timelineItems([
      user(1, "a"),
      user(2, "b"),
      answer(3, "b", 2),
      message(4, "user", { to: "a", text: "more" }),
      answer(5, "a", 1),
      answer(6, "a", 4),
    ])
    expect(
      items.map((item) =>
        item.kind === "ask"
          ? item.answers.map((event) => event.seq)
          : item.event.seq
      )
    ).toEqual([[3, 5], [6]])
  })
})

describe("delegationProgress", () => {
  it("marks a question answered together with a later one as superseded", () => {
    const events = [
      message(1, "user", { to: "a", text: "first" }),
      message(2, "user", { to: "a", text: "second" }),
      message(3, "a", { source: "transcript", reply_to: 2 }),
      message(4, "user", { to: "a", text: "third" }),
    ]
    const progress = delegationProgress(events, {
      1: "delivered",
      2: "delivered",
      4: "delivered",
    })
    expect(progress(1)?.state).toBe("superseded")
    expect(progress(2)).toEqual({ state: "done", result: 3 })
    expect(progress(4)?.state).toBe("working")
  })
})

describe("filterMemberEvents", () => {
  it("keeps only the user's thread with the member and linked replies", () => {
    const events = [
      message(1, "a", { text: "question" }),
      message(2, "b", { to: "a" }),
      message(3, "b", { reply_to: 1 }),
      message(4, "b", { text: "@a unrelated text" }),
      message(5, "user", { to: "a" }),
      message(6, "a", { to: "c" }),
      message(7, "a", { to: "user", reply_to: 5 }),
    ]
    expect(filterMemberEvents(events, "a").map((event) => event.seq)).toEqual([
      1, 3, 5, 7,
    ])
    expect(filterMemberEvents(events, null)).toBe(events)
  })
})

describe("group activity", () => {
  const at = { timestamp_ms: 1, schema_version: 1 }
  const events: GroupEvent[] = [
    { ...at, seq: 1, kind: "joined", author: "a" },
    { ...at, seq: 2, kind: "message", author: "user", to: "a", text: "x" },
    { ...at, seq: 3, kind: "system", event: "commits", commits: ["abc x"] },
    { ...at, seq: 4, kind: "message", author: "a", to: "b", text: "y" },
    { ...at, seq: 5, kind: "left", author: "c" },
  ]

  it("shows only messages: joins, leaves, commits and system notices stay in the ledger", () => {
    const withNotices: GroupEvent[] = [
      ...events,
      { ...at, seq: 6, kind: "system", event: "started", branch: "b" },
      { ...at, seq: 7, kind: "spec", rev: 2 },
    ]
    expect(
      timelineItems(withNotices).map((item) =>
        item.kind === "event" ? item.event.seq : item.events[0].seq
      )
    ).toEqual([2, 4])
  })

  it("lists queued and working delegations newest first", () => {
    const progress = delegationProgress(events, {
      2: "delivered",
      4: "queued",
    })
    expect(activeDelegations(events, progress).map((e) => e.seq)).toEqual([
      4, 2,
    ])
  })
})
