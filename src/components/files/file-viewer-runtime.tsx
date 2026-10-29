"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  fileViewerDefinitionFromTab,
  type FileViewerDefinition,
  type FileViewerKind,
  type FileViewerToolbarState,
} from "@/lib/files/file-viewer-definition"
import type { FileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { fileTabsForFolderScope } from "@/lib/workspace/tab-scope"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"

interface RegisteredController {
  tabId: string
  controller: FileViewerToolbarState
  revision: number
}

export interface FileViewerRuntimeValue {
  tab: FileWorkspaceTab | null
  definition: FileViewerDefinition | null
  controller: FileViewerToolbarState | null
  /** 可变 controller 快照的单调递增渲染信号。 */
  controllerRevision: number
  registerController: (controller: FileViewerToolbarState) => void
  updateController: (controller: FileViewerToolbarState) => void
  unregisterController: (controller: FileViewerToolbarState) => void
}

const FileViewerRuntimeContext = createContext<FileViewerRuntimeValue | null>(
  null
)

/**
 * 一个稳定文件 Surface 的局部桥接层。动态 Viewer 状态仍归 Viewer 所有，
 * Context 只向顶部 Header 传递 controller 引用。
 */
export function FileViewerRuntimeProvider({
  tabId,
  children,
}: {
  tabId?: string
  children: ReactNode
}) {
  const fileTabs = useWorkspaceFileStore((state) => state.fileTabs)
  const activeFileTabId = useWorkspaceFileStore(
    (state) => state.activeFileTabId
  )
  const { activeFolderId } = useActiveFolder()
  const allFolders = useAppWorkspaceStore((state) => state.allFolders)
  const visibleFileTabs = useMemo(
    () => fileTabsForFolderScope(fileTabs, activeFolderId, allFolders),
    [activeFolderId, allFolders, fileTabs]
  )
  const tab = useMemo(
    () =>
      (tabId
        ? fileTabs.find((candidate) => candidate.id === tabId)
        : visibleFileTabs.find(
            (candidate) => candidate.id === activeFileTabId
          )) ?? null,
    [activeFileTabId, fileTabs, tabId, visibleFileTabs]
  )
  const definition = useMemo(
    () => (tab ? fileViewerDefinitionFromTab(tab) : null),
    [tab]
  )
  const currentTabId = tab?.id ?? tabId ?? ""
  const [registered, setRegistered] = useState<RegisteredController | null>(
    null
  )

  const registerController = useCallback(
    (controller: FileViewerToolbarState) => {
      if (!currentTabId || controller.kind !== definition?.kind) return
      setRegistered((previous) => {
        if (
          previous?.tabId === currentTabId &&
          previous.controller === controller
        ) {
          return previous
        }
        return { tabId: currentTabId, controller, revision: 0 }
      })
    },
    [currentTabId, definition?.kind]
  )
  const updateController = useCallback(
    (controller: FileViewerToolbarState) => {
      setRegistered((previous) => {
        if (
          !previous ||
          previous.tabId !== currentTabId ||
          previous.controller !== controller
        ) {
          return previous
        }
        return { ...previous, revision: previous.revision + 1 }
      })
    },
    [currentTabId]
  )
  const unregisterController = useCallback(
    (controller: FileViewerToolbarState) => {
      setRegistered((previous) =>
        previous?.controller === controller ? null : previous
      )
    },
    []
  )

  const controller =
    registered?.tabId === currentTabId &&
    registered.controller.kind === definition?.kind
      ? registered.controller
      : null
  // controller 对象保持稳定；revision 只作为 Header 观察字段更新的渲染信号。
  const controllerRevision = registered?.revision ?? 0
  const value = useMemo<FileViewerRuntimeValue>(
    () => ({
      tab,
      definition,
      controller,
      controllerRevision,
      registerController,
      updateController,
      unregisterController,
    }),
    [
      controller,
      controllerRevision,
      definition,
      registerController,
      tab,
      unregisterController,
      updateController,
    ]
  )

  return (
    <FileViewerRuntimeContext.Provider value={value}>
      {children}
    </FileViewerRuntimeContext.Provider>
  )
}

export function useOptionalFileViewerRuntime(): FileViewerRuntimeValue | null {
  return useContext(FileViewerRuntimeContext)
}

export function useFileViewerRuntime(): FileViewerRuntimeValue {
  const runtime = useOptionalFileViewerRuntime()
  if (!runtime) {
    throw new Error(
      "useFileViewerRuntime must be used within FileViewerRuntimeProvider"
    )
  }
  return runtime
}

/** 比较会影响 Header 绘制的 controller 字段，忽略对象包装本身的变化。 */
function sameToolbarController(
  left: FileViewerToolbarState,
  right: FileViewerToolbarState
): boolean {
  if (left.kind !== right.kind) return false

  const leftZoom = left.zoom
  const rightZoom = right.zoom
  if (Boolean(leftZoom) !== Boolean(rightZoom)) return false
  if (
    leftZoom &&
    rightZoom &&
    (leftZoom.value !== rightZoom.value ||
      leftZoom.min !== rightZoom.min ||
      leftZoom.max !== rightZoom.max ||
      leftZoom.in !== rightZoom.in ||
      leftZoom.out !== rightZoom.out ||
      leftZoom.reset !== rightZoom.reset)
  ) {
    return false
  }

  const leftPdf = left.pdf
  const rightPdf = right.pdf
  if (Boolean(leftPdf) !== Boolean(rightPdf)) return false
  if (
    leftPdf &&
    rightPdf &&
    (leftPdf.page !== rightPdf.page ||
      leftPdf.total !== rightPdf.total ||
      leftPdf.setPage !== rightPdf.setPage ||
      leftPdf.fitWidth !== rightPdf.fitWidth)
  ) {
    return false
  }

  const leftMetadata = left.metadata
  const rightMetadata = right.metadata
  if (Boolean(leftMetadata) !== Boolean(rightMetadata)) return false
  if (leftMetadata && rightMetadata) {
    if (leftMetadata.length !== rightMetadata.length) return false
    for (const [index, item] of leftMetadata.entries()) {
      const other = rightMetadata[index]
      if (!other || item.label !== other.label || item.value !== other.value) {
        return false
      }
    }
  }

  const leftGrab = left.elementGrab
  const rightGrab = right.elementGrab
  if (Boolean(leftGrab) !== Boolean(rightGrab)) return false
  if (
    leftGrab &&
    rightGrab &&
    (leftGrab.active !== rightGrab.active ||
      leftGrab.toggle !== rightGrab.toggle)
  ) {
    return false
  }

  const leftTrust = left.scriptsTrust
  const rightTrust = right.scriptsTrust
  if (Boolean(leftTrust) !== Boolean(rightTrust)) return false
  if (
    leftTrust &&
    rightTrust &&
    (leftTrust.active !== rightTrust.active ||
      leftTrust.toggle !== rightTrust.toggle)
  ) {
    return false
  }

  return (
    left.refresh === right.refresh && left.openExternal === right.openExternal
  )
}

function applyControllerSnapshot(
  target: FileViewerToolbarState,
  snapshot: FileViewerToolbarState
): void {
  target.zoom = snapshot.zoom
  target.pdf = snapshot.pdf
  target.metadata = snapshot.metadata
  target.refresh = snapshot.refresh
  target.openExternal = snapshot.openExternal
  target.elementGrab = snapshot.elementGrab
  target.scriptsTrust = snapshot.scriptsTrust
}

/**
 * 注册一个稳定的 controller 对象。Viewer 重渲染只更新其可变快照，挂载/卸载
 * 注册始终绑定同一个对象。
 */
export function useFileViewerController(
  snapshot: FileViewerToolbarState | null
): void {
  const runtime = useOptionalFileViewerRuntime()
  // 只有 Viewer kind 变化时才重建对象。初始对象只含 kind，完整可变快照会在
  // 下方 effect 中复制，再由注册 effect 发布。
  const snapshotKind: FileViewerKind | null = snapshot?.kind ?? null
  const controller = useMemo<FileViewerToolbarState | null>(
    () => (snapshotKind ? { kind: snapshotKind } : null),
    [snapshotKind]
  )
  const registerController = runtime?.registerController
  const updateController = runtime?.updateController
  const unregisterController = runtime?.unregisterController

  useEffect(() => {
    if (
      !controller ||
      !snapshot ||
      controller.kind !== snapshot.kind ||
      !updateController
    ) {
      return
    }
    const changed = !sameToolbarController(controller, snapshot)
    applyControllerSnapshot(controller, snapshot)
    if (changed) updateController(controller)
  }, [controller, snapshot, updateController])

  useEffect(() => {
    if (!controller || !registerController || !unregisterController) return
    registerController(controller)
    return () => unregisterController(controller)
  }, [controller, registerController, unregisterController])
}
