/**
 * Human labels for terminal tabs / descriptors.
 *
 * Wire identity stays `terminalId` (RMUX window name). Display prefers an
 * explicit title, then shell/command basename + cwd basename — never a bare
 * UUID when path/command context exists.
 */

export function looksLikeTerminalId(value: string | null | undefined): boolean {
  if (!value) return false
  const trimmed = value.trim()
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      trimmed
    )
  ) {
    return true
  }
  return /^[0-9a-f]{32}$/i.test(trimmed)
}

function basename(path: string | null | undefined): string | null {
  if (!path) return null
  const trimmed = path.trim().replace(/[/\\]+$/, "")
  if (!trimmed) return null
  const parts = trimmed.split(/[/\\]/)
  const name = parts[parts.length - 1]?.trim()
  return name || null
}

function shortProcessName(value: string | null | undefined): string | null {
  const name = basename(value)
  if (!name) return null
  return name.replace(/^["']|["']$/g, "") || null
}

export interface ReadableTerminalTitleInput {
  title?: string | null
  shell?: string | null
  initialCwd?: string | null
  terminalId?: string | null
}

/** Resolve the label shown in GUI tab strips and sidebars. */
export function readableTerminalTitle(
  input: ReadableTerminalTitleInput
): string {
  const title = input.title?.trim() || ""
  const terminalId = input.terminalId?.trim() || ""

  if (title && !looksLikeTerminalId(title) && title !== terminalId) {
    return title
  }
  if (title && !looksLikeTerminalId(title)) {
    return title
  }

  const process = shortProcessName(input.shell)
  const dir = basename(input.initialCwd)
  if (process && dir && process !== dir) return `${process} · ${dir}`
  if (process) return process
  if (dir) return dir
  return "Terminal"
}
