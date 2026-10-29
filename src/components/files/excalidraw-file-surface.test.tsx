import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type OnChange = (
  elements: { id: string; version: number }[],
  appState: { scrollX: number },
  files: Record<string, unknown>
) => void
let emit: OnChange = () => {}

vi.mock("@excalidraw/excalidraw/index.css", () => ({}))
vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: ({ onChange }: { onChange: OnChange }) => {
    emit = onChange
    return null
  },
  convertToExcalidrawElements: vi.fn(),
  viewportCoordsToSceneCoords: vi.fn(),
  getSceneVersion: (elements: { version: number }[]) =>
    elements.reduce((sum, e) => sum + e.version, 0),
  serializeAsJSON: (elements: unknown, appState: unknown) =>
    JSON.stringify({ elements, appState }),
}))
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({ openFilePreview: vi.fn() }),
}))

import { ExcalidrawFileSurface } from "./excalidraw-file-surface"
import type { TextFileWorkspaceTab } from "@/lib/files/file-workspace-tab"

const tab = {
  id: "t1",
  path: "/p/a.excalidraw",
  content: "",
  readonly: false,
} as unknown as TextFileWorkspaceTab

describe("ExcalidrawFileSurface", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("ignores pan / select frames and writes once after edits settle", () => {
    const onContentChange = vi.fn()
    const view = render(
      <ExcalidrawFileSurface tab={tab} onContentChange={onContentChange} />
    )
    const el = (version: number) => [{ id: "a", version }]
    act(() => emit(el(1), { scrollX: 0 }, {})) // 首次回调：基线
    act(() => emit(el(1), { scrollX: 50 }, {})) // 只平移
    act(() => vi.advanceTimersByTime(1000))
    expect(onContentChange).not.toHaveBeenCalled()

    // 拖动：连续多帧只在停手后写一次，内容是最后一帧
    for (let v = 2; v <= 10; v += 1) act(() => emit(el(v), { scrollX: 50 }, {}))
    expect(onContentChange).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(300))
    expect(onContentChange).toHaveBeenCalledTimes(1)
    expect(onContentChange.mock.calls[0][0]).toContain('"version":10')

    // 停手前关闭：卸载时补写
    act(() => emit(el(11), { scrollX: 50 }, {}))
    view.unmount()
    expect(onContentChange).toHaveBeenCalledTimes(2)
  })
})
