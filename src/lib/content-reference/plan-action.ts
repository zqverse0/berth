import { getSourceCapabilities } from "./capabilities"
import { normalizeAbsolutePath, projectReferencePath } from "./project-path"
import {
  quotePathForShell,
  sanitizeTerminalPaste,
  serializeAgentPlainSelection,
  serializeAgentReference,
  serializeAgentSelection,
  type AgentReferenceTranslate,
} from "./serialize"
import type {
  ContentSourceSnapshot,
  EditorReference,
  EditorReferenceTarget,
  ReferenceIntent,
  ReferencePlan,
  SelectionPayload,
} from "./types"

export type PlanReferenceOptions = {
  translate: AgentReferenceTranslate
}

type TerminalTarget = Extract<
  EditorReferenceTarget,
  { kind: "agent-terminal" | "shell-terminal" }
>

function toEditorReference(
  source: ContentSourceSnapshot,
  selection?: SelectionPayload | null
): EditorReference | null {
  if (!source.absolutePath) return null
  return {
    absolutePath: source.absolutePath,
    workspacePath: source.workspacePath,
    fileName: source.fileName,
    sourceBackendInstanceId: source.sourceBackendInstanceId,
    sourceFolderId: source.sourceFolderId,
    ...(selection?.range ? { range: selection.range } : {}),
    ...(selection?.text !== undefined ? { selectedText: selection.text } : {}),
  }
}

/**
 * P2 whole-file for agent/shell: path reference only (A), no full body.
 * Shell uses quoted path; prefer projected path, absolute when projection is absolute.
 */
function planTerminalWholeFile(
  source: ContentSourceSnapshot,
  target: TerminalTarget,
  translate: AgentReferenceTranslate
): ReferencePlan {
  const reference = toEditorReference(source)
  if (!reference) return { kind: "disabled", reason: "no-path" }
  const projection = projectReferencePath(reference, target)
  if (projection.kind === "unreachable") {
    return {
      kind: "copy-only",
      text: normalizeAbsolutePath(reference.absolutePath),
      reason: "backend-mismatch",
    }
  }

  if (target.kind === "agent-terminal") {
    return {
      kind: "terminal-preview",
      target,
      text: serializeAgentReference(projection.path, undefined, translate),
      copyOnly: false,
    }
  }

  // Shell: quote projected path (relative or absolute); P3 absolute on unknown shell
  const quoted = quotePathForShell(target.shell, projection.path)
  if (quoted.kind === "copy-only") {
    return {
      kind: "copy-only",
      text: normalizeAbsolutePath(reference.absolutePath),
      reason: "unknown-shell",
    }
  }
  return {
    kind: "terminal-preview",
    target,
    text: quoted.text,
    copyOnly: false,
  }
}

/**
 * P1 selection for agent/shell: same precision as conversation
 * (range+body or plain text).
 */
function planTerminalSelection(
  source: ContentSourceSnapshot,
  selection: SelectionPayload | null | undefined,
  target: TerminalTarget,
  translate: AgentReferenceTranslate
): ReferencePlan {
  const cap = getSourceCapabilities(source.kind)
  const reference = toEditorReference(source, selection)
  if (!reference) return { kind: "disabled", reason: "no-path" }

  const projection = projectReferencePath(reference, target)
  if (projection.kind === "unreachable") {
    const fallback =
      selection?.text?.trim() ||
      (selection?.range
        ? `${reference.absolutePath}:${selection.range.start}-${selection.range.end}`
        : reference.absolutePath)
    return {
      kind: "copy-only",
      text: sanitizeTerminalPaste(fallback),
      reason: "backend-mismatch",
    }
  }

  if (cap.attachLineRange && selection?.range) {
    const text = serializeAgentSelection(
      projection.path,
      selection.range,
      selection.text,
      translate
    )
    return {
      kind: "terminal-preview",
      target,
      text: sanitizeTerminalPaste(text),
      copyOnly: false,
    }
  }

  const plain = selection?.text?.trim()
  if (cap.extractPlainText && plain) {
    return {
      kind: "terminal-preview",
      target,
      text: sanitizeTerminalPaste(
        serializeAgentPlainSelection(projection.path, plain, translate)
      ),
      copyOnly: false,
    }
  }

  return { kind: "disabled", reason: "empty-selection" }
}

function planConversationSelection(
  source: ContentSourceSnapshot,
  selection: SelectionPayload | null | undefined,
  tabId: string
): ReferencePlan {
  if (!source.absolutePath) {
    return { kind: "disabled", reason: "no-path" }
  }
  const cap = getSourceCapabilities(source.kind)

  if (cap.attachLineRange && selection?.range) {
    return {
      kind: "session-attach-range",
      tabId,
      path: source.absolutePath,
      range: selection.range,
    }
  }

  const plain = selection?.text?.trim()
  if (cap.extractPlainText && plain) {
    // Q4: no reliable line range (preview/pdf/diff) → append plain text
    if (!cap.attachLineRange || source.kind === "diff") {
      return {
        kind: "session-append-text",
        tabId,
        text: plain,
      }
    }
  }

  if (cap.attachLineRange) {
    return { kind: "disabled", reason: "empty-selection" }
  }

  return { kind: "disabled", reason: "empty-selection" }
}

/**
 * Single decision brain: P1 selection → P2 whole-file path → P3 absolute fallback.
 * Conversation / Agent terminal / Shell share the same priority.
 */
export function planReferenceAction(
  source: ContentSourceSnapshot,
  selection: SelectionPayload | null | undefined,
  target: EditorReferenceTarget | null,
  intent: ReferenceIntent,
  options: PlanReferenceOptions
): ReferencePlan {
  if (!target) return { kind: "disabled", reason: "no-target" }
  if (!source.absolutePath) return { kind: "disabled", reason: "no-path" }

  const cap = getSourceCapabilities(source.kind)

  if (intent.type === "whole-file") {
    if (!cap.attachWholeFile) {
      return { kind: "disabled", reason: "unsupported" }
    }
    if (target.kind === "conversation") {
      return {
        kind: "session-attach-file",
        tabId: target.tabId,
        path: source.absolutePath,
      }
    }
    return planTerminalWholeFile(source, target, options.translate)
  }

  // selection (P1)
  if (target.kind === "conversation") {
    return planConversationSelection(source, selection, target.tabId)
  }

  return planTerminalSelection(source, selection, target, options.translate)
}

export function canReferenceWholeFile(
  source: ContentSourceSnapshot,
  target: EditorReferenceTarget | null
): boolean {
  if (!target || !source.absolutePath) return false
  return getSourceCapabilities(source.kind).attachWholeFile
}

export function canReferenceSelection(
  source: ContentSourceSnapshot,
  target: EditorReferenceTarget | null
): boolean {
  if (!target || !source.absolutePath) return false
  const cap = getSourceCapabilities(source.kind)
  return cap.attachLineRange || cap.extractPlainText
}
