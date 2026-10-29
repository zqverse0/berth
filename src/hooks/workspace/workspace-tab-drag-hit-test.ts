import type { WorkspacePane } from "@/lib/workspace/workspace-tab-placement"

/**
 * Resolve which workspace pane is under a pointer, for cross-pane tab drops.
 * Tab strips and content areas (`WorkspacePaneDropArea`) are both targets.
 *
 * The empty tab-strip filler is intentionally a Tauri window-drag region so
 * users can still move the window. That chrome must not swallow pane hit-tests
 * during tab drags. The dragging tab itself also follows the pointer and would
 * otherwise pin the source pane forever, so tab chrome is skipped and the stack
 * underneath is used instead.
 */
export function paneAtPoint(
  clientX: number,
  clientY: number,
  doc: Document = document
): WorkspacePane | null {
  const stack =
    typeof doc.elementsFromPoint === "function"
      ? doc.elementsFromPoint(clientX, clientY)
      : ([doc.elementFromPoint(clientX, clientY)].filter(Boolean) as Element[])

  for (const raw of stack) {
    if (!(raw instanceof Element)) continue

    // Explicit strip drop target wins even when it overlays window-drag chrome.
    const dropTarget = raw.closest<HTMLElement>(
      "[data-workspace-tab-drop-target]"
    )
    if (dropTarget) {
      const dropPane = readPane(
        dropTarget.closest<HTMLElement>("[data-workspace-pane]")
      )
      if (dropPane) return dropPane
    }

    // Skip the tab being dragged (and any other tab chrome under the cursor)
    // so the pane underneath can accept the drop.
    if (
      raw.closest("[data-tab-item]") ||
      raw.closest("[data-file-tab-id]") ||
      raw.closest("[role='tab']")
    ) {
      continue
    }

    // Skip pure window-drag chrome, but keep walking the stack so the parent
    // pane / content host underneath still counts.
    if (raw.closest("[data-tauri-drag-region]")) {
      continue
    }

    const paneElement = raw.closest<HTMLElement>("[data-workspace-pane]")
    const pane = readPane(paneElement)
    if (!pane) continue
    // The right third of an unsplit main area proposes a new split group.
    if (paneElement?.hasAttribute("data-workspace-split-zone")) {
      const rect = paneElement.getBoundingClientRect()
      if (rect.width > 0 && clientX >= rect.left + (rect.width * 2) / 3) {
        return "files-split"
      }
    }
    return pane
  }

  return null
}

function readPane(element: HTMLElement | null): WorkspacePane | null {
  const pane = element?.getAttribute("data-workspace-pane")
  return pane === "conversation" || pane === "files" || pane === "files-split"
    ? pane
    : null
}
