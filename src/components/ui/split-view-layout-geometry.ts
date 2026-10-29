"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react"
import {
  solveSplitLayout,
  type SplitDirection,
  type SplitLayoutResult,
  type SplitPaneGeometry,
} from "@/lib/workspace/split-view"
import type {
  SplitLayoutCommitReason,
  SplitLayoutTransaction,
} from "@/lib/workspace/split-layout-transaction"
import {
  createSplitViewDomRenderer,
  type SplitGeometryPhase,
} from "./split-view-dom-renderer"
import type { SplitViewRegistrations } from "./split-view-registration"
import { SPLIT_LAYOUT_EPSILON } from "./split-view-separator-behavior"

const SPLIT_SEPARATOR_PX = 1

interface SplitViewLayoutGeometryOptions {
  direction: SplitDirection
  rootRef: RefObject<HTMLDivElement | null>
  registrations: SplitViewRegistrations
  onLayout?: (layout: number[]) => void
  onGeometry?: (
    geometry: readonly SplitPaneGeometry[],
    phase: SplitGeometryPhase
  ) => void
  transaction: SplitLayoutTransaction | null
  cancelActiveGesture: () => void
}

export interface SplitViewLayoutGeometryState {
  layoutRevision: number
  currentResultRef: MutableRefObject<SplitLayoutResult | null>
  dragCrossSizeRef: MutableRefObject<number | null>
  restoreSizeByIdRef: MutableRefObject<Map<string, number>>
  directionRef: MutableRefObject<SplitDirection>
  transactionRef: MutableRefObject<SplitLayoutTransaction | null>
  solveFrom: (options?: {
    initialPixels?: readonly number[]
    initialPercentages?: readonly number[]
  }) => SplitLayoutResult
  committedPercentages: () => number[]
  writeResult: (
    result: SplitLayoutResult,
    phase: SplitGeometryPhase
  ) => readonly SplitPaneGeometry[]
  commitResult: (
    result: SplitLayoutResult,
    reason: SplitLayoutCommitReason,
    notifyLayout: boolean,
    fallback?: readonly number[]
  ) => void
  restoreCommittedResult: () => void
  setLayout: (
    layout: readonly number[],
    reason?: SplitLayoutCommitReason
  ) => void
  getLayout: () => number[]
}

function finiteSplitLayoutValue(
  value: number | undefined,
  fallback: number
): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback
}

function totalSplitLayoutValues(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function getSplitViewStructureKey(
  direction: SplitDirection,
  registrations: SplitViewRegistrations
): string {
  return `${direction}:${registrations.structureKey}`
}

function getSplitViewPaneSpecs(
  paneRecordsRef: SplitViewRegistrations["paneRecordsRef"]
) {
  return paneRecordsRef.current.map((pane) => pane.spec)
}

export function useSplitViewLayoutGeometry({
  direction,
  rootRef,
  registrations,
  onLayout,
  onGeometry,
  transaction,
  cancelActiveGesture,
}: SplitViewLayoutGeometryOptions): SplitViewLayoutGeometryState {
  const [layoutRevision, setLayoutRevision] = useState(0)
  const committedByIdRef = useRef(new Map<string, number>())
  const hasCommittedLayoutRef = useRef(false)
  const restorableLayoutRef = useRef<number[] | null>(null)
  const pendingLayoutRef = useRef<number[] | null>(null)
  const currentResultRef = useRef<SplitLayoutResult | null>(null)
  const committedResultRef = useRef<SplitLayoutResult | null>(null)
  const dragCrossSizeRef = useRef<number | null>(null)
  const restoreSizeByIdRef = useRef(new Map<string, number>())
  const onLayoutRef = useRef(onLayout)
  const onGeometryRef = useRef(onGeometry)
  const transactionRef = useRef(transaction)
  const directionRef = useRef(direction)
  const domRenderer = useMemo(() => createSplitViewDomRenderer(), [])

  onLayoutRef.current = onLayout
  onGeometryRef.current = onGeometry
  transactionRef.current = transaction
  directionRef.current = direction

  const axisSize = useCallback((): number => {
    const root = rootRef.current
    if (!root) return 0
    const rect = root.getBoundingClientRect()
    const measured =
      directionRef.current === "horizontal" ? rect.width : rect.height
    if (measured > 0) return measured
    return directionRef.current === "horizontal"
      ? root.clientWidth
      : root.clientHeight
  }, [rootRef])

  const separatorSizes = useCallback((): number[] => {
    const panes = registrations.paneRecordsRef.current
    const handles = registrations.handleRecordsRef.current
    return Array.from({ length: Math.max(0, panes.length - 1) }, (_, index) =>
      handles[index] && !handles[index].disabled ? SPLIT_SEPARATOR_PX : 0
    )
  }, [registrations.handleRecordsRef, registrations.paneRecordsRef])

  const solveFrom = useCallback(
    (
      options: {
        initialPixels?: readonly number[]
        initialPercentages?: readonly number[]
      } = {}
    ): SplitLayoutResult =>
      solveSplitLayout({
        containerSize: axisSize(),
        panes: getSplitViewPaneSpecs(registrations.paneRecordsRef),
        separatorSizes: separatorSizes(),
        ...options,
      }),
    [axisSize, registrations.paneRecordsRef, separatorSizes]
  )

  const committedPercentages = useCallback((): number[] => {
    const pending = pendingLayoutRef.current
    if (pending) {
      return registrations.paneRecordsRef.current.map((_, index) =>
        finiteSplitLayoutValue(pending[index], 0)
      )
    }
    return registrations.paneRecordsRef.current.map((pane) => {
      const remembered = committedByIdRef.current.get(pane.id)
      if (remembered !== undefined) return remembered
      return finiteSplitLayoutValue(pane.spec.defaultSize, 0)
    })
  }, [registrations.paneRecordsRef])

  const writeResult = useCallback(
    (result: SplitLayoutResult, phase: SplitGeometryPhase) =>
      domRenderer.writeResult({
        root: rootRef.current,
        direction: directionRef.current,
        result,
        phase,
        crossSize: dragCrossSizeRef.current,
        onGeometry: onGeometryRef.current,
      }),
    [domRenderer, rootRef]
  )

  const rememberCommitted = useCallback(
    (result: SplitLayoutResult, fallback: readonly number[]) => {
      const resultTotal = totalSplitLayoutValues(result.percentages)
      const percentages =
        resultTotal > SPLIT_LAYOUT_EPSILON
          ? result.percentages
          : registrations.paneRecordsRef.current.map((_, index) =>
              finiteSplitLayoutValue(fallback[index], 0)
            )
      for (const [
        index,
        pane,
      ] of registrations.paneRecordsRef.current.entries()) {
        committedByIdRef.current.set(pane.id, percentages[index] ?? 0)
      }
    },
    [registrations.paneRecordsRef]
  )

  const commitResult = useCallback(
    (
      result: SplitLayoutResult,
      reason: SplitLayoutCommitReason,
      notifyLayout: boolean,
      fallback: readonly number[] = result.percentages
    ) => {
      currentResultRef.current = result
      committedResultRef.current = result
      hasCommittedLayoutRef.current = true
      rememberCommitted(result, fallback)
      if (
        (reason === "divider" || reason === "keyboard") &&
        result.sizes.every((size) => size > SPLIT_LAYOUT_EPSILON)
      ) {
        restorableLayoutRef.current = [...result.percentages]
      }
      const geometry = writeResult(
        result,
        reason === "divider" || reason === "keyboard" ? "commit" : "external"
      )
      transactionRef.current?.commit({ geometry, reason })
      setLayoutRevision((revision) => revision + 1)
      if (notifyLayout) {
        onLayoutRef.current?.(
          registrations.paneRecordsRef.current.map(
            (pane) => committedByIdRef.current.get(pane.id) ?? 0
          )
        )
      }
    },
    [registrations.paneRecordsRef, rememberCommitted, writeResult]
  )

  const restoreCommittedResult = useCallback(() => {
    const result =
      committedResultRef.current ??
      solveFrom({ initialPercentages: committedPercentages() })
    currentResultRef.current = result
    writeResult(result, "external")
  }, [committedPercentages, solveFrom, writeResult])

  const setLayout = useCallback(
    (
      layout: readonly number[],
      reason: SplitLayoutCommitReason = "external-resize"
    ) => {
      cancelActiveGesture()
      let requested = registrations.paneRecordsRef.current.map((_, index) =>
        finiteSplitLayoutValue(layout[index], 0)
      )
      hasCommittedLayoutRef.current = true
      if (
        reason === "maximize" &&
        currentResultRef.current?.sizes.every(
          (size) => size > SPLIT_LAYOUT_EPSILON
        )
      ) {
        restorableLayoutRef.current = [
          ...(currentResultRef.current?.percentages ?? []),
        ]
      }
      if (reason === "restore" && restorableLayoutRef.current) {
        requested = registrations.paneRecordsRef.current.map((_, index) =>
          finiteSplitLayoutValue(restorableLayoutRef.current?.[index], 0)
        )
      }
      pendingLayoutRef.current = requested
      if (registrations.paneRecordsRef.current.length === 0) return
      const result = solveFrom({ initialPercentages: requested })
      pendingLayoutRef.current = null
      currentResultRef.current = result
      committedResultRef.current = result
      rememberCommitted(result, requested)
      transactionRef.current?.beginPreview()
      const geometry = writeResult(
        result,
        reason === "divider" || reason === "keyboard" ? "commit" : "external"
      )
      transactionRef.current?.commit({ geometry, reason })
      setLayoutRevision((revision) => revision + 1)
    },
    [
      cancelActiveGesture,
      registrations.paneRecordsRef,
      rememberCommitted,
      solveFrom,
      writeResult,
    ]
  )

  const getLayout = useCallback(() => {
    const result = currentResultRef.current
    if (
      result &&
      totalSplitLayoutValues(result.percentages) > SPLIT_LAYOUT_EPSILON
    ) {
      return registrations.paneRecordsRef.current.map(
        (pane) => committedByIdRef.current.get(pane.id) ?? 0
      )
    }
    return committedPercentages()
  }, [committedPercentages, registrations.paneRecordsRef])

  const structureKey = getSplitViewStructureKey(direction, registrations)

  useLayoutEffect(() => {
    if (registrations.paneRecordsRef.current.length === 0) return
    const requested = pendingLayoutRef.current
    const useDefaults = !hasCommittedLayoutRef.current
    const percentages = registrations.paneRecordsRef.current.map(
      (pane, index) => {
        if (requested?.[index] !== undefined) return requested[index]
        if (useDefaults) return finiteSplitLayoutValue(pane.spec.defaultSize, 0)
        return (
          committedByIdRef.current.get(pane.id) ??
          finiteSplitLayoutValue(pane.spec.defaultSize, 0)
        )
      }
    )
    const result = solveFrom({ initialPercentages: percentages })
    pendingLayoutRef.current = null
    currentResultRef.current = result
    committedResultRef.current = result
    rememberCommitted(result, percentages)
    writeResult(result, "external")
    setLayoutRevision((revision) => revision + 1)
  }, [
    registrations.paneRecordsRef,
    rememberCommitted,
    solveFrom,
    structureKey,
    writeResult,
  ])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const updateForExternalGeometry = () => {
      cancelActiveGesture()
      const result = solveFrom({ initialPercentages: committedPercentages() })
      currentResultRef.current = result
      writeResult(result, "external")
    }
    updateForExternalGeometry()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(updateForExternalGeometry)
    observer.observe(root)
    return () => observer.disconnect()
  }, [
    cancelActiveGesture,
    committedPercentages,
    rootRef,
    solveFrom,
    structureKey,
    writeResult,
  ])

  useEffect(() => () => cancelActiveGesture(), [cancelActiveGesture])

  return {
    layoutRevision,
    currentResultRef,
    dragCrossSizeRef,
    restoreSizeByIdRef,
    directionRef,
    transactionRef,
    solveFrom,
    committedPercentages,
    writeResult,
    commitResult,
    restoreCommittedResult,
    setLayout,
    getLayout,
  }
}
