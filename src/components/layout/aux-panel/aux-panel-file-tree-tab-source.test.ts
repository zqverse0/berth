import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const auxSource = readFileSync(
  resolve(
    process.cwd(),
    "src/components/layout/aux-panel/aux-panel-file-tree-tab.tsx"
  ),
  "utf8"
)

const watchSource = readFileSync(
  resolve(process.cwd(), "src/hooks/workspace/use-open-file-tabs-watch.ts"),
  "utf8"
)

const runtimeSource = readFileSync(
  resolve(process.cwd(), "src/lib/workspace/workspace-file-runtime.ts"),
  "utf8"
)

describe("aux-panel-file-tree-tab no longer owns tab watching", () => {
  // The external-change reconciliation for open file tabs moved to the
  // always-mounted provider watcher (use-open-file-tabs-watch). The aux
  // panel is closed by default — any tab-reconciliation logic living here
  // would silently stop working whenever the panel is closed. Lock the
  // separation so a future change cannot quietly reintroduce it.
  it("contains no tab reconciliation or conflict machinery", () => {
    expect(auxSource).not.toMatch(/resolveFileChangeDecision/)
    expect(auxSource).not.toMatch(/announceConflict/)
    expect(auxSource).not.toMatch(/externalConflictPrompt/)
    expect(auxSource).not.toMatch(/\bapplyExternalReload\b/)
    expect(auxSource).not.toMatch(/\bmarkTabsStale\b/)
    expect(auxSource).not.toMatch(/\brejectFileTab\b/)
    expect(auxSource).not.toMatch(/\breloadOpenFileBackground\b/)
  })

  it("keeps the lazy-subtree cache invalidation envelope subscription", () => {
    // This envelope use is tree-cache bookkeeping, NOT tab watching — it
    // must stay with the tree it invalidates.
    expect(auxSource).toMatch(/subscribeWorkspaceEnvelopes/)
    expect(auxSource).toMatch(/lazyLoadedChildrenByPathRef/)
  })

  it("watches expanded non-materialized directories only while rendered", () => {
    expect(auxSource).toMatch(/ExpandedDirectoryWatchers/)
    expect(auxSource).toMatch(/useWorkspaceStateStore\(absolutePath, "paths"\)/)
    expect(auxSource).toMatch(/materializedTree/)
    expect(auxSource).toMatch(/handleExpandedDirectoryChange/)
  })
})

describe("use-open-file-tabs-watch external-change coverage", () => {
  it("destructures the resource-revision, stale, and prefetched-apply APIs", () => {
    // Catching external changes for non-active tabs requires these APIs;
    // source-grep them so a future refactor cannot silently regress to
    // active-tab-only behavior by dropping them.
    expect(watchSource).toMatch(/\bbumpResourceRevision\b/)
    expect(watchSource).toMatch(/\bmarkTabsStaleBatch\b/)
    expect(watchSource).toMatch(/\bapplyExternalReload\b/)
    expect(watchSource).toMatch(/\brejectFileTab\b/)
  })

  it("keys the subscription effect on the collision-safe watch signature only", () => {
    // Blocker #13: depending on anything derived per-render from fileTabs
    // would tear down and rebuild every store subscription on each
    // keystroke. The effect must key on the JSON signature string.
    expect(watchSource).toMatch(/JSON\.stringify\(entries\)/)
    expect(watchSource).toMatch(/JSON\.parse\(watchSignature\)/)
  })

  it("dispatches applyExternalReload from the watcher to avoid double-reads", () => {
    // The resolver already paid for one readFileForEdit. Reloading via
    // openFilePreview would trigger a second read; applyExternalReload
    // writes the prefetched payload directly.
    const awaitIdx = watchSource.indexOf(
      "await workspaceFileRuntime.inspectExternalChange("
    )
    expect(awaitIdx).toBeGreaterThan(-1)
    const window = watchSource.slice(awaitIdx, awaitIdx + 2000)
    expect(window).toMatch(/applyExternalReload\s*\(/)
  })

  it("re-reads the active tab id after the conflict resolve await", () => {
    // If the user switches away mid-read, the conflict must degrade to a
    // stale mark instead of popping a dialog for a tab they just left.
    expect(watchSource).toMatch(
      /tab\.id\s*===\s*activeFileTabIdRef\.current[\s\S]{0,400}enqueueExternalConflict/
    )
  })

  it("branches resource reload policies around the etag resolver", () => {
    // Resource tabs carry no text-buffer etag. The watcher must dispatch
    // workspace resources by revision and skip self-managed resources before
    // invoking the text-only resolver.
    const awaitIdx = watchSource.indexOf(
      "await workspaceFileRuntime.inspectExternalChange("
    )
    expect(awaitIdx).toBeGreaterThan(-1)
    const block = watchSource.slice(Math.max(0, awaitIdx - 1600), awaitIdx)
    expect(block).toMatch(/reloadPolicy\s*===\s*"workspace-resource"/)
    expect(block).toMatch(/bumpResourceRevision/)
    expect(block).toMatch(/reloadPolicy\s*===\s*"self-managed"/)
    expect(watchSource).not.toMatch(/isImageFile|isOfficePreviewable/)
  })

  it("falls back to a full scan when an envelope signals resync_hint", () => {
    expect(watchSource).toMatch(/resync_hint/)
  })

  it("models a missing/read-failure decision in the resolver", () => {
    expect(runtimeSource).toMatch(/kind:\s*"missing"/)
  })

  it("batch-marks background tabs stale instead of reading them eagerly", () => {
    // The lazy pillar: background tabs must not cost disk reads on every
    // workspace event — one batched setState marks them stale and the
    // activation path refreshes them.
    expect(watchSource).toMatch(/staleBatch/)
    expect(watchSource).toMatch(/markTabsStaleBatch\(staleBatch\)/)
  })
})

describe("file-workspace-panel routes active-tab openers by tab folder", () => {
  const panelSource = readFileSync(
    resolve(process.cwd(), "src/components/files/file-workspace-panel.tsx"),
    "utf8"
  )

  it("diff-overview rows open files in the overview tab's folder", () => {
    // A background-folder overview must never open its rows through the
    // active workspace folder.
    expect(panelSource).toMatch(
      /openFilePreview\(path, \{ folderId: overviewFolderId \}\)/
    )
  })
})
