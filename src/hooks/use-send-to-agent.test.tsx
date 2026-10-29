import { act, renderHook } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { copyTextFromMenu } from "@/lib/utils"
import { useTabStore } from "@/stores/tab-store"
import { useTerminalRuntimeStore } from "@/stores/terminal-runtime-store"
import { useSendToAgent } from "@/hooks/use-send-to-agent"

vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  copyTextFromMenu: vi.fn().mockResolvedValue(true),
}))

const wrapper = ({ children }: { children: ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={enMessages}>
    {children}
  </NextIntlClientProvider>
)

function activeTerminal(agentType: string | null) {
  useTabStore.setState({
    activeTabId: "tab-1",
    tabs: [
      {
        kind: "terminal",
        id: "tab-1",
        terminalId: "t1",
        backendInstanceId: "b",
        folderId: null,
        agentType: agentType as never,
        title: "Pi",
        initialCwd: "/tmp",
        shell: "bash",
        detachedFolderLabel: null,
        detachedFolderPath: null,
        isPinned: false,
      },
    ],
  })
}

describe("useSendToAgent", () => {
  const pasteText = vi.fn().mockResolvedValue({ ok: true })

  beforeEach(() => {
    vi.clearAllMocks()
    useTerminalRuntimeStore.setState({ pasteText })
  })

  it("never pastes into a plain shell; copies instead", async () => {
    activeTerminal(null)
    const { result } = renderHook(() => useSendToAgent(), { wrapper })
    expect(result.current.label).toBe("Send to Agent")

    await act(() => result.current.send("acme/demo "))
    expect(pasteText).not.toHaveBeenCalled()
    expect(copyTextFromMenu).toHaveBeenCalledWith("acme/demo ")
  })

  it("pastes into the active Agent terminal without submitting", async () => {
    activeTerminal("claude_code")
    const { result } = renderHook(() => useSendToAgent(), { wrapper })
    expect(result.current.label).toBe("Send to Pi")

    await act(() => result.current.send("acme/demo "))
    expect(pasteText).toHaveBeenCalledWith(
      "t1",
      "acme/demo ",
      expect.objectContaining({ submit: false, tabId: "tab-1" })
    )
    expect(copyTextFromMenu).not.toHaveBeenCalled()
  })

  it("sends a whole file as one line with the path relative to the Agent cwd", async () => {
    activeTerminal("claude_code")
    const { result } = renderHook(() => useSendToAgent(), { wrapper })

    await act(() =>
      result.current.sendFile({
        absolutePath: "/tmp/src/app.ts",
        fileName: "app.ts",
      })
    )
    const sent = pasteText.mock.calls[0]?.[1] as string
    expect(sent).toContain("src/app.ts")
    expect(sent).not.toContain("/tmp/")
    expect(sent).not.toMatch(/[\r\n]/)
  })
})
