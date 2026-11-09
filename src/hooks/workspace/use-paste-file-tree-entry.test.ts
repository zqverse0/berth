import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { copyFileTreeEntry } from "@/lib/api"
import { pullDeviceFile, transferInto } from "@/lib/devices"
import { toast } from "@/lib/notify"
import { readClipboardFiles, writeClipboardFiles } from "@/lib/platform"
import { useFileTreeClipboardStore } from "@/stores/file-tree-clipboard-store"
import {
  copyEntryToClipboard,
  readPasteEntries,
  usePasteFileTreeEntry,
} from "./use-paste-file-tree-entry"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
vi.mock("@/lib/api", () => ({ copyFileTreeEntry: vi.fn() }))
vi.mock("@/lib/devices", () => ({
  pullDeviceFile: vi.fn(),
  transferInto: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  readClipboardFiles: vi.fn(),
  writeClipboardFiles: vi.fn(),
}))
vi.mock("@/lib/notify", () => ({
  dismissToast: vi.fn(),
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const ROOT = "berth-device://1/home/a"

async function paste(kind: "file" | "dir", rootPath = ROOT) {
  useFileTreeClipboardStore
    .getState()
    .copy({ absPath: `${ROOT}/x`, name: "x", kind })
  const { result } = renderHook(() => usePasteFileTreeEntry())
  return result.current(rootPath, "sub")
}

describe("usePasteFileTreeEntry on the same device", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(pullDeviceFile).mockResolvedValue("/cache/x")
    vi.mocked(transferInto).mockResolvedValue({ id: 1 })
    vi.mocked(readClipboardFiles).mockResolvedValue([])
  })

  it("copies on the device when it has the command", async () => {
    vi.mocked(copyFileTreeEntry).mockResolvedValue("sub/x")
    await expect(paste("file")).resolves.toBe("sub/x")
    expect(transferInto).not.toHaveBeenCalled()
  })

  it("an older device falls back to pull + transfer for files", async () => {
    vi.mocked(copyFileTreeEntry).mockRejectedValue(
      "Command copy_file_tree_entry not found"
    )
    await paste("file")
    expect(pullDeviceFile).toHaveBeenCalledWith(
      1,
      "/home/a/x",
      expect.anything()
    )
    expect(transferInto).toHaveBeenCalledWith(
      { deviceId: 1, dir: "/home/a/sub" },
      "/cache/x"
    )
  })

  it("an older device asks to upgrade for directories", async () => {
    vi.mocked(copyFileTreeEntry).mockRejectedValue(
      "Command copy_file_tree_entry not found"
    )
    await paste("dir")
    expect(toast.error).toHaveBeenCalledWith("toasts.pasteNeedsUpgrade")
    expect(pullDeviceFile).not.toHaveBeenCalled()
  })

  it("other copy failures stay failures", async () => {
    vi.mocked(copyFileTreeEntry).mockRejectedValue("disk full")
    await paste("file")
    expect(toast.error).toHaveBeenCalledWith("toasts.pasteFailed", {
      description: "disk full",
    })
    expect(pullDeviceFile).not.toHaveBeenCalled()
  })
})

describe("clipboard source", () => {
  const local = { absPath: "/a/x", name: "x", kind: "file" as const }
  const outside = { absPath: "/b/y", name: "y", kind: "file" as const }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(writeClipboardFiles).mockResolvedValue()
  })

  it("files copied in another app win over the internal entry", async () => {
    copyEntryToClipboard(local)
    expect(writeClipboardFiles).toHaveBeenCalledWith(["/a/x"])
    vi.mocked(readClipboardFiles).mockResolvedValue([outside])
    await expect(readPasteEntries()).resolves.toEqual([outside])
  })

  it("falls back to the internal entry, also when reading fails", async () => {
    copyEntryToClipboard({ ...local, absPath: `${ROOT}/x` })
    expect(writeClipboardFiles).not.toHaveBeenCalled()
    vi.mocked(readClipboardFiles).mockRejectedValue("no clipboard")
    await expect(readPasteEntries()).resolves.toHaveLength(1)
  })

  it("pastes every system file and reports a count", async () => {
    vi.mocked(readClipboardFiles).mockResolvedValue([local, outside])
    vi.mocked(copyFileTreeEntry).mockResolvedValue("sub/y")
    const { result } = renderHook(() => usePasteFileTreeEntry())
    await expect(result.current("/repo", "sub")).resolves.toBe("sub/y")
    expect(copyFileTreeEntry).toHaveBeenCalledTimes(2)
    expect(toast.success).toHaveBeenCalledWith("toasts.pastedCount")
  })
})
