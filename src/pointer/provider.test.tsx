import { fireEvent, render, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useEffect } from "react"
import { describe, expect, it, vi, beforeEach } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { PointerProvider, usePointer } from "./provider"
import type { PointerSelection, PointerSelectionAction } from "./types"

vi.mock("@/contexts/settings-workspace-context", () => ({
  useSettingsWorkspace: () => ({
    openSettings: vi.fn(),
  }),
}))

vi.mock("./clipboard", () => ({
  copyPlainToClipboard: vi.fn(async () => true),
  copySourceToClipboard: vi.fn(async () => true),
}))

vi.mock("@/lib/translate", () => ({
  translateText: vi.fn(async () => ({
    text: "translated text",
    provider: "mock",
  })),
  isTranslateProviderId: vi.fn(() => false),
}))

vi.mock("@/lib/notify", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

const platformMocks = vi.hoisted(() => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/platform", () => platformMocks)

describe("PointerProvider Floating Action Pill Toolbar", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function renderWithProvider(ui: React.ReactNode) {
    return render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PointerProvider>{ui}</PointerProvider>
      </NextIntlClientProvider>
    )
  }

  it("renders children without showing toolbar initially", () => {
    const { getByText, queryByRole } = renderWithProvider(
      <div>Hello world</div>
    )
    expect(getByText("Hello world")).not.toBeNull()
    expect(queryByRole("toolbar")).toBeNull()
  })

  it("shows floating pill toolbar when contextmenu is triggered with valid selection", async () => {
    const { getByText, getByRole, queryByRole } = renderWithProvider(
      <div>Sample text content</div>
    )

    // Mock DOM selection
    const textNode = getByText("Sample text content")
    const range = document.createRange()
    range.selectNodeContents(textNode)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    fireEvent.contextMenu(textNode)

    await waitFor(() => {
      expect(getByRole("toolbar", { name: "Selection Actions" })).not.toBeNull()
    })

    expect(getByText("Copy content")).not.toBeNull()
    expect(getByText("Translate")).not.toBeNull()

    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => {
      expect(queryByRole("toolbar")).toBeNull()
    })
  })

  it("opens the same copy-source action for a native element locator", async () => {
    function OpenNativeMenu() {
      const pointer = usePointer()
      return (
        <button
          type="button"
          onClick={() =>
            pointer.showMenu(
              {
                excerpt: "1,280",
                editable: false,
                source: {
                  identity: { type: "file", path: "/repo/q3.docx" },
                  span: {
                    unit: "element",
                    selector: "td",
                    tagName: "td",
                  },
                  excerpt: "1,280",
                },
              },
              { x: 40, y: 40 }
            )
          }
        >
          open-native
        </button>
      )
    }

    const { getByText, getByRole } = renderWithProvider(<OpenNativeMenu />)
    fireEvent.click(getByText("open-native"))
    await waitFor(() => {
      expect(getByRole("toolbar", { name: "Selection Actions" })).not.toBeNull()
    })
    expect(getByText("Copy content")).not.toBeNull()
    expect(getByText("Copy content and source")).not.toBeNull()
  })

  it("shows an open-link action for an explicit web URL", async () => {
    const { getByText, getByRole } = renderWithProvider(
      <div>https://example.com/docs</div>
    )

    const textNode = getByText("https://example.com/docs")
    const range = document.createRange()
    range.selectNodeContents(textNode)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    fireEvent.contextMenu(textNode)

    const openLink = await waitFor(() =>
      getByRole("button", { name: "Open link" })
    )
    fireEvent.click(openLink)

    await waitFor(() => {
      expect(platformMocks.openUrl).toHaveBeenCalledWith(
        "https://example.com/docs"
      )
    })
  })

  it("positions toolbar safely within boundaries on mouseUp text selection", async () => {
    const { getByText, getByRole } = renderWithProvider(
      <div style={{ width: 1000, height: 800 }}>Sample text content</div>
    )

    const textNode = getByText("Sample text content")
    const range = document.createRange()
    range.selectNodeContents(textNode)
    // Mock getBoundingClientRect near the right edge of viewport
    vi.spyOn(range, "getBoundingClientRect").mockReturnValue({
      left: 920,
      top: 400,
      right: 980,
      bottom: 420,
      width: 60,
      height: 20,
      x: 920,
      y: 400,
      toJSON: () => {},
    })

    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    fireEvent.mouseUp(textNode, { button: 0 })

    await waitFor(() => {
      const toolbar = getByRole("toolbar", { name: "Selection Actions" })
      expect(toolbar).not.toBeNull()
      const container = (toolbar.closest(".fixed") || toolbar) as HTMLElement
      // Clamped within viewport margin (e.g. left + width <= window.innerWidth - 12)
      const styleLeft = parseInt(container.style.left, 10)
      expect(styleLeft).toBeGreaterThanOrEqual(12)
      expect(styleLeft).toBeLessThanOrEqual(window.innerWidth - 12)
    })
  })

  it("automatically hides floating toolbar when selection is cancelled / collapsed", async () => {
    const { getByText, getByRole, queryByRole } = renderWithProvider(
      <div>Sample text content</div>
    )

    const textNode = getByText("Sample text content")
    const range = document.createRange()
    range.selectNodeContents(textNode)
    vi.spyOn(range, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 100,
      right: 200,
      bottom: 120,
      width: 100,
      height: 20,
      x: 100,
      y: 100,
      toJSON: () => {},
    })

    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    fireEvent.mouseUp(textNode, { button: 0 })

    await waitFor(() => {
      expect(getByRole("toolbar", { name: "Selection Actions" })).not.toBeNull()
    })

    // Cancel selection (unselect)
    selection?.removeAllRanges()
    fireEvent(document, new Event("selectionchange"))

    await waitFor(() => {
      expect(queryByRole("toolbar")).toBeNull()
    })
  })

  it("keeps floating toolbar open after releasing right-click on custom surface", async () => {
    function TerminalHarness() {
      const pointer = usePointer()
      useEffect(() => {
        pointer.reportSelection({
          excerpt: "echo hello world",
          editable: false,
          source: {
            identity: {
              type: "terminal",
              backendInstanceId: "test",
              terminalId: "term-1",
              pane: { session: "term", window: "term-1", index: 0 },
            },
            excerpt: "echo hello world",
          },
        })
      }, [pointer])
      return <div data-pointer-surface>terminal content</div>
    }

    const { getByText, getByRole, queryByRole } = renderWithProvider(
      <TerminalHarness />
    )

    const surface = document.querySelector("[data-pointer-surface]")!

    // 1. Right click down & contextmenu
    fireEvent.pointerDown(surface, { button: 2 })
    fireEvent.contextMenu(surface)

    await waitFor(() => {
      expect(getByRole("toolbar", { name: "Selection Actions" })).not.toBeNull()
    })
    expect(getByText("Copy content")).not.toBeNull()

    // 2. Releasing right mouse button (pointerUp/mouseUp with button 2) should NOT close the menu
    fireEvent.pointerUp(surface, { button: 2 })
    fireEvent.mouseUp(surface, { button: 2 })

    // Wait 50ms to ensure any delayed sync timer has executed
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(getByRole("toolbar", { name: "Selection Actions" })).not.toBeNull()

    // 3. Left click outside closes toolbar
    fireEvent.pointerDown(document.body, { button: 0 })
    await waitFor(() => {
      expect(queryByRole("toolbar")).toBeNull()
    })
  })

  describe("selection action slot", () => {
    const pdfSelection: PointerSelection = {
      excerpt: "PDF text",
      editable: false,
      source: {
        identity: { type: "file", path: "/paper.pdf" },
        span: { unit: "page", page: 1 },
        excerpt: "PDF text",
      },
    }

    const highlightAction: PointerSelectionAction = {
      id: "pdf-highlight",
      matches: (selection) => selection.source?.span?.unit === "page",
      label: "Highlight",
      icon: <span aria-hidden>✦</span>,
      panel: ({ backToMenu }) => (
        <div data-testid="highlight-palette">
          <span>Palette</span>
          <button type="button" onClick={backToMenu}>
            Back
          </button>
        </div>
      ),
    }

    function ActionHarness({
      selection,
      action,
    }: {
      selection: PointerSelection
      action: PointerSelectionAction
    }) {
      const pointer = usePointer()
      useEffect(() => {
        const unregister = pointer.registerSelectionAction(action)
        return unregister
      }, [pointer, action])
      useEffect(() => {
        pointer.reportSelection(selection)
      }, [pointer, selection])
      return <div data-pointer-surface>PDF text</div>
    }

    it("shows a registered action button when selection matches", async () => {
      const { getByText, getByRole, queryByText } = renderWithProvider(
        <ActionHarness selection={pdfSelection} action={highlightAction} />
      )

      fireEvent.contextMenu(document.querySelector("[data-pointer-surface]")!)

      await waitFor(() => {
        expect(
          getByRole("toolbar", { name: "Selection Actions" })
        ).not.toBeNull()
      })
      expect(getByText("Highlight")).not.toBeNull()
      expect(queryByText("Open file")).toBeNull()
    })

    it("hides the action button when selection does not match", async () => {
      const plainSelection: PointerSelection = {
        excerpt: "plain",
        editable: false,
        source: null,
      }
      const { queryByText, getByRole } = renderWithProvider(
        <ActionHarness selection={plainSelection} action={highlightAction} />
      )

      fireEvent.contextMenu(document.querySelector("[data-pointer-surface]")!)

      await waitFor(() => {
        expect(
          getByRole("toolbar", { name: "Selection Actions" })
        ).not.toBeNull()
      })
      expect(queryByText("Highlight")).toBeNull()
    })

    it("switches to the action panel and back to the toolbar", async () => {
      const { getByText, getByTestId, queryByTestId } = renderWithProvider(
        <ActionHarness selection={pdfSelection} action={highlightAction} />
      )

      fireEvent.contextMenu(document.querySelector("[data-pointer-surface]")!)
      await waitFor(() => {
        expect(getByText("Highlight")).not.toBeNull()
      })

      // 点击动作按钮 → 切换到面板
      fireEvent.click(getByText("Highlight"))
      await waitFor(() => {
        expect(getByTestId("highlight-palette")).not.toBeNull()
      })

      // backToMenu → 返回主菜单
      fireEvent.click(getByText("Back"))
      await waitFor(() => {
        expect(queryByTestId("highlight-palette")).toBeNull()
      })
      expect(getByText("Highlight")).not.toBeNull()
    })

    it("displays translation result directly under the capsule toolbar and allows toggling", async () => {
      const { getByText, queryByText } = renderWithProvider(
        <ActionHarness selection={pdfSelection} action={highlightAction} />
      )

      fireEvent.contextMenu(document.querySelector("[data-pointer-surface]")!)
      await waitFor(() => {
        expect(getByText("Translate")).not.toBeNull()
      })

      // 点击 Translate -> 工具栏保持可见，下方展开翻译面板
      fireEvent.click(getByText("Translate"))
      await waitFor(() => {
        expect(getByText("translated text")).not.toBeNull()
        expect(getByText("Copy translation")).not.toBeNull()
      })
      // 工具栏上的其他胶囊按钮依然可用
      expect(getByText("Copy content")).not.toBeNull()
      expect(getByText("Highlight")).not.toBeNull()

      // 再次点击 Translate -> 收起翻译面板
      fireEvent.click(getByText("Translate"))
      await waitFor(() => {
        expect(queryByText("translated text")).toBeNull()
      })
    })

    it("seamlessly switches between Translate panel and Highlight palette directly from toolbar", async () => {
      const { getByText, getByTestId, queryByTestId, queryByText } =
        renderWithProvider(
          <ActionHarness selection={pdfSelection} action={highlightAction} />
        )

      fireEvent.contextMenu(document.querySelector("[data-pointer-surface]")!)
      await waitFor(() => {
        expect(getByText("Translate")).not.toBeNull()
        expect(getByText("Highlight")).not.toBeNull()
      })

      // 1. 展开翻译
      fireEvent.click(getByText("Translate"))
      await waitFor(() => {
        expect(getByText("translated text")).not.toBeNull()
      })

      // 2. 直接点击高亮 -> 切换到底部高亮调色板，无需返回
      fireEvent.click(getByText("Highlight"))
      await waitFor(() => {
        expect(queryByText("translated text")).toBeNull()
        expect(getByTestId("highlight-palette")).not.toBeNull()
      })

      // 3. 直接在工具栏点击“复制内容” -> 执行并关闭菜单
      fireEvent.click(getByText("Copy content"))
      await waitFor(() => {
        expect(queryByTestId("highlight-palette")).toBeNull()
      })
    })

    it("closes the capsule toolbar and open panel when left clicking outside", async () => {
      const { getByText, queryByRole, getByRole } = renderWithProvider(
        <ActionHarness selection={pdfSelection} action={highlightAction} />
      )

      fireEvent.contextMenu(document.querySelector("[data-pointer-surface]")!)
      await waitFor(() => {
        expect(getByText("Translate")).not.toBeNull()
      })

      // 展开翻译面板
      fireEvent.click(getByText("Translate"))
      await waitFor(() => {
        expect(
          getByRole("region", { name: "Selection Actions and Details" })
        ).not.toBeNull()
      })

      // 左键点击周围空白区域（document.body）
      fireEvent.pointerDown(document.body, { button: 0 })
      await waitFor(() => {
        expect(queryByRole("toolbar")).toBeNull()
        expect(
          queryByRole("region", { name: "Selection Actions and Details" })
        ).toBeNull()
      })
    })
  })
})
