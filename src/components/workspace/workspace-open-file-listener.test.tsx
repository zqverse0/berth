import { act, cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkspaceFileOpenOptions } from "@/lib/workspace/workspace-runtime"
import type {
  WorkspaceOpenFileClaim,
  WorkspaceOpenFileOutcome,
} from "@/lib/api"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"

const subscribe = vi.fn()
const getCurrentWindow = vi.fn()
const openFilePreview =
  vi.fn<(path: string, options?: WorkspaceFileOpenOptions) => Promise<void>>()
const claimOpenFileRequests = vi.fn<() => Promise<WorkspaceOpenFileClaim[]>>()
const settleOpenFileRequest =
  vi.fn<(id: number, outcome: WorkspaceOpenFileOutcome) => Promise<void>>()

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/lib/platform", () => ({
  subscribe: (...args: unknown[]) => subscribe(...args),
  getCurrentWindow: () => getCurrentWindow(),
}))
vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({ openFilePreview }),
}))
vi.mock("@/lib/notify", () => ({ toast: { error: vi.fn() } }))
vi.mock("@/lib/api", () => ({
  WORKSPACE_OPEN_FILE_EVENT: "workspace://open-file",
  claimOpenFileRequests: () => claimOpenFileRequests(),
  settleOpenFileRequest: (id: number, outcome: WorkspaceOpenFileOutcome) =>
    settleOpenFileRequest(id, outcome),
}))

import { WorkspaceOpenFileListener } from "./workspace-open-file-listener"
import { toast } from "@/lib/notify"
import { WORKSPACE_OPEN_FILE_EVENT } from "@/lib/api"

function claim(
  id = 7,
  line: number | null = 99,
  remaining_ms = 30_000
): WorkspaceOpenFileClaim {
  return { request_id: id, path: "/synthetic/file.rs", line, remaining_ms }
}

function registerReveal(path: string, options?: WorkspaceFileOpenOptions) {
  useWorkspaceFileStore.getState().setPendingFileReveal({
    requestId: 100,
    path,
    line: options?.line ?? null,
    page: null,
    onComplete: options?.onReveal,
  })
  return Promise.resolve()
}

function completeReveal(line: number | null = 3, path = "/synthetic/file.rs") {
  act(() =>
    useWorkspaceFileStore
      .getState()
      .consumePendingFileReveal(100, { state: "opened", path, line })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useWorkspaceFileStore.getState().reset()
  getCurrentWindow.mockResolvedValue({ label: "main" })
  subscribe.mockResolvedValue(vi.fn())
  openFilePreview.mockImplementation(registerReveal)
  claimOpenFileRequests.mockResolvedValue([])
  settleOpenFileRequest.mockResolvedValue(undefined)
})
afterEach(async () => {
  cleanup()
  await act(async () => {})
  useWorkspaceFileStore.getState().reset()
  vi.useRealTimers()
})

describe("WorkspaceOpenFileListener", () => {
  it("claims on mount as a cold-start backstop", async () => {
    render(<WorkspaceOpenFileListener />)
    await waitFor(() => expect(claimOpenFileRequests).toHaveBeenCalledTimes(1))
  })

  it("claims after subscription is ready so the installation gap cannot lose a request", async () => {
    let finishSubscribe!: (unlisten: () => void) => void
    subscribe.mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          finishSubscribe = resolve
        })
    )
    render(<WorkspaceOpenFileListener />)
    await waitFor(() => expect(subscribe).toHaveBeenCalled())
    await act(async () => {})
    // 首次读取之后、订阅真正可用之前到达的请求没有唤醒事件可消费。
    claimOpenFileRequests.mockResolvedValue([claim(7, null)])
    await act(async () => finishSubscribe(vi.fn()))
    await waitFor(() => expect(openFilePreview).toHaveBeenCalledOnce())
    completeReveal(null)
    await waitFor(() =>
      expect(settleOpenFileRequest).toHaveBeenCalledWith(7, {
        state: "opened",
        path: "/synthetic/file.rs",
        line: null,
      })
    )
  })

  it("keeps an active receipt across dependency rerenders during project activation", async () => {
    claimOpenFileRequests.mockResolvedValue([claim(7, 3)])
    const view = render(<WorkspaceOpenFileListener />)
    await waitFor(() => expect(openFilePreview).toHaveBeenCalledOnce())
    view.rerender(<WorkspaceOpenFileListener />)
    await act(async () => {})
    expect(openFilePreview.mock.calls[0][1]?.signal?.aborted).toBe(false)
    expect(openFilePreview).toHaveBeenCalledOnce()
    completeReveal(3)
    await waitFor(() =>
      expect(settleOpenFileRequest).toHaveBeenCalledWith(7, {
        state: "opened",
        path: "/synthetic/file.rs",
        line: 3,
      })
    )
  })

  it("returns the actual path and clamped line instead of the requested line", async () => {
    claimOpenFileRequests.mockResolvedValue([claim()])
    render(<WorkspaceOpenFileListener />)
    await waitFor(() => expect(openFilePreview).toHaveBeenCalled())
    expect(settleOpenFileRequest).not.toHaveBeenCalled()
    completeReveal(3)
    await waitFor(() =>
      expect(settleOpenFileRequest).toHaveBeenCalledWith(7, {
        state: "opened",
        path: "/synthetic/file.rs",
        line: 3,
      })
    )
    expect(openFilePreview).toHaveBeenCalledWith(
      "/synthetic/file.rs",
      expect.objectContaining({ line: 99, onReveal: expect.any(Function) })
    )
  })

  it("does not equate an empty slot or resolved open promise with completion", async () => {
    claimOpenFileRequests.mockResolvedValue([claim(7, null)])
    openFilePreview.mockResolvedValue(undefined)
    render(<WorkspaceOpenFileListener />)
    await waitFor(() => expect(openFilePreview).toHaveBeenCalled())
    expect(settleOpenFileRequest).not.toHaveBeenCalled()
    const options = openFilePreview.mock.calls[0][1]
    act(() =>
      options?.onReveal?.({
        state: "opened",
        path: "/synthetic/file.rs",
        line: null,
      })
    )
    await waitFor(() =>
      expect(settleOpenFileRequest).toHaveBeenCalledWith(7, {
        state: "opened",
        path: "/synthetic/file.rs",
        line: null,
      })
    )
  })

  it("rejects a callback for a different target path", async () => {
    claimOpenFileRequests.mockResolvedValue([claim()])
    openFilePreview.mockImplementation(async (_path, options) => {
      options?.onReveal?.({
        state: "opened",
        path: "/synthetic/other.rs",
        line: 99,
      })
    })
    render(<WorkspaceOpenFileListener />)
    await waitFor(() =>
      expect(settleOpenFileRequest).toHaveBeenCalledWith(7, {
        state: "failed",
        message: expect.stringContaining("path"),
      })
    )
  })

  it("reports a cleared reveal as cancellation, not success", async () => {
    claimOpenFileRequests.mockResolvedValue([claim()])
    render(<WorkspaceOpenFileListener />)
    await waitFor(() => expect(openFilePreview).toHaveBeenCalled())
    act(() => useWorkspaceFileStore.getState().setPendingFileReveal(null))
    await waitFor(() =>
      expect(settleOpenFileRequest).toHaveBeenCalledWith(7, {
        state: "failed",
        message: expect.stringContaining("cancel"),
      })
    )
  })

  it("cancels a replaced target without waiting for its old load", async () => {
    claimOpenFileRequests.mockResolvedValue([claim()])
    openFilePreview.mockImplementation((path, options) => {
      void registerReveal(path, options)
      return new Promise(() => {})
    })
    render(<WorkspaceOpenFileListener />)
    await waitFor(() => expect(openFilePreview).toHaveBeenCalled())
    const replacement = {
      requestId: 200,
      path: "/synthetic/other.rs",
      line: 1,
      page: null,
    }
    act(() =>
      useWorkspaceFileStore.getState().setPendingFileReveal(replacement)
    )
    await waitFor(() =>
      expect(settleOpenFileRequest).toHaveBeenCalledWith(7, {
        state: "failed",
        message: expect.stringContaining("cancel"),
      })
    )
    expect(openFilePreview.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(useWorkspaceFileStore.getState().pendingFileReveal).toBe(replacement)
  })

  it("times out loading and ignores a late completion", async () => {
    vi.useFakeTimers()
    claimOpenFileRequests.mockResolvedValue([claim(7, 99, 20)])
    openFilePreview.mockImplementation((path, options) => {
      void registerReveal(path, options)
      return new Promise(() => {})
    })
    render(<WorkspaceOpenFileListener />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const options = openFilePreview.mock.calls[0][1]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(21)
    })
    expect(settleOpenFileRequest).toHaveBeenCalledWith(7, {
      state: "failed",
      message: expect.stringContaining("timed out"),
    })
    expect(options?.signal?.aborted).toBe(true)
    expect(useWorkspaceFileStore.getState().pendingFileReveal).toBeNull()
    act(() =>
      options?.onReveal?.({
        state: "opened",
        path: "/synthetic/file.rs",
        line: 99,
      })
    )
    expect(settleOpenFileRequest).toHaveBeenCalledTimes(1)
  })

  it("cancels on unmount and never starts queued work afterwards", async () => {
    claimOpenFileRequests.mockResolvedValue([claim(7), claim(8)])
    const rendered = render(<WorkspaceOpenFileListener />)
    await waitFor(() => expect(openFilePreview).toHaveBeenCalledTimes(1))
    rendered.unmount()
    await waitFor(() =>
      expect(settleOpenFileRequest).toHaveBeenCalledWith(7, {
        state: "failed",
        message: expect.stringContaining("cancel"),
      })
    )
    expect(openFilePreview).toHaveBeenCalledTimes(1)
    expect(useWorkspaceFileStore.getState().pendingFileReveal).toBeNull()
  })

  it("does not give queued claims a fresh timeout budget", async () => {
    vi.useFakeTimers()
    claimOpenFileRequests.mockResolvedValue([claim(7, 1, 20), claim(8, 1, 5)])
    render(<WorkspaceOpenFileListener />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(21)
    })
    expect(openFilePreview).toHaveBeenCalledTimes(1)
    expect(settleOpenFileRequest).toHaveBeenCalledWith(8, {
      state: "failed",
      message: expect.stringContaining("timed out"),
    })
  })

  it("processes claimed requests serially and ignores stale request ids", async () => {
    claimOpenFileRequests.mockResolvedValue([claim(7), claim(8)])
    render(<WorkspaceOpenFileListener />)
    await waitFor(() => expect(openFilePreview).toHaveBeenCalledTimes(1))
    act(() =>
      useWorkspaceFileStore.getState().consumePendingFileReveal(999, {
        state: "opened",
        path: "/synthetic/file.rs",
        line: 99,
      })
    )
    expect(settleOpenFileRequest).not.toHaveBeenCalled()
    completeReveal(1)
    await waitFor(() => expect(openFilePreview).toHaveBeenCalledTimes(2))
    act(() =>
      openFilePreview.mock.calls[0][1]?.onReveal?.({
        state: "opened",
        path: "/synthetic/file.rs",
        line: 99,
      })
    )
    expect(settleOpenFileRequest).toHaveBeenCalledTimes(1)
    completeReveal(2)
    await waitFor(() =>
      expect(settleOpenFileRequest).toHaveBeenCalledWith(8, {
        state: "opened",
        path: "/synthetic/file.rs",
        line: 2,
      })
    )
  })

  it("toasts and settles failed when opening rejects", async () => {
    claimOpenFileRequests.mockResolvedValue([claim()])
    openFilePreview.mockRejectedValue(new Error("boom"))
    render(<WorkspaceOpenFileListener />)
    await waitFor(() =>
      expect(settleOpenFileRequest).toHaveBeenCalledWith(7, {
        state: "failed",
        message: "boom",
      })
    )
    expect(toast.error).toHaveBeenCalled()
  })

  it("re-claims after every wake-up event", async () => {
    render(<WorkspaceOpenFileListener />)
    await waitFor(() => expect(subscribe).toHaveBeenCalled())
    const [event, handler] = subscribe.mock.calls[0]
    expect(event).toBe(WORKSPACE_OPEN_FILE_EVENT)
    handler({ path: "/synthetic/file.rs", line: 99 })
    await waitFor(() => expect(claimOpenFileRequests).toHaveBeenCalledTimes(2))
  })

  it("ignores the handoff in auxiliary windows", async () => {
    getCurrentWindow.mockResolvedValue({ label: "commit-12" })
    render(<WorkspaceOpenFileListener />)
    await waitFor(() => expect(getCurrentWindow).toHaveBeenCalled())
    expect(subscribe).not.toHaveBeenCalled()
    expect(claimOpenFileRequests).not.toHaveBeenCalled()
  })
})
