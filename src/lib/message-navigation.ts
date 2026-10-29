import type { FileChangeStat } from "@/lib/agent/session-files"

/** One navigable user message in the active conversation. */
export interface MessageNavEntry {
  /** Index into the rendered thread items, fed to `scrollToIndex`. */
  threadIndex: number
  turnId: string
  /** 1-based position among the visible user messages. */
  ordinal: number
  label: string
  additions: number
  deletions: number
  files: FileChangeStat[]
  hasChanges: boolean
}
