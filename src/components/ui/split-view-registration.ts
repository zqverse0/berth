"use client"

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react"
import type { RegisteredHandle, RegisteredPane } from "./split-view-types"

function orderPanes(panes: readonly RegisteredPane[]): RegisteredPane[] {
  return [...panes].sort((left, right) => {
    const leftOrder = left.spec.order ?? left.sequence
    const rightOrder = right.spec.order ?? right.sequence
    return leftOrder - rightOrder || left.sequence - right.sequence
  })
}

function orderHandles(
  handles: readonly RegisteredHandle[]
): RegisteredHandle[] {
  return [...handles].sort((left, right) => left.sequence - right.sequence)
}

export interface SplitViewRegistrations {
  orderedPanes: RegisteredPane[]
  orderedHandles: RegisteredHandle[]
  paneRecordsRef: MutableRefObject<RegisteredPane[]>
  handleRecordsRef: MutableRefObject<RegisteredHandle[]>
  paneSlots: Map<string, number>
  handleSlots: Map<string, number>
  structureKey: string
  registerPane: (pane: Omit<RegisteredPane, "sequence">) => void
  unregisterPane: (id: string) => void
  registerHandle: (handle: Omit<RegisteredHandle, "sequence">) => void
  unregisterHandle: (id: string) => void
}

/** 维护声明层 pane/handle 的顺序、槽位和生命周期，不参与尺寸求解。 */
export function useSplitViewRegistrations(): SplitViewRegistrations {
  const [registeredPanes, setRegisteredPanes] = useState<RegisteredPane[]>([])
  const [registeredHandles, setRegisteredHandles] = useState<
    RegisteredHandle[]
  >([])
  const paneSequenceRef = useRef(0)
  const handleSequenceRef = useRef(0)
  const paneRecordsRef = useRef<RegisteredPane[]>([])
  const handleRecordsRef = useRef<RegisteredHandle[]>([])

  const registerPane = useCallback((pane: Omit<RegisteredPane, "sequence">) => {
    const previous = paneRecordsRef.current
    const index = previous.findIndex((candidate) => candidate.id === pane.id)
    let next: RegisteredPane[]
    if (index < 0) {
      next = [...previous, { ...pane, sequence: paneSequenceRef.current++ }]
    } else {
      const current = previous[index]
      if (
        current.spec === pane.spec ||
        JSON.stringify(current.spec) === JSON.stringify(pane.spec)
      ) {
        return
      }
      next = [...previous]
      next[index] = { ...pane, sequence: current.sequence }
    }
    const ordered = orderPanes(next)
    paneRecordsRef.current = ordered
    setRegisteredPanes(ordered)
  }, [])

  const unregisterPane = useCallback((id: string) => {
    const previous = paneRecordsRef.current
    const next = previous.filter((pane) => pane.id !== id)
    if (next.length === previous.length) return
    const ordered = orderPanes(next)
    paneRecordsRef.current = ordered
    setRegisteredPanes(ordered)
  }, [])

  const registerHandle = useCallback(
    (handle: Omit<RegisteredHandle, "sequence">) => {
      const previous = handleRecordsRef.current
      const index = previous.findIndex(
        (candidate) => candidate.id === handle.id
      )
      let next: RegisteredHandle[]
      if (index < 0) {
        next = [
          ...previous,
          { ...handle, sequence: handleSequenceRef.current++ },
        ]
      } else {
        const current = previous[index]
        if (
          current.disabled === handle.disabled &&
          current.onDragging === handle.onDragging
        ) {
          return
        }
        next = [...previous]
        next[index] = { ...handle, sequence: current.sequence }
      }
      const ordered = orderHandles(next)
      handleRecordsRef.current = ordered
      setRegisteredHandles(ordered)
    },
    []
  )

  const unregisterHandle = useCallback((id: string) => {
    const previous = handleRecordsRef.current
    const next = previous.filter((handle) => handle.id !== id)
    if (next.length === previous.length) return
    const ordered = orderHandles(next)
    handleRecordsRef.current = ordered
    setRegisteredHandles(ordered)
  }, [])

  const orderedPanes = useMemo(
    () => orderPanes(registeredPanes),
    [registeredPanes]
  )
  const orderedHandles = useMemo(
    () => orderHandles(registeredHandles),
    [registeredHandles]
  )

  // 注意：paneRecordsRef/handleRecordsRef 只由 registerPane/unregisterPane/
  // registerHandle/unregisterHandle 写入——它们同步写 ref 并排队同一值的
  // state 更新，两份数据因此保持一致。不要加"用 state 覆写 ref"的同步
  // effect：React 的 layout effect 是子先父后，mount 时子组件已把 ref
  // 写满而 state 尚未 flush，那样的 effect 会用空 state 清空 ref，随后
  // 基于空 ref 的 register 会覆盖排队中的正确注册表（aux 面板刷新后
  // 布局纵向堆叠的根因，见 split-view-hydration-regression.test.tsx）。

  const paneSlots = useMemo(
    () => new Map(orderedPanes.map((pane, index) => [pane.id, index])),
    [orderedPanes]
  )
  const handleSlots = useMemo(
    () => new Map(orderedHandles.map((handle, index) => [handle.id, index])),
    [orderedHandles]
  )
  const structureKey = `${orderedPanes
    .map((pane) => `${pane.id}:${JSON.stringify(pane.spec)}`)
    .join("|")}:${orderedHandles
    .map((handle) => `${handle.id}:${handle.disabled}`)
    .join("|")}`

  return {
    orderedPanes,
    orderedHandles,
    paneRecordsRef,
    handleRecordsRef,
    paneSlots,
    handleSlots,
    structureKey,
    registerPane,
    unregisterPane,
    registerHandle,
    unregisterHandle,
  }
}
