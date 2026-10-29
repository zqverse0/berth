import {
  emitAppendTextToSession,
  emitAttachFileToSession,
} from "@/lib/agent/session-attachment-events"
import type { ReferencePlan } from "./types"

export type ExecuteReferenceOutcome =
  | {
      kind: "session-done"
      mode: "attach-file" | "attach-range" | "append-text"
      path?: string
      range?: { start: number; end: number }
      text?: string
    }
  | {
      kind: "terminal-preview"
      target: Extract<ReferencePlan, { kind: "terminal-preview" }>["target"]
      text: string
      copyOnly: boolean
    }
  | {
      kind: "copy-only"
      text: string
      reason: "backend-mismatch" | "unknown-shell"
    }
  | {
      kind: "disabled"
      reason: Extract<ReferencePlan, { kind: "disabled" }>["reason"]
    }

/**
 * Apply a plan's side effects for session targets. Terminal preview and
 * copy-only are returned for the UI to confirm / clipboard.
 */
export function executeReferencePlan(
  plan: ReferencePlan
): ExecuteReferenceOutcome {
  switch (plan.kind) {
    case "disabled":
      return { kind: "disabled", reason: plan.reason }
    case "session-attach-file":
      emitAttachFileToSession({ tabId: plan.tabId, path: plan.path })
      return { kind: "session-done", mode: "attach-file", path: plan.path }
    case "session-attach-range":
      emitAttachFileToSession({
        tabId: plan.tabId,
        path: plan.path,
        range: plan.range,
      })
      return {
        kind: "session-done",
        mode: "attach-range",
        path: plan.path,
        range: plan.range,
      }
    case "session-append-text":
      emitAppendTextToSession({ tabId: plan.tabId, text: plan.text })
      return { kind: "session-done", mode: "append-text", text: plan.text }
    case "terminal-preview":
      return {
        kind: "terminal-preview",
        target: plan.target,
        text: plan.text,
        copyOnly: plan.copyOnly,
      }
    case "copy-only":
      return {
        kind: "copy-only",
        text: plan.text,
        reason: plan.reason,
      }
  }
}
