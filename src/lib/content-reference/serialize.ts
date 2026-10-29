import type { EditorReferenceRange, ShellPathProjection } from "./types"

function escapeMarkdownCode(text: string): string {
  return text
    .replace(/`/g, "\\`")
    .replace(/[\r\n\u0000-\u001f\u007f-\u009f]/g, "")
}

/** Fence selected body so nested triple-backticks do not break the block. */
function fenceSelectedText(text: string): string {
  const cleaned = text.replace(/\r\n?/g, "\n")
  let fence = "```"
  while (cleaned.includes(fence)) {
    fence += "`"
  }
  return `${fence}\n${cleaned}\n${fence}`
}

export type AgentReferenceTranslate = (
  key:
    | "agentReferenceFile"
    | "agentReferenceRange"
    | "agentReferenceRangeWithBody"
    | "agentReferencePlainSelection",
  values: Record<string, string | number>
) => string

export function serializeAgentReference(
  path: string,
  range: EditorReferenceRange | undefined,
  translate: AgentReferenceTranslate
): string {
  const safePath = escapeMarkdownCode(path)
  return range
    ? translate("agentReferenceRange", {
        path: safePath,
        start: range.start,
        end: range.end,
      })
    : translate("agentReferenceFile", { path: safePath })
}

/**
 * Agent selection with reliable line numbers. Includes selected body when
 * available so precision matches conversation ranged badges (D7).
 */
export function serializeAgentSelection(
  path: string,
  range: EditorReferenceRange,
  selectedText: string | undefined,
  translate: AgentReferenceTranslate
): string {
  const safePath = escapeMarkdownCode(path)
  const body = selectedText?.replace(/\r\n?/g, "\n").trim()
  if (!body) {
    return translate("agentReferenceRange", {
      path: safePath,
      start: range.start,
      end: range.end,
    })
  }
  return translate("agentReferenceRangeWithBody", {
    path: safePath,
    start: range.start,
    end: range.end,
    body: fenceSelectedText(body),
  })
}

/**
 * Plain selection without reliable line numbers (preview/PDF). Aligns with
 * session-append-text precision (D6′ / D9).
 */
export function serializeAgentPlainSelection(
  path: string | null,
  selectedText: string,
  translate: AgentReferenceTranslate
): string {
  const body = selectedText.replace(/\r\n?/g, "\n").trim()
  const fenced = fenceSelectedText(body)
  if (!path) return fenced
  return translate("agentReferencePlainSelection", {
    path: escapeMarkdownCode(path),
    body: fenced,
  })
}

export function quotePathForShell(
  shell: string,
  path: string
): ShellPathProjection {
  const shellParts = shell.toLowerCase().replace(/\\/g, "/").split("/")
  const name = shellParts[shellParts.length - 1] ?? ""
  if (["bash", "zsh", "sh", "fish", "dash", "ksh"].includes(name)) {
    return { kind: "insert", text: `'${path.replace(/'/g, "'\\''")}'` }
  }
  if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(name)) {
    return { kind: "insert", text: `'${path.replace(/'/g, "''")}'` }
  }
  return { kind: "copy-only", text: path }
}

export function sanitizeTerminalPaste(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
}
