"use client"

import type { ReactNode } from "react"
import { motion } from "motion/react"
import { X } from "lucide-react"
import { cn, handleMiddleClickClose } from "@/lib/utils"
import { StatusDot, type StatusDotKind } from "@/components/ui/status-dot"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { startWorkspaceTabDrag } from "@/hooks/workspace/workspace-tab-drag-controller"
import {
  workspaceTabKey,
  type WorkspaceTabRef,
} from "@/lib/workspace/workspace-tab-placement"

interface WorkspaceTabShellProps {
  /** Omit to make the tab non-draggable (global tabs). */
  dragRef?: WorkspaceTabRef
  /** Identity attributes (`data-tab-id` / `data-file-tab-id` / …) used by hit-tests and scroll-into-view. */
  dataAttributes: Record<`data-${string}`, string>
  active: boolean
  /** Whether this tab immediately precedes/follows the active tab. With a
   *  workspace background image the active tab's transparent reverse-corner foot
   *  flares 0.5rem over this neighbour; the strip drives this so the neighbour can
   *  inset its baseline to meet the foot instead of poking a stub under it. */
  adjacentActive?: "before" | "after"
  /** Icon-only 40px badge (agent / terminal tabs). */
  compact?: boolean
  /** 宽度随内容（固定在条首、不可关的 tab，如「群组」）：不参与等宽挤压。 */
  fit?: boolean
  /** 左上角状态点（已按优先级取好一个）；null 不显示。 */
  status?: StatusDotKind | null
  icon: ReactNode
  label: ReactNode
  title?: string
  ariaLabel?: string
  closeLabel: string
  onSelect: () => void
  /** Omit to make the tab non-closable. */
  onClose?: () => void
  onDoubleClick?: () => void
  /** 标签内尾部的小按钮（全部标签、新建）；点击不触发选中。 */
  actions?: ReactNode
  /** Context-menu items; omit for no menu. */
  menu?: ReactNode
}

/** Shared browser-style chrome for every workspace tab kind. */
export function WorkspaceTabShell({
  dragRef,
  dataAttributes,
  active,
  adjacentActive,
  compact = false,
  fit = false,
  status = null,
  icon,
  label,
  title,
  ariaLabel,
  closeLabel,
  onSelect,
  onClose,
  onDoubleClick,
  actions,
  menu,
}: WorkspaceTabShellProps) {
  const tab = (
    <div
      role="tab"
      aria-selected={active}
      aria-label={ariaLabel}
      title={title}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      onMouseDown={
        onClose ? (event) => handleMiddleClickClose(event, onClose) : undefined
      }
      className={cn(
        "group/tab relative flex items-center h-full gap-1.5 text-xs",
        "cursor-pointer select-none transition-colors",
        compact && "justify-center",
        // Browser-style tab: seats against the shaded strip with a
        // white (bg-background) active fill and a rounded top, reaching
        // the strip's bottom so it merges into the detail header below.
        // With a workspace background image on, the whole strip + all
        // tabs go transparent (reveal the image); a hairline bottom
        // border (ws-strip-line) runs under every non-active region
        // while the active tab omits it and instead is outlined by a
        // top+side "archway" (the browser-tab-item `::after`, globals.css)
        // whose reverse-corner feet (browser-tab-seat) drop back onto
        // that line — so the active tab is a gap the border detours
        // around, not a filled box. `overflow-hidden` clips the shrunken
        // row so a tight tab can't paint/click over its neighbor.
        // `pb-1.5` balances the group's `pt-1.5` gap so the content
        // centers on the h-10 strip's midline. `browser-tab-content` is
        // the hover anchor for the label's state-driven fade (globals.css
        // `.browser-tab-content:hover` widens the mask so the close
        // button never covers the title).
        "browser-tab-content w-full min-w-0 overflow-hidden rounded-t-lg px-2 pb-1.5",
        compact && "!px-0",
        // 不可关：不给关闭按钮预留右侧（globals.css 激活 tab 的 padding-right）。
        fit && "!pr-3",
        active
          ? "bg-background ws-transparent-bg text-foreground"
          : "isolate browser-tab-hover text-muted-foreground hover:text-foreground ws-strip-line"
      )}
    >
      {status && <StatusDot kind={status} className="left-1 top-1" />}
      {icon}
      {!compact && label != null && (
        // Grows + shrinks with the tab; the overflowing title fades out on
        // the right (browser-tab-label mask) toward the close button.
        <span
          className={cn(
            "whitespace-nowrap",
            !fit && "min-w-0 flex-1 overflow-hidden browser-tab-label"
          )}
        >
          {label}
        </span>
      )}
      {actions != null && (
        <span
          className="flex shrink-0 items-center gap-0.5"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {actions}
        </span>
      )}
      {onClose && (
        <button
          type="button"
          className={cn(
            "rounded-md hover:bg-foreground/10",
            // Compact tabs keep their icon when active; close is a small
            // hover-only corner badge so clicking the tab body never closes it.
            // Otherwise an absolute overlay pinned to the right edge, claiming
            // no row space (no transform → crisp on WebKit; `bottom-1.5`
            // mirrors the content's `pb-1.5`).
            compact
              ? "absolute right-0 top-0.5 flex h-3.5 w-3.5 items-center justify-center"
              : "absolute right-2 top-0 bottom-1.5 my-auto flex h-4 w-4 items-center justify-center",
            // Hidden close buttons gate pointer events so they can't eat clicks.
            active && !compact
              ? "opacity-100"
              : "opacity-0 pointer-events-none group-hover/tab:opacity-100 group-hover/tab:pointer-events-auto"
          )}
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
          aria-label={closeLabel}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )

  return (
    // `layout="position"` slides tabs aside as a drag gap opens or closes;
    // the drag itself is `workspace-tab-drag-controller` (a ghost follows the
    // pointer, this element is swapped for a gap).
    <motion.div
      layout="position"
      transition={{ duration: 0.15, ease: "easeOut" }}
      {...dataAttributes}
      data-workspace-tab-key={dragRef ? workspaceTabKey(dragRef) : undefined}
      onPointerDown={
        dragRef ? (event) => startWorkspaceTabDrag(event, dragRef) : undefined
      }
      data-tab-item
      data-agent-tab={compact ? "true" : undefined}
      data-active={active ? "true" : undefined}
      data-adjacent-active={adjacentActive}
      className={cn(
        dragRef && "cursor-grab active:cursor-grabbing",
        // Compact tabs are fixed 40px badges; other tabs share equal width
        // (`basis-48`, `grow-0`) and `shrink` together (down to `min-w-24`, the
        // label fades; past that the strip scrolls) once the row fills. Tabs sit flush; `browser-tab-item`
        // draws the hairline separator (globals.css). The active tab is raised
        // (`z-10`) so its reverse-corner seat is never covered by a hovered
        // neighbour's flare.
        "browser-tab-item grow-0 data-[active=true]:z-10",
        compact
          ? "shrink-0 basis-10 w-10"
          : fit
            ? "shrink-0"
            : "min-w-24 shrink basis-48"
      )}
    >
      {/* Reverse (concave) bottom corners — the browser-tab seat (globals.css).
          Decorative; CSS reveals it when the tab is active or hovered. */}
      <span aria-hidden className="browser-tab-seat" />
      {menu ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{tab}</ContextMenuTrigger>
          <ContextMenuContent>{menu}</ContextMenuContent>
        </ContextMenu>
      ) : (
        tab
      )}
    </motion.div>
  )
}
