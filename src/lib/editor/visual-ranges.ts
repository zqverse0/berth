import type { Extension } from "@codemirror/state"
import { Decoration, EditorView } from "@codemirror/view"

export interface EditorLineRange {
  startLine: number
  endLine: number
}

export interface EditorLineMarker {
  line: number
  kind: "added" | "modified" | "deleted"
}

export function createVisualRangeExtension(
  hiddenRanges: readonly EditorLineRange[],
  lineMarkers: readonly EditorLineMarker[] = []
): Extension {
  if (!hiddenRanges.length && !lineMarkers.length) return []
  return EditorView.decorations.compute(["doc"], (state) => {
    const decorations = []
    for (const range of hiddenRanges) {
      const startLine = Math.min(Math.max(1, range.startLine), state.doc.lines)
      const endLine = Math.min(
        Math.max(startLine, range.endLine),
        state.doc.lines
      )
      const from = state.doc.line(startLine).from
      const line = state.doc.line(endLine)
      const to = line.to < state.doc.length ? line.to + 1 : line.to
      if (from < to) {
        decorations.push(Decoration.replace({ block: true }).range(from, to))
      }
    }
    for (const marker of lineMarkers) {
      if (marker.line < 1 || marker.line > state.doc.lines) continue
      decorations.push(
        Decoration.line({
          class: `cm-dirty-line cm-dirty-line-${marker.kind}`,
        }).range(state.doc.line(marker.line).from)
      )
    }
    return Decoration.set(decorations, true)
  })
}
