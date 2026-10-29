import type { HTMLAttributes, ReactNode } from "react"
import type {
  SplitDirection,
  SplitPaneConstraint,
  SplitPaneGeometry,
} from "@/lib/workspace/split-view"
import type {
  SplitLayoutCommitReason,
  SplitLayoutTransaction,
} from "@/lib/workspace/split-layout-transaction"

export interface SplitPaneProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "id"
> {
  id?: string
  defaultSize?: number
  weight?: number
  order?: number
  minSize?: number
  maxSize?: number
  minSizePx?: number
  maxSizePx?: number
  collapsed?: boolean
  visible?: boolean
  collapsible?: boolean
  collapsedSizePx?: number
  children?: ReactNode
}

export interface SplitViewProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "onLayout"
> {
  direction?: SplitDirection
  onLayout?: (layout: number[]) => void
  onGeometry?: (
    geometry: readonly SplitPaneGeometry[],
    phase: "preview" | "commit" | "external"
  ) => void
  transaction?: SplitLayoutTransaction | null
  children?: ReactNode
}

export interface SplitHandleProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "onDrag" | "id"
> {
  id?: string
  disabled?: boolean
  onDragging?: (dragging: boolean) => void
  children?: ReactNode
}

export interface SplitViewHandle {
  setLayout: (
    layout: readonly number[],
    reason?: SplitLayoutCommitReason
  ) => void
  getLayout: () => number[]
}

export interface RegisteredPane {
  id: string
  sequence: number
  spec: SplitPaneConstraint
}

export interface RegisteredHandle {
  id: string
  sequence: number
  disabled: boolean
  onDragging?: (dragging: boolean) => void
}

export interface SplitSeparatorA11y {
  valueNow: number
  valueMin: number
  valueMax: number
  controls: string
}

export interface SplitViewContextValue {
  direction: SplitDirection
  layoutRevision: number
  getPaneSlot: (id: string) => number
  getHandleSlot: (id: string) => number
  registerPane: (pane: Omit<RegisteredPane, "sequence">) => void
  unregisterPane: (id: string) => void
  registerHandle: (handle: Omit<RegisteredHandle, "sequence">) => void
  unregisterHandle: (id: string) => void
  startPointerDrag: (
    id: string,
    element: HTMLElement,
    event: PointerEvent
  ) => void
  handleKeyDown: (id: string, event: KeyboardEvent) => void
  getHandleA11y: (id: string) => SplitSeparatorA11y | null
}
