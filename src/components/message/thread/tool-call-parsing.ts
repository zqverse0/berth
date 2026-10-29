// 工具调用的纯解析：命令、路径、apply_patch / 编辑负载、一行标题。不依赖 React 与 Markdown 渲染，
// 项目主页等只要标题的地方直接引这里，不把整套消息渲染器带进首屏。
import {
  countUnifiedDiffLineChanges,
  estimateChangedLineStats,
} from "@/lib/git/line-change-stats"
export function tryParseJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s)
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/** Regex-extract a JSON string value for a given key (works on truncated JSON). */
export function extractJsonField(input: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const m = input.match(re)
  return m?.[1]?.replace(/\\"/g, '"').replace(/\\\\/g, "\\") ?? null
}

export function asObjectLike(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed.startsWith("{")) return null
  return tryParseJson(trimmed)
}

export const NESTED_PAYLOAD_KEYS = ["input", "arguments", "params", "payload"]

export function findStringFieldDeep(
  value: unknown,
  key: string,
  depth: number = 0
): string | null {
  if (depth > 4) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringFieldDeep(item, key, depth + 1)
      if (found) return found
    }
    return null
  }
  const obj = asObjectLike(value)
  if (!obj) return null

  const direct = obj[key]
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct
  }

  for (const nestedKey of NESTED_PAYLOAD_KEYS) {
    const found = findStringFieldDeep(obj[nestedKey], key, depth + 1)
    if (found) return found
  }

  for (const nestedValue of Object.values(obj)) {
    const found = findStringFieldDeep(nestedValue, key, depth + 1)
    if (found) return found
  }

  return null
}

export function findObjectFieldDeep(
  value: unknown,
  key: string,
  depth: number = 0
): Record<string, unknown> | null {
  if (depth > 4) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObjectFieldDeep(item, key, depth + 1)
      if (found) return found
    }
    return null
  }
  const obj = asObjectLike(value)
  if (!obj) return null

  const direct = asObjectLike(obj[key])
  if (direct) return direct

  for (const nestedKey of NESTED_PAYLOAD_KEYS) {
    const found = findObjectFieldDeep(obj[nestedKey], key, depth + 1)
    if (found) return found
  }

  for (const nestedValue of Object.values(obj)) {
    const found = findObjectFieldDeep(nestedValue, key, depth + 1)
    if (found) return found
  }

  return null
}

export function decodeJsonEscapedString(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\\\/g, "\\")
}

export function extractEditPathsFromChangesPayload(
  input: string,
  parsed: Record<string, unknown> | null
): string[] {
  const changes = findObjectFieldDeep(parsed, "changes")
  if (changes) {
    const paths = Object.keys(changes)
      .map((path) => path.trim())
      .filter((path) => path.length > 0)
    if (paths.length > 0) return paths
  }

  const firstPathMatch = input.match(/"changes"\s*:\s*\{\s*"((?:[^"\\]|\\.)+)"/)
  if (!firstPathMatch?.[1]) return []

  return [decodeJsonEscapedString(firstPathMatch[1])]
}

export function extractPathFromDiffText(
  text: string | null | undefined
): string | null {
  if (!text) return null
  const match = text.match(/^(?:---|\+\+\+)\s+([^\n]+)$/m)
  if (!match?.[1]) return null
  const raw = match[1].trim()
  if (!raw || raw === "/dev/null") return null
  return raw.replace(/^[ab]\//, "")
}

export function isLikelyIdField(key: string): boolean {
  const lower = key.toLowerCase()
  return (
    lower === "id" ||
    lower === "uuid" ||
    lower === "callid" ||
    lower === "call_id" ||
    lower === "tool_call_id" ||
    lower.endsWith("_id") ||
    lower.endsWith("id")
  )
}

/** Shorten an absolute path to its last 2 segments. */
export function shortPath(p: string): string {
  return p.split("/").slice(-2).join("/")
}

/** Truncate text to maxLen, appending "…" if truncated. */
export function ellipsis(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s
}

export function unwrapQuotedCommand(command: string): string {
  const trimmed = command.trim()
  if (trimmed.length < 2) return trimmed

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\\\/g, "\\")
  }

  return trimmed
}

export function simplifyShellCommand(command: string): string {
  let current = command.trim()
  const wrapperRe =
    /^(?:\/usr\/bin\/env\s+)?(?:(?:\/[^\s]+\/)?(?:bash|zsh|sh))\s+-(?:l?c)\s+(.+)$/i

  // Strip nested shell wrappers like "/bin/zsh -lc bash -lc '<cmd>'".
  for (let i = 0; i < 6; i += 1) {
    const wrapped = current.match(wrapperRe)
    if (!wrapped) break
    const next = unwrapQuotedCommand(wrapped[1] ?? "").trim()
    if (!next || next === current) break
    current = next
  }

  return current
}

export function extractDisplayCommandFromToolInput(
  input: string | null | undefined
): string | null {
  if (!input) return null
  const parsed = tryParseJson(input)
  const command =
    (parsed ? commandFromUnknownValue(parsed) : null) ??
    extractCommandFromUnknownInput(input)
  if (!command) return null
  const simplified = simplifyShellCommand(command).trim()
  return simplified.length > 0 ? simplified : null
}

export function formatCommandPrompt(command: string): string {
  return command
    .split("\n")
    .map((line, index) => `${index === 0 ? "$" : ">"} ${line}`)
    .join("\n")
}

export function buildCommandTerminalOutput(
  command: string | null,
  output: string | null,
  isStreaming: boolean = false
): string {
  if (!command) return output ?? ""
  const prompt = formatCommandPrompt(command)
  const terminalOutput = output ?? ""
  const withTrailingNewline = (text: string): string =>
    text.endsWith("\n") ? text : `${text}\n`
  if (!terminalOutput) {
    return isStreaming ? withTrailingNewline(prompt) : prompt
  }

  const lines = terminalOutput.split("\n")
  const firstNonEmptyLine = lines.find((line) => line.trim().length > 0)
  const commandFirstLine = command.split("\n")[0]?.trim() ?? ""

  if (firstNonEmptyLine) {
    const trimmedLine = firstNonEmptyLine.trim()
    const lineWithoutPrompt = trimmedLine.replace(/^\$\s*/, "")
    if (
      trimmedLine === commandFirstLine ||
      lineWithoutPrompt === commandFirstLine
    ) {
      if (isStreaming && !terminalOutput.includes("\n")) {
        return withTrailingNewline(terminalOutput)
      }
      return terminalOutput
    }
  }

  return `${prompt}\n${terminalOutput}`
}

export function extractCommandFromUnknownInput(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === "string") {
      return parsed
    }
    if (Array.isArray(parsed)) {
      const parts = parsed.filter((p): p is string => typeof p === "string")
      if (parts.length > 0) return parts.join(" ")
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>
      const direct = obj.command ?? obj.cmd ?? obj.script
      if (typeof direct === "string") {
        return direct
      }
      if (Array.isArray(direct)) {
        const parts = direct.filter((p): p is string => typeof p === "string")
        if (parts.length > 0) return parts.join(" ")
      }
    }
  } catch {
    // Non-JSON command text is handled below.
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return null
  }
  return trimmed
}

export function commandFromUnknownValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === "string" ? item : null))
      .filter((item): item is string => item !== null && item.length > 0)
    if (parts.length > 0) {
      return parts.join(" ")
    }
    return null
  }

  if (!value || typeof value !== "object") {
    return null
  }

  const obj = value as Record<string, unknown>
  const directKeys = [
    "command",
    "cmd",
    "script",
    "args",
    "argv",
    "command_args",
  ]
  for (const key of directKeys) {
    const found = commandFromUnknownValue(obj[key])
    if (found) return found
  }

  const nestedKeys = ["input", "arguments", "params", "payload"]
  for (const key of nestedKeys) {
    const found = commandFromUnknownValue(obj[key])
    if (found) return found
  }

  return null
}

/** Get string field from parsed object */
export function str(
  obj: Record<string, unknown>,
  key: string
): string | undefined {
  const v = obj[key]
  return typeof v === "string" ? v : undefined
}

/** Get number field from parsed object */
export function num(
  obj: Record<string, unknown>,
  key: string
): number | undefined {
  const v = obj[key]
  return typeof v === "number" ? v : undefined
}

export type ApplyPatchOp = "add" | "update" | "delete" | "move"

export type ApplyPatchFile = {
  op: ApplyPatchOp
  path: string
  from?: string
  to?: string
}

export type LineChangeStats = {
  additions: number
  deletions: number
}

export function parseApplyPatchInput(input: string): {
  files: ApplyPatchFile[]
  additions: number
  deletions: number
} {
  const files: ApplyPatchFile[] = []
  let currentFileIndex = -1
  let additions = 0
  let deletions = 0

  for (const line of input.split("\n")) {
    if (line.startsWith("*** Add File: ")) {
      files.push({ op: "add", path: line.slice(14).trim() })
      currentFileIndex = files.length - 1
      continue
    }
    if (line.startsWith("*** Update File: ")) {
      files.push({ op: "update", path: line.slice(17).trim() })
      currentFileIndex = files.length - 1
      continue
    }
    if (line.startsWith("*** Delete File: ")) {
      files.push({ op: "delete", path: line.slice(17).trim() })
      currentFileIndex = files.length - 1
      continue
    }
    if (line.startsWith("*** Move to: ")) {
      const to = line.slice(13).trim()
      if (currentFileIndex >= 0) {
        const current = files[currentFileIndex]
        files[currentFileIndex] = {
          op: "move",
          path: `${current.path} -> ${to}`,
          from: current.path,
          to,
        }
      }
      continue
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1
      continue
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1
    }
  }

  return { files, additions, deletions }
}

export function hasLineChanges(
  stats: LineChangeStats | null | undefined
): stats is LineChangeStats {
  return !!stats && (stats.additions > 0 || stats.deletions > 0)
}

export function looksLikeDiffPayload(input: string): boolean {
  if (!input.trim()) return false
  const normalized = unescapeInlineEscapes(input)

  return (
    normalized.includes("*** Begin Patch") ||
    normalized.includes("*** Update File:") ||
    /^diff --git /m.test(normalized) ||
    (/^--- .+/m.test(normalized) && /^\+\+\+ .+/m.test(normalized)) ||
    /^@@ /m.test(normalized)
  )
}

export function extractEditLineChangeStats(
  input: string | null | undefined
): LineChangeStats | null {
  if (!input || input.trim().length === 0) return null

  const parsed = tryParseJson(input)
  const patchInput = extractApplyPatchTextFromUnknownInput(input, parsed)
  if (patchInput) {
    const patchStats = parseApplyPatchInput(patchInput)
    const stats = {
      additions: patchStats.additions,
      deletions: patchStats.deletions,
    }
    if (hasLineChanges(stats)) return stats
  }

  if (parsed) {
    const changesPayload = extractEditChangesPayload(parsed)
    if (changesPayload.length > 0) {
      let additions = 0
      let deletions = 0

      for (const change of changesPayload) {
        if (change.unifiedDiff && change.unifiedDiff.trim().length > 0) {
          const diffStats = countUnifiedDiffLineChanges(change.unifiedDiff)
          additions += diffStats.additions
          deletions += diffStats.deletions
          continue
        }

        const estimated = estimateChangedLineStats(
          change.oldText,
          change.newText
        )
        additions += estimated.additions
        deletions += estimated.deletions
      }

      const stats = { additions, deletions }
      if (hasLineChanges(stats)) return stats
    }

    if (isCanonicalEditPayload(parsed)) {
      const oldString =
        str(parsed, "old_string") ?? str(parsed, "old_text") ?? ""
      const newString =
        str(parsed, "new_string") ?? str(parsed, "new_text") ?? ""
      const stats = estimateChangedLineStats(oldString, newString)
      if (hasLineChanges(stats)) return stats
    }

    const parsedDiff =
      findStringFieldDeep(parsed, "unified_diff") ??
      findStringFieldDeep(parsed, "unifiedDiff") ??
      findStringFieldDeep(parsed, "patch") ??
      findStringFieldDeep(parsed, "diff")
    if (parsedDiff && looksLikeDiffPayload(parsedDiff)) {
      const stats = countUnifiedDiffLineChanges(
        unescapeInlineEscapes(parsedDiff)
      )
      if (hasLineChanges(stats)) return stats
    }
  }

  if (looksLikeDiffPayload(input)) {
    const stats = countUnifiedDiffLineChanges(unescapeInlineEscapes(input))
    if (hasLineChanges(stats)) return stats
  }

  return null
}

export function unescapeInlineEscapes(text: string): string {
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
}

export function extractApplyPatchTextFromUnknownInput(
  input: string,
  parsed: Record<string, unknown> | null
): string | null {
  const candidates: string[] = [input]
  const parsedCommand = parsed ? commandFromUnknownValue(parsed) : null
  if (parsedCommand) candidates.push(parsedCommand)

  const fallbackCommand = extractCommandFromUnknownInput(input)
  if (fallbackCommand) candidates.push(fallbackCommand)

  const seen = new Set<string>()

  for (const rawCandidate of candidates) {
    const candidate = rawCandidate.trim()
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)

    const variants = [candidate]
    const unescaped = unescapeInlineEscapes(candidate)
    if (unescaped !== candidate) variants.push(unescaped)

    for (const variant of variants) {
      if (!variant.includes("*** Begin Patch")) continue

      const block = variant.match(
        /(\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch(?:\n|$))/m
      )?.[1]

      if (block) return block.trim()
      return variant.trim()
    }
  }

  return null
}

export function parseApplyPatchFilesFromUnknownInput(
  input: string,
  parsed: Record<string, unknown> | null
): ApplyPatchFile[] {
  const patchText = extractApplyPatchTextFromUnknownInput(input, parsed)
  if (patchText) {
    const fromPatchText = parseApplyPatchInput(patchText)
    if (fromPatchText.files.length > 0) return fromPatchText.files
  }

  const direct = parseApplyPatchInput(input)
  if (direct.files.length > 0) return direct.files

  const unescaped = unescapeInlineEscapes(input)
  if (unescaped !== input) {
    const normalized = parseApplyPatchInput(unescaped)
    if (normalized.files.length > 0) return normalized.files
  }

  return []
}

export function isCanonicalEditPayload(
  parsed: Record<string, unknown>
): boolean {
  return (
    typeof parsed.file_path === "string" ||
    typeof parsed.path === "string" ||
    typeof parsed.old_string === "string" ||
    typeof parsed.new_string === "string" ||
    parsed.replace_all === true
  )
}

export type EditChangePreview = {
  path: string
  oldText: string
  newText: string
  unifiedDiff?: string
}

export const EDIT_CHANGE_OLD_KEYS = [
  "old_string",
  "oldString",
  "old_text",
  "oldText",
  "old",
  "previous",
  "before",
  "source",
  "original",
]

export const EDIT_CHANGE_NEW_KEYS = [
  "new_string",
  "newString",
  "new_text",
  "newText",
  "new_content",
  "newContent",
  "new",
  "new_value",
  "newValue",
  "replacement",
  "after",
  "after_text",
  "afterText",
  "updated",
  "updated_text",
  "updatedText",
  "content",
  "new_source",
  "newSource",
  "text",
]

export const EDIT_CHANGE_DIFF_KEYS = [
  "diff",
  "patch",
  "unified_diff",
  "unifiedDiff",
]

export function collectLikelyChangeStrings(
  value: Record<string, unknown>
): string[] {
  const entries = Object.entries(value).filter(
    ([, v]) => typeof v === "string" && v.length > 0
  ) as Array<[string, string]>
  if (entries.length === 0) return []

  const preferred = entries
    .filter(([key]) =>
      /(old|new|before|after|content|text|source|replace|value)/i.test(key)
    )
    .map(([, v]) => v)

  if (preferred.length > 0) return preferred

  return entries
    .filter(
      ([key]) =>
        !/^(id|status|type|call_id|callId|source|auto_approved)$/i.test(key)
    )
    .map(([, v]) => v)
}

export function firstStringField(
  value: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const field = value[key]
    if (typeof field === "string") {
      return field
    }
  }
  return null
}

export function parseEditChangeValue(
  path: string,
  value: unknown
): EditChangePreview | null {
  if (typeof value === "string") {
    return {
      path,
      oldText: "",
      newText: value,
    }
  }

  const record = asObjectLike(value)
  if (!record) return null

  const oldText =
    firstStringField(record, EDIT_CHANGE_OLD_KEYS) ??
    findStringFieldDeep(record, "old_string") ??
    findStringFieldDeep(record, "old_text") ??
    findStringFieldDeep(record, "before_text") ??
    findStringFieldDeep(record, "old") ??
    ""
  const newText =
    firstStringField(record, EDIT_CHANGE_NEW_KEYS) ??
    findStringFieldDeep(record, "new_string") ??
    findStringFieldDeep(record, "new_text") ??
    findStringFieldDeep(record, "after_text") ??
    findStringFieldDeep(record, "new") ??
    ""
  const unifiedDiff =
    firstStringField(record, EDIT_CHANGE_DIFF_KEYS) ??
    findStringFieldDeep(record, "diff") ??
    ""

  if (unifiedDiff) {
    return {
      path,
      oldText,
      newText,
      unifiedDiff,
    }
  }

  if (oldText || newText) {
    return {
      path,
      oldText,
      newText,
    }
  }

  const fallbackStrings = collectLikelyChangeStrings(record)
  if (fallbackStrings.length >= 2) {
    return {
      path,
      oldText: fallbackStrings[0],
      newText: fallbackStrings[1],
    }
  }

  if (fallbackStrings.length === 1) {
    return {
      path,
      oldText: "",
      newText: fallbackStrings[0],
    }
  }

  return {
    path,
    oldText: "",
    newText: "",
  }
}

export function extractEditChangesPayload(
  parsed: Record<string, unknown>
): EditChangePreview[] {
  const changes = findObjectFieldDeep(parsed, "changes")
  if (!changes) return []

  const items: EditChangePreview[] = []
  for (const [path, value] of Object.entries(changes)) {
    const normalizedPath = path.trim()
    if (!normalizedPath) continue
    const parsedItem = parseEditChangeValue(normalizedPath, value)
    if (parsedItem) {
      items.push(parsedItem)
    }
  }

  return items
}

// ── tool icon mapping ────────────────────────────────────────────────

// ── title derivation ──────────────────────────────────────────────────

/** 工具调用的一行标题（如 `Edit foo.ts`、命令摘要）；`toolName` 用 normalizeToolName 之后的名字。 */
export function deriveToolTitle(
  toolName: string,
  input: string | null,
  output?: string | null
): string | null {
  const name = toolName.toLowerCase()
  const titleSource = input ?? output ?? null
  if (!titleSource) return null
  const parsedInput = input ? tryParseJson(input) : null
  const parsedOutput = output ? tryParseJson(output) : null
  const parsed = parsedInput ?? parsedOutput

  const getField = (key: string): string | null => {
    const nested = findStringFieldDeep(parsed, key)
    if (nested) return nested
    if (input) {
      const fromInput = extractJsonField(input, key)
      if (fromInput) return fromInput
    }
    if (output) {
      const fromOutput = extractJsonField(output, key)
      if (fromOutput) return fromOutput
    }
    return null
  }

  // Cline: attempt_completion — show result summary as title
  if (name === "attempt_completion") {
    const result = getField("result")
    if (result) {
      const firstLine = result.split("\n")[0].trim()
      return `${ellipsis(firstLine, 80)}`
    }
    return "Completion"
  }

  // File-based tools
  const filePath =
    getField("file_path") ??
    getField("filePath") ??
    getField("target_file") ??
    getField("targetFile") ??
    getField("filename") ??
    getField("path") ??
    getField("notebook_path")
  if (filePath) {
    const sp = shortPath(filePath)
    if (name === "read" || name === "read file") return `Read ${sp}`
    if (name === "edit") return `Edit ${sp}`
    if (name === "write") return `Write ${sp}`
    if (name === "notebookedit") return `NotebookEdit ${sp}`
  }

  // Command tools
  if (name === "bash" || name === "exec_command") {
    const description = getField("description")
    if (description) {
      return ellipsis(description, 80)
    }
    const direct = getField("command") ?? getField("cmd") ?? getField("script")
    const parsedCommand = commandFromUnknownValue(parsed)
    const fallback = extractCommandFromUnknownInput(titleSource)
    const command = direct ?? parsedCommand ?? fallback
    if (command) {
      return ellipsis(simplifyShellCommand(command).split("\n")[0], 80)
    }
    return null
  }

  if (name === "apply_patch") {
    const files = parseApplyPatchFilesFromUnknownInput(titleSource, parsed)
    if (files.length === 0) return "Edit"
    if (files.length === 1) {
      const file = files[0]
      const targetPath =
        file.op === "move" && file.to
          ? file.to
          : (file.from ?? file.to ?? file.path)
      return `Edit ${shortPath(targetPath)}`
    }
    return `Edit (${files.length} files)`
  }

  if (name === "edit") {
    const patchFiles = parseApplyPatchFilesFromUnknownInput(titleSource, parsed)
    if (patchFiles.length === 1) {
      const file = patchFiles[0]
      const targetPath =
        file.op === "move" && file.to
          ? file.to
          : (file.from ?? file.to ?? file.path)
      return `Edit ${shortPath(targetPath)}`
    }
    if (patchFiles.length > 1) return `Edit (${patchFiles.length} files)`

    const changedPaths = extractEditPathsFromChangesPayload(titleSource, parsed)
    if (changedPaths.length === 1) return `Edit ${shortPath(changedPaths[0])}`
    if (changedPaths.length > 1) return `Edit (${changedPaths.length} files)`

    const diffPath = extractPathFromDiffText(output)
    if (diffPath) return `Edit ${shortPath(diffPath)}`
    return "Edit"
  }

  // Command-like fallback: if input looks like a shell command payload,
  // keep title behavior consistent with historical command tool rendering.
  const commandLike =
    (parsed ? commandFromUnknownValue(parsed) : null) ??
    extractCommandFromUnknownInput(titleSource)
  if (commandLike && commandLike.trim().length > 0) {
    return ellipsis(simplifyShellCommand(commandLike).split("\n")[0], 80)
  }

  // Search tools
  if (name === "glob") {
    const p = getField("pattern")
    if (p) return `Glob ${p}`
  }
  if (name === "grep") {
    const p = getField("pattern")
    if (p) return `Grep ${ellipsis(p, 50)}`
  }

  // Task / agent tools
  if (name === "task") {
    const subagent = getField("subagent_type")
    const desc = getField("description")
    const prefix = subagent ? `${subagent}: ` : ""
    if (desc) return `${prefix}${ellipsis(desc, 60 - prefix.length)}`
    if (subagent) return subagent
  }
  if (name === "agent") {
    const subagent = getField("subagent_type")
    const desc = getField("description")
    const prefix = subagent ? `${subagent}: ` : ""
    if (desc) return `${prefix}${ellipsis(desc, 60 - prefix.length)}`
    if (subagent) return subagent
  }
  if (name === "taskcreate") {
    const subj = getField("subject")
    if (subj) return `TaskCreate: ${ellipsis(subj, 50)}`
  }
  if (name === "taskupdate") {
    const id = getField("taskId")
    const status = getField("status")
    if (id) return `TaskUpdate #${id}${status ? ` → ${status}` : ""}`
  }

  // Web tools
  if (name === "webfetch") {
    const url = getField("url")
    if (url) return `WebFetch ${ellipsis(url, 60)}`
  }
  if (name === "websearch") {
    const q = getField("query")
    if (q) return `WebSearch: ${ellipsis(q, 50)}`
  }

  // TodoWrite
  if (name === "todowrite") {
    if (parsed) {
      const todos = parsed.todos
      if (Array.isArray(todos)) {
        const count = todos.length
        const done = todos.filter(
          (t: Record<string, unknown>) => t.status === "completed"
        ).length
        return `Todos (${done}/${count})`
      }
    }
    return "TodoWrite"
  }

  // Skill
  if (name === "skill") {
    const sk = getField("skill")
    if (sk) return `Skill: ${sk}`
  }

  // EnterPlanMode / ExitPlanMode / SwitchMode
  if (
    name === "enterplanmode" ||
    name === "exitplanmode" ||
    name === "switch_mode"
  ) {
    const plan = getField("plan")
    if (plan) {
      const firstLine = plan
        .split("\n")
        .map((l) => l.replace(/^#+\s*/, "").trim())
        .find((l) => l.length > 0)
      if (firstLine) return `Plan · ${ellipsis(firstLine, 60)}`
    }
    const title = getField("title")
    if (title) return `Plan · ${title}`
    return "Plan"
  }

  // Generic: try to show the first string field as context
  if (parsed) {
    for (const [k, v] of Object.entries(parsed)) {
      if (isLikelyIdField(k)) {
        continue
      }
      if (typeof v === "string" && v.length > 0) {
        return `${toolName}: ${ellipsis(v, 50)}`
      }
    }
  }

  return null
}
