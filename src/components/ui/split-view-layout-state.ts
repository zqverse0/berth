"use client"

import { useCallback, useMemo, useRef, type RefObject } from "react"
import {
  solveSplitLayout,
  type SplitDirection,
  type SplitPaneBounds,
  type SplitPaneConstraint,
  type SplitPaneGeometry,
} from "@/lib/workspace/split-view"
import type { SplitLayoutTransaction } from "@/lib/workspace/split-layout-transaction"
import { createSplitViewPointerGesture } from "./split-view-pointer-gesture"
import {
  useSplitViewLayoutGeometry,
  type SplitViewLayoutGeometryState,
} from "./split-view-layout-geometry"
import { handleSplitViewKeyboardResize } from "./split-view-keyboard-controller"
import {
  useSplitViewRegistrations,
  type SplitViewRegistrations,
} from "./split-view-registration"
import { getSplitSeparatorA11y } from "./split-view-separator-behavior"
import type {
  RegisteredHandle,
  SplitSeparatorA11y,
  SplitViewContextValue,
} from "./split-view-types"
import type { SplitGeometryPhase } from "./split-view-dom-renderer"

type SplitGeometryCallback = (
  geometry: readonly SplitPaneGeometry[],
  phase: SplitGeometryPhase
) => void

interface SplitViewLayoutStateOptions {
  direction: SplitDirection
  rootRef: RefObject<HTMLDivElement | null>
  onLayout?: (layout: number[]) => void
  onGeometry?: SplitGeometryCallback
  transaction: SplitLayoutTransaction | null
}

interface SplitViewLayoutState {
  context: SplitViewContextValue
  setLayout: SplitViewLayoutGeometryState["setLayout"]
  getLayout: SplitViewLayoutGeometryState["getLayout"]
}

interface ActiveSplitPointerGesture {
  lifecycle: ReturnType<typeof createSplitViewPointerGesture>
}

function getSplitViewPaneSpecs(
  paneRecordsRef: SplitViewRegistrations["paneRecordsRef"]
): SplitPaneConstraint[] {
  return paneRecordsRef.current.map((pane) => pane.spec)
}

function getSplitViewHandle(
  handleRecordsRef: SplitViewRegistrations["handleRecordsRef"],
  handleIndex: number
): RegisteredHandle | undefined {
  return handleRecordsRef.current[handleIndex]
}

export function useSplitViewLayoutState({
  direction,
  rootRef,
  onLayout,
  onGeometry,
  transaction,
}: SplitViewLayoutStateOptions): SplitViewLayoutState {
  const registrations = useSplitViewRegistrations()
  const activeGestureRef = useRef<ActiveSplitPointerGesture | null>(null)
  const cancelActiveGesture = useCallback(() => {
    activeGestureRef.current?.lifecycle.cancel()
  }, [])
  const geometry = useSplitViewLayoutGeometry({
    direction,
    rootRef,
    registrations,
    onLayout,
    onGeometry,
    transaction,
    cancelActiveGesture,
  })
  const {
    committedPercentages,
    commitResult,
    currentResultRef,
    directionRef,
    dragCrossSizeRef,
    getLayout,
    layoutRevision,
    restoreCommittedResult,
    restoreSizeByIdRef,
    setLayout,
    solveFrom,
    transactionRef,
    writeResult,
  } = geometry

  const completePointerGesture = useCallback(
    (element: HTMLElement, onDragging?: (dragging: boolean) => void) => {
      activeGestureRef.current = null
      element.removeAttribute("data-split-handle-state")
      dragCrossSizeRef.current = null
      onDragging?.(false)
    },
    [dragCrossSizeRef]
  )

  const startPointerDrag = useCallback(
    (id: string, element: HTMLElement, event: PointerEvent) => {
      if (event.button !== 0 || activeGestureRef.current) return
      const handleIndex = registrations.handleSlots.get(id)
      const result =
        currentResultRef.current ??
        solveFrom({ initialPercentages: committedPercentages() })
      const handle =
        handleIndex === undefined
          ? undefined
          : getSplitViewHandle(registrations.handleRecordsRef, handleIndex)
      if (
        handleIndex === undefined ||
        !handle ||
        handleIndex >= result.tracks.length - 1 ||
        handle.disabled
      ) {
        return
      }

      const startPosition =
        directionRef.current === "horizontal" ? event.clientX : event.clientY
      const initialSizes = [...result.sizes]
      const bounds: SplitPaneBounds[] = result.tracks.map((track) => track)
      const root = rootRef.current
      const rootRect = root?.getBoundingClientRect()
      dragCrossSizeRef.current =
        directionRef.current === "horizontal"
          ? rootRect?.height || root?.clientHeight || 0
          : rootRect?.width || root?.clientWidth || 0
      transactionRef.current?.beginPreview()
      handle.onDragging?.(true)
      element.dataset.splitHandleState = "drag"

      const lifecycle = createSplitViewPointerGesture({
        element,
        event,
        direction: directionRef.current,
        initialSizes,
        bounds,
        handleIndex,
        startPosition,
        onPreview: (sizes) => {
          const preview = solveSplitLayout({
            containerSize: result.containerSize,
            panes: getSplitViewPaneSpecs(registrations.paneRecordsRef),
            separatorSizes: result.separatorSizes,
            initialPixels: sizes,
          })
          currentResultRef.current = preview
          writeResult(preview, "preview")
        },
        onCommit: (sizes) => {
          const committed = solveSplitLayout({
            containerSize: result.containerSize,
            panes: getSplitViewPaneSpecs(registrations.paneRecordsRef),
            separatorSizes: result.separatorSizes,
            initialPixels: sizes,
          })
          commitResult(committed, "divider", true, committed.percentages)
        },
        onRestore: restoreCommittedResult,
        onCancel: () => transactionRef.current?.cancel(),
        onBeforeEnd: () => {
          activeGestureRef.current = null
        },
        onEnd: () => completePointerGesture(element, handle.onDragging),
      })
      activeGestureRef.current = { lifecycle }
    },
    [
      committedPercentages,
      commitResult,
      completePointerGesture,
      currentResultRef,
      directionRef,
      dragCrossSizeRef,
      registrations.handleRecordsRef,
      registrations.handleSlots,
      registrations.paneRecordsRef,
      restoreCommittedResult,
      rootRef,
      solveFrom,
      transactionRef,
      writeResult,
    ]
  )

  const handleKeyDown = useCallback(
    (id: string, event: KeyboardEvent) => {
      const handleIndex = registrations.handleSlots.get(id)
      const result =
        currentResultRef.current ??
        solveFrom({ initialPercentages: committedPercentages() })
      const handle =
        handleIndex === undefined
          ? undefined
          : getSplitViewHandle(registrations.handleRecordsRef, handleIndex)
      handleSplitViewKeyboardResize({
        direction: directionRef.current,
        result,
        handleIndex,
        handle,
        event,
        restoreSizeById: restoreSizeByIdRef.current,
        onResize: (nextSizes) => {
          transactionRef.current?.beginPreview()
          const next = solveFrom({ initialPixels: nextSizes })
          commitResult(next, "keyboard", true, next.percentages)
        },
      })
    },
    [
      committedPercentages,
      commitResult,
      currentResultRef,
      directionRef,
      registrations.handleRecordsRef,
      registrations.handleSlots,
      restoreSizeByIdRef,
      solveFrom,
      transactionRef,
    ]
  )

  const getHandleA11y = useCallback(
    (id: string): SplitSeparatorA11y | null => {
      const handleIndex = registrations.handleSlots.get(id)
      return getSplitSeparatorA11y(currentResultRef.current, handleIndex ?? -1)
    },
    [currentResultRef, registrations.handleSlots]
  )

  const context = useMemo<SplitViewContextValue>(
    () => ({
      direction,
      layoutRevision,
      getPaneSlot: (id) => registrations.paneSlots.get(id) ?? -1,
      getHandleSlot: (id) => registrations.handleSlots.get(id) ?? -1,
      registerPane: registrations.registerPane,
      unregisterPane: registrations.unregisterPane,
      registerHandle: registrations.registerHandle,
      unregisterHandle: registrations.unregisterHandle,
      startPointerDrag,
      handleKeyDown,
      getHandleA11y,
    }),
    [
      direction,
      getHandleA11y,
      handleKeyDown,
      layoutRevision,
      registrations.handleSlots,
      registrations.paneSlots,
      registrations.registerHandle,
      registrations.registerPane,
      registrations.unregisterHandle,
      registrations.unregisterPane,
      startPointerDrag,
    ]
  )

  return {
    context,
    setLayout,
    getLayout,
  }
}
