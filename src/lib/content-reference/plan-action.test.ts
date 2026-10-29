import { describe, expect, it } from "vitest"
import { canReferenceSelection, planReferenceAction } from "./plan-action"
import type {
  ContentSourceSnapshot,
  EditorReferenceTarget,
  SelectionPayload,
} from "./types"

const translate = (
  key: string,
  values: Record<string, string | number>
): string => {
  switch (key) {
    case "agentReferenceFile":
      return `Please inspect \`${values.path}\``
    case "agentReferenceRange":
      return `Please inspect \`${values.path}\` lines ${values.start}–${values.end}`
    case "agentReferenceRangeWithBody":
      return `Please inspect \`${values.path}\` lines ${values.start}–${values.end}:\n\n${values.body}`
    case "agentReferencePlainSelection":
      return `Selected from \`${values.path}\`:\n\n${values.body}`
    default:
      return key
  }
}

const source = (
  partial: Partial<ContentSourceSnapshot> &
    Pick<ContentSourceSnapshot, "kind" | "absolutePath">
): ContentSourceSnapshot => ({
  fileName: "a.ts",
  workspacePath: "src/a.ts",
  sourceFolderId: 1,
  sourceBackendInstanceId: "backend-a",
  ...partial,
})

const conversation: EditorReferenceTarget = {
  kind: "conversation",
  tabId: "c1",
}

const agent: EditorReferenceTarget = {
  kind: "agent-terminal",
  tabId: "a1",
  terminalId: "t-agent",
  backendInstanceId: "backend-a",
  agentType: "codex",
  cwd: "/work/project",
  shell: "/bin/bash",
}

const shell: EditorReferenceTarget = {
  kind: "shell-terminal",
  tabId: "s1",
  terminalId: "t-shell",
  backendInstanceId: "backend-a",
  cwd: "/work/project",
  shell: "/bin/bash",
}

const opts = { translate }

describe("planReferenceAction P1→P2→P3", () => {
  it("disables without target or path", () => {
    expect(
      planReferenceAction(
        source({ kind: "text-editor", absolutePath: "/x" }),
        null,
        null,
        { type: "whole-file" },
        opts
      )
    ).toEqual({ kind: "disabled", reason: "no-target" })
    expect(
      planReferenceAction(
        source({ kind: "text-editor", absolutePath: null }),
        null,
        conversation,
        { type: "whole-file" },
        opts
      )
    ).toEqual({ kind: "disabled", reason: "no-path" })
  })

  it("P2 whole file to conversation is file badge", () => {
    expect(
      planReferenceAction(
        source({ kind: "image", absolutePath: "/work/project/a.png" }),
        null,
        conversation,
        { type: "whole-file" },
        opts
      )
    ).toEqual({
      kind: "session-attach-file",
      tabId: "c1",
      path: "/work/project/a.png",
    })
  })

  it("P1 conversation range attaches badge", () => {
    const selection: SelectionPayload = {
      range: { start: 10, end: 25 },
      text: "const x = 1",
    }
    expect(
      planReferenceAction(
        source({
          kind: "text-editor",
          absolutePath: "/work/project/src/a.ts",
        }),
        selection,
        conversation,
        { type: "selection" },
        opts
      )
    ).toEqual({
      kind: "session-attach-range",
      tabId: "c1",
      path: "/work/project/src/a.ts",
      range: { start: 10, end: 25 },
    })
  })

  it("P1 text-preview appends plain text to conversation (Q4)", () => {
    expect(
      planReferenceAction(
        source({
          kind: "text-preview",
          absolutePath: "/work/project/README.md",
        }),
        { text: "hello preview" },
        conversation,
        { type: "selection" },
        opts
      )
    ).toEqual({
      kind: "session-append-text",
      tabId: "c1",
      text: "hello preview",
    })
  })

  it("P1 agent and shell selection share range+body precision (Q1/Q2)", () => {
    const selection = {
      range: { start: 10, end: 12 },
      text: "line body",
    }
    const agentPlan = planReferenceAction(
      source({
        kind: "text-editor",
        absolutePath: "/work/project/src/a.ts",
        workspacePath: "src/a.ts",
      }),
      selection,
      agent,
      { type: "selection" },
      opts
    )
    const shellPlan = planReferenceAction(
      source({
        kind: "text-editor",
        absolutePath: "/work/project/src/a.ts",
        workspacePath: "src/a.ts",
      }),
      selection,
      shell,
      { type: "selection" },
      opts
    )
    expect(agentPlan.kind).toBe("terminal-preview")
    expect(shellPlan.kind).toBe("terminal-preview")
    if (agentPlan.kind !== "terminal-preview") return
    if (shellPlan.kind !== "terminal-preview") return
    expect(agentPlan.text).toContain("line body")
    expect(agentPlan.text).toContain("10")
    expect(shellPlan.text).toContain("line body")
    expect(shellPlan.text).toContain("10")
    expect(
      canReferenceSelection(
        source({ kind: "text-editor", absolutePath: "/x" }),
        shell
      )
    ).toBe(true)
  })

  it("P1 agent/shell plain selection from preview (Q4)", () => {
    for (const target of [agent, shell] as const) {
      const plan = planReferenceAction(
        source({
          kind: "text-preview",
          absolutePath: "/work/project/README.md",
          workspacePath: "README.md",
        }),
        { text: "selected paragraph" },
        target,
        { type: "selection" },
        opts
      )
      expect(plan.kind).toBe("terminal-preview")
      if (plan.kind !== "terminal-preview") return
      expect(plan.text).toContain("selected paragraph")
      expect(plan.text).not.toMatch(/#L\d/)
    }
  })

  it("P2 shell whole-file quotes path (not selection-only absolute gate)", () => {
    const plan = planReferenceAction(
      source({
        kind: "text-editor",
        absolutePath: "/work/project/a file.ts",
        workspacePath: "a file.ts",
      }),
      null,
      shell,
      { type: "whole-file" },
      opts
    )
    expect(plan.kind).toBe("terminal-preview")
    if (plan.kind !== "terminal-preview") return
    expect(plan.copyOnly).toBe(false)
    // quoted path fragment
    expect(plan.text).toContain("a file.ts")
  })

  it("P3 backend mismatch copy-only absolute path", () => {
    const plan = planReferenceAction(
      source({
        kind: "text-editor",
        absolutePath: "/work/a.ts",
        sourceBackendInstanceId: "backend-b",
      }),
      null,
      agent,
      { type: "whole-file" },
      opts
    )
    expect(plan).toEqual({
      kind: "copy-only",
      text: "/work/a.ts",
      reason: "backend-mismatch",
    })
  })
})
