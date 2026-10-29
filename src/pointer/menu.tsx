"use client"

import type { PointerSelection } from "./types"

export function pointerMenuItems(selection: PointerSelection): {
  copyContent: boolean
  copySource: boolean
  translate: boolean
  editor: boolean
} {
  const hasText = Boolean(selection.excerpt.trim())
  return {
    copyContent: hasText,
    copySource: Boolean(hasText && selection.source),
    translate: hasText,
    editor: selection.editable,
  }
}
