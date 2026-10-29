"use client"

// Workspace-shell external-change watcher for open file tabs.
//
// A file tab is identified by its absolute path; folder association is
// DERIVED here: the watcher subscribes to the per-root workspace FS stream
// of each open file's parent directory — regardless of which
// folder/conversation is active and whether the (lazy) aux file tree is
// mounted. Tabs outside every registered folder get no live stream; they are
// covered by the activation-time freshness pass at the bottom of this hook
// (plus the provider's save pre-verify and the backend's etag CAS).
//
// Performance model (the load-bearing part):
//   • The subscription effect depends ONLY on `watchSignature`, a
//     collision-safe JSON string of the sorted parent directories derived from
//     the open tabs' paths. Keystrokes churn `fileTabs` every render, but the
//     signature string stays identical, so subscriptions are never torn
//     down/rebuilt on typing — and the backend stream never restarts.
//   • Resource tabs advance once per delivered workspace-resource envelope
//     with zero reads. For text tabs, only the ACTIVE tab is reconciled
//     eagerly; affected background tabs are batch-marked stale.
//   • Our own saves echo back as change events. A one-shot etag record
//     per save suppresses the immediate re-mark so switching tabs after
//     an autosave doesn't flash a pointless reload.
import { useEffect, useMemo, useRef, type RefObject } from "react"
import {
  findOwningFolder,
  isPathUnderRoot,
  isVirtualPreviewPath,
  joinRootRel,
  normalizeAbsPath,
  splitAbsPath,
} from "@/lib/files/file-open-target"
import { fileOpenStrategyFromPath } from "@/lib/files/file-open-strategy"
import { getWorkspaceStateStore } from "@/hooks/workspace/use-workspace-state-store"
import type { FileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import {
  workspaceFileRuntime,
  type WorkspaceExternalConflict,
} from "@/lib/workspace/workspace-file-runtime"
import type { FileEditContent } from "@/lib/types"

export type { WorkspaceExternalConflict } from "@/lib/workspace/workspace-file-runtime"
import {
  isResourceFileTab,
  isTextFileTab,
} from "@/lib/files/file-workspace-tab"

// True when `tabPath` (absolute, normalized) is a changed path itself or
// sits under a changed directory. Boundary-safe: walks the tab path's
// ancestor segments and looks each up in the changed set — "/a/foo" never
// matches a change reported for "/a/foobar", and the cost is O(depth),
// not O(changed).
function tabPathAffected(tabPath: string, changedSet: Set<string>): boolean {
  const normalized = normalizeAbsPath(tabPath)
  if (changedSet.has(normalized)) return true
  let slash = normalized.lastIndexOf("/")
  while (slash > 0) {
    if (changedSet.has(normalized.slice(0, slash))) return true
    slash = normalized.lastIndexOf("/", slash - 1)
  }
  return false
}

export interface UseOpenFileTabsWatchParams {
  // Render-scoped tab list — used ONLY to derive the watch signature.
  fileTabs: FileWorkspaceTab[]
  // Latest-state readers supplied by the shell; the file store remains the
  // authoritative tab owner.
  fileTabsRef: RefObject<FileWorkspaceTab[]>
  activeFileTabIdRef: RefObject<string | null>
  // Render-scoped active tab for the stale-on-activation pass.
  activeFileTab: FileWorkspaceTab | null
  // Registered folders — the derivation source for which open files are
  // eligible for a live watch. Render-scoped; participates in the signature
  // memo so folder add/remove (and path changes) re-key subscriptions.
  allFolders: ReadonlyArray<{ id: number; path: string }>
  // Headless runtime actions (stable identities).
  openFilePreview: (
    path: string,
    options?: {
      line?: number
      reload?: boolean
      folderId?: number
      readonly?: boolean
      lifetime?: "global" | "project"
    }
  ) => Promise<void>
  closeFileTab: (tabId: string) => Promise<void> | void
  bumpResourceRevision: (path: string) => void
  applyExternalReload: (
    path: string,
    fetched: FileEditContent
  ) => void | Promise<void>
  markTabsStale: (path: string) => void
  markTabsStaleBatch: (paths: string[]) => void
  rejectFileTab: (path: string, errorMessage: string) => void
  enqueueExternalConflict: (conflict: WorkspaceExternalConflict) => void
  // One-shot save-echo suppression (owned by the headless runtime save path).
  consumeSelfWriteEcho: (path: string) => boolean
}

export function useOpenFileTabsWatch({
  fileTabs,
  fileTabsRef,
  activeFileTabIdRef,
  activeFileTab,
  allFolders,
  openFilePreview,
  closeFileTab,
  bumpResourceRevision,
  applyExternalReload,
  markTabsStale,
  markTabsStaleBatch,
  rejectFileTab,
  enqueueExternalConflict,
  consumeSelfWriteEcho,
}: UseOpenFileTabsWatchParams): void {
  // Collision-safe, stable-by-value signature of the smallest roots needed by
  // open file tabs: one parent directory per file, deduplicated. JSON encoding
  // (not join) means no path content can forge a separator. Recomputed per
  // render (cheap O(tabs × folders)); the effect only re-runs when the
  // resulting directory set changes.
  const watchSignature = useMemo(() => {
    const watchRoots = new Set<string>()
    for (const tab of fileTabs) {
      if (tab.kind !== "file" || !tab.path) continue
      if (!findOwningFolder(tab.path, allFolders)) continue
      const location = splitAbsPath(tab.path)
      if (location) watchRoots.add(location.rootPath)
    }
    const entries = [...watchRoots].sort()
    return JSON.stringify(entries)
  }, [fileTabs, allFolders])

  useEffect(() => {
    const targets = JSON.parse(watchSignature) as string[]
    if (targets.length === 0) return

    const subscriptions = targets.map((rootPath) => {
      const store = getWorkspaceStateStore(rootPath)
      // Paths-only: tab watching consumes changed_paths exclusively. The
      // backend watches only this parent directory, so an unopened part of the
      // project never needs a workspace-wide watcher.
      const token = store.acquire("paths")

      // Per-root drainer: coalesces text paths via queueMicrotask and a single
      // in-flight loop. Resource envelopes are retained individually because
      // each delivery advances the renderer's source revision exactly once.
      const pendingPaths = new Set<string>()
      let pendingFullScan = false
      const pendingResourceEnvelopes: Array<{
        paths: string[]
        fullScan: boolean
      }> = []
      let flushScheduled = false
      let flushPromise: Promise<void> | null = null
      let disposed = false

      const reconcileChanges = async (
        paths: string[],
        fullScan: boolean,
        resourceEnvelopes: ReadonlyArray<{
          paths: string[]
          fullScan: boolean
        }>
      ): Promise<void> => {
        // Tabs covered by THIS stream: boundary containment on the
        // absolute path. Every subscribed root is an independent delivery
        // source: if nested roots both deliver an envelope for one resource,
        // each delivered envelope advances its revision once.
        const openFileTabs = (fileTabsRef.current ?? []).filter(
          (t) =>
            t.kind === "file" &&
            t.path &&
            !t.loading &&
            !isVirtualPreviewPath(t.path) &&
            isPathUnderRoot(t.path, rootPath)
        )
        if (openFileTabs.length === 0) return

        const candidates = (() => {
          if (fullScan) return openFileTabs
          // changed_paths are root-relative; join onto the stream root so
          // they compare byte-identically with tab identities.
          const changedSet = new Set(
            paths.map((rel) => joinRootRel(rootPath, rel))
          )
          return openFileTabs.filter(
            (t) => t.path && tabPathAffected(t.path, changedSet)
          )
        })()
        if (candidates.length === 0) return
        const resourceChanges = resourceEnvelopes.map((envelope) => ({
          fullScan: envelope.fullScan,
          changedSet: envelope.fullScan
            ? null
            : new Set(envelope.paths.map((rel) => joinRootRel(rootPath, rel))),
        }))

        // Apply resource policy before splitting text tabs by activation.
        // Background text tabs cost zero disk reads (batched stale mark),
        // while only the active text tab gets eager read+resolve treatment.
        const activeId = activeFileTabIdRef.current
        const staleBatch: string[] = []
        const eager: FileWorkspaceTab[] = []
        for (const tab of candidates) {
          if (!tab.path) continue
          const strategy = fileOpenStrategyFromPath(tab.path)
          if (strategy.reloadPolicy === "workspace-resource") {
            for (const change of resourceChanges) {
              if (
                change.fullScan ||
                (change.changedSet &&
                  tabPathAffected(tab.path, change.changedSet))
              ) {
                bumpResourceRevision(tab.path)
              }
            }
            continue
          }
          if (strategy.reloadPolicy === "self-managed") continue
          if (tab.id === activeId) {
            eager.push(tab)
            continue
          }
          // Clean tab whose etag matches a just-issued save of ours: the
          // event is (with overwhelming likelihood) our own write echo.
          // One-shot: the record is consumed, so any FURTHER event for
          // this path marks stale normally.
          if (
            (!isTextFileTab(tab) || !tab.isDirty) &&
            consumeSelfWriteEcho(tab.path)
          ) {
            continue
          }
          staleBatch.push(tab.path)
        }
        if (staleBatch.length > 0) {
          markTabsStaleBatch(staleBatch)
        }

        for (const tab of eager) {
          if (disposed) return
          const path = tab.path
          if (!path) continue

          if (consumeSelfWriteEcho(path)) continue

          const decision = await workspaceFileRuntime.inspectExternalChange(
            tab.id
          )
          if (disposed) return

          if (decision.kind === "none") continue

          if (decision.kind === "reload") {
            void applyExternalReload(decision.path, decision.latest)
            continue
          }

          if (decision.kind === "missing") {
            const liveTab = (fileTabsRef.current ?? []).find(
              (t) => t.id === tab.id
            )
            if (liveTab && isTextFileTab(liveTab) && liveTab.isDirty) {
              markTabsStale(decision.path)
            } else {
              void closeFileTab(tab.id)
            }
            continue
          }

          // Conflict. Re-read activation AFTER the resolve await: if the
          // user switched away mid-read, degrade to a stale mark instead
          // of popping a dialog for a tab they just left.
          if (tab.id === activeFileTabIdRef.current) {
            enqueueExternalConflict({
              path: decision.path,
              diskContent: decision.diskContent,
              unsavedContent: decision.unsavedContent,
              signature: decision.signature,
            })
          } else {
            markTabsStale(decision.path)
          }
        }
      }

      const ensureFlushing = () => {
        if (flushPromise || flushScheduled) return
        flushScheduled = true
        queueMicrotask(() => {
          flushScheduled = false
          if (disposed) return
          flushPromise = (async () => {
            try {
              // Drain anything pending — including envelopes that arrive
              // while awaiting reconcileChanges; their paths land in
              // pendingPaths and the next loop iteration picks them up.
              while (
                !disposed &&
                (pendingPaths.size > 0 ||
                  pendingFullScan ||
                  pendingResourceEnvelopes.length > 0)
              ) {
                const paths = Array.from(pendingPaths)
                pendingPaths.clear()
                const fullScan = pendingFullScan
                pendingFullScan = false
                const resourceEnvelopes = pendingResourceEnvelopes.splice(0)
                await reconcileChanges(paths, fullScan, resourceEnvelopes)
              }
            } finally {
              flushPromise = null
            }
          })()
        })
      }

      const unsubscribe = store.subscribeEnvelopes(
        ({ changed_paths, kind }) => {
          const fullScan =
            kind === "resync_hint" ||
            !changed_paths ||
            changed_paths.length === 0
          pendingResourceEnvelopes.push({
            paths: changed_paths ?? [],
            fullScan,
          })
          if (fullScan) {
            // Resync or untargeted event — we cannot scope work, so cover
            // every open tab under this root. Targeted paths from later
            // envelopes are additive (full scan is a superset).
            pendingFullScan = true
          } else {
            for (const path of changed_paths) {
              pendingPaths.add(path)
            }
          }
          ensureFlushing()
        }
      )

      return () => {
        disposed = true
        unsubscribe()
        pendingPaths.clear()
        pendingResourceEnvelopes.length = 0
        store.release(token)
      }
    })

    return () => {
      for (const dispose of subscriptions) dispose()
    }
  }, [
    watchSignature,
    fileTabsRef,
    activeFileTabIdRef,
    closeFileTab,
    bumpResourceRevision,
    applyExternalReload,
    markTabsStale,
    markTabsStaleBatch,
    rejectFileTab,
    enqueueExternalConflict,
    consumeSelfWriteEcho,
  ])

  // Activation pass — one effect, three exclusive branches, no double
  // reads:
  //   ① stale + clean  → reload via openFilePreview's decideLoad promotion.
  //   ② stale + dirty  → conflict detection via the resolver.
  //   ③ unwatched fresh-check: a text tab OUTSIDE every registered folder
  //     has no live stream, so verify it against disk once per activation
  //     TRANSITION (never per re-render/keystroke; the ref below records
  //     the id even on skipped runs so a cold load doesn't double-read).
  const lastActivationCheckedTabIdRef = useRef<string | null>(null)
  useEffect(() => {
    const tab = activeFileTab
    if (!tab || tab.kind !== "file") {
      lastActivationCheckedTabIdRef.current = null
      return
    }
    const isTransition = lastActivationCheckedTabIdRef.current !== tab.id
    lastActivationCheckedTabIdRef.current = tab.id

    // Generated in-memory previews are not disk files. Treating them as
    // unwatched paths would read `/__berth_preview__/…` and replace the
    // buffer with "Folder does not exist".
    if (isVirtualPreviewPath(tab.path)) return

    if (tab.stale && !tab.loading) {
      if (isResourceFileTab(tab)) {
        void openFilePreview(tab.path, { reload: true })
        return
      }
      if (!tab.isDirty) {
        // Clean stale — decideLoad promotes this reopen to a reload.
        void openFilePreview(tab.path, { reload: true })
        return
      }
      void (async () => {
        const decision = await workspaceFileRuntime.inspectExternalChange(
          tab.id
        )
        if (decision.kind === "conflict") {
          enqueueExternalConflict({
            path: decision.path,
            diskContent: decision.diskContent,
            unsavedContent: decision.unsavedContent,
            signature: decision.signature,
          })
        } else if (decision.kind === "reload") {
          void applyExternalReload(decision.path, decision.latest)
        } else if (decision.kind === "missing") {
          // File vanished while the dirty buffer sat in a non-active tab.
          // The buffer is still dirty here (this branch only runs for
          // tab.isDirty === true) so we keep the stale flag on the tab —
          // refusing to silently lose the user's unsaved edits. The user
          // discovers the deletion on save (backend recreates or errors).
          markTabsStale(decision.path)
        }
      })()
      return
    }

    // Branch ③ — activation freshness for unwatched tabs.
    if (!isTransition) return
    if (tab.loading || tab.saveState === "saving") return
    if (!isTextFileTab(tab)) return
    if (findOwningFolder(tab.path, allFolders)) return
    void (async () => {
      const decision = await workspaceFileRuntime.inspectExternalChange(tab.id)
      if (decision.kind === "conflict") {
        enqueueExternalConflict({
          path: decision.path,
          diskContent: decision.diskContent,
          unsavedContent: decision.unsavedContent,
          signature: decision.signature,
        })
      } else if (decision.kind === "reload") {
        void applyExternalReload(decision.path, decision.latest)
      } else if (decision.kind === "missing") {
        const liveTab = (fileTabsRef.current ?? []).find((t) => t.id === tab.id)
        if (liveTab && isTextFileTab(liveTab) && liveTab.isDirty) {
          markTabsStale(decision.path)
        } else {
          void closeFileTab(tab.id)
        }
      }
    })()
  }, [
    activeFileTab,
    fileTabsRef,
    allFolders,
    openFilePreview,
    closeFileTab,
    applyExternalReload,
    enqueueExternalConflict,
    markTabsStale,
    rejectFileTab,
  ])
}
