import type { AgentType } from "@/lib/types"
import type { TabItem } from "@/stores/tab-store"

export type ContentSourceKind =
  | "text-editor"
  | "text-preview"
  | "image"
  | "pdf"
  | "office"
  | "diff"
  | "path-only"

export interface SourceCapabilities {
  attachWholeFile: boolean
  attachLineRange: boolean
  extractPlainText: boolean
  preferImageAttachment: boolean
}

export interface ContentSourceSnapshot {
  kind: ContentSourceKind
  absolutePath: string | null
  workspacePath: string | null
  fileName: string
  sourceFolderId: number | null
  sourceBackendInstanceId: string
}

export interface SelectionPayload {
  /** 1-based inclusive line range; only when line numbers are reliable */
  range?: { start: number; end: number }
  /** Selected plain text when available */
  text?: string
}

export type ReferenceIntent = { type: "whole-file" } | { type: "selection" }

export interface EditorReferenceRange {
  start: number
  end: number
}

export interface EditorReference {
  absolutePath: string
  workspacePath: string | null
  fileName: string
  range?: EditorReferenceRange
  selectedText?: string
  sourceBackendInstanceId: string
  sourceFolderId: number | null
}

export type EditorReferenceTarget =
  | { kind: "conversation"; tabId: string }
  | {
      kind: "agent-terminal"
      tabId: string
      terminalId: string
      backendInstanceId: string
      agentType: AgentType
      cwd: string
      shell: string
    }
  | {
      kind: "shell-terminal"
      tabId: string
      terminalId: string
      backendInstanceId: string
      cwd: string
      shell: string
    }

export type PathProjection =
  | { kind: "reachable"; path: string; absolute: boolean }
  | { kind: "unreachable"; reason: "backend-mismatch" }

export type ShellPathProjection =
  | { kind: "insert"; text: string }
  | { kind: "copy-only"; text: string }

export type DisabledReason =
  | "no-target"
  | "no-path"
  | "unsupported-intent"
  | "empty-selection"
  | "unsupported"

export type ReferencePlan =
  | { kind: "disabled"; reason: DisabledReason }
  | { kind: "session-attach-file"; tabId: string; path: string }
  | {
      kind: "session-attach-range"
      tabId: string
      path: string
      range: { start: number; end: number }
    }
  | { kind: "session-append-text"; tabId: string; text: string }
  | {
      kind: "terminal-preview"
      target: Extract<
        EditorReferenceTarget,
        { kind: "agent-terminal" | "shell-terminal" }
      >
      text: string
      copyOnly: boolean
    }
  | {
      kind: "copy-only"
      text: string
      reason: "backend-mismatch" | "unknown-shell"
    }

export type { TabItem }
