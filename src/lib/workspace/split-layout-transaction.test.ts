import { describe, expect, it, vi } from "vitest"
import { createSplitLayoutTransaction } from "@/lib/workspace/split-layout-transaction"

describe("split layout transaction", () => {
  it("runs one queued consumer after commit and drops it on cancel", () => {
    const transaction = createSplitLayoutTransaction()
    const callback = vi.fn()
    const commitListener = vi.fn()
    const cancelListener = vi.fn()
    transaction.subscribeCommit(commitListener)
    transaction.subscribeCancel(cancelListener)

    transaction.beginPreview()
    transaction.schedule(callback)
    transaction.schedule(callback)
    expect(callback).not.toHaveBeenCalled()

    transaction.commit({ geometry: [], reason: "divider" })
    expect(callback).toHaveBeenCalledOnce()
    expect(commitListener).toHaveBeenCalledWith({
      geometry: [],
      reason: "divider",
    })

    transaction.beginPreview()
    transaction.schedule(callback)
    transaction.cancel()
    expect(callback).toHaveBeenCalledOnce()
    expect(cancelListener).toHaveBeenCalledOnce()
  })

  it("waits for the outer preview before notifying nested consumers", () => {
    const transaction = createSplitLayoutTransaction()
    const commit = vi.fn()
    transaction.subscribeCommit(commit)

    transaction.beginPreview()
    transaction.beginPreview()
    transaction.commit({ geometry: [], reason: "divider" })

    expect(commit).not.toHaveBeenCalled()
    expect(transaction.isPreviewing()).toBe(true)

    transaction.commit({ geometry: [], reason: "divider" })

    expect(commit).toHaveBeenCalledOnce()
    expect(transaction.isPreviewing()).toBe(false)
  })

  it("runs external invalidations immediately when idle", () => {
    const transaction = createSplitLayoutTransaction()
    const callback = vi.fn()

    transaction.schedule(callback)

    expect(callback).toHaveBeenCalledOnce()
    expect(transaction.isPreviewing()).toBe(false)
  })
})
