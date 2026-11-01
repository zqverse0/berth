import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  MobileTerminalKeys,
  MobileTerminalSelectSheet,
} from "./mobile-terminal-keys"

const sendInput = vi.fn()
const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { error: toastError, success: toastSuccess },
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      ctrl: "Ctrl",
      escape: "Escape",
      tab: "Tab",
      ctrlC: "Ctrl+C",
      shiftTab: "Shift+Tab",
      up: "Up",
    }
    return map[key] ?? key
  },
}))

vi.mock("@/stores/terminal-runtime-store", () => ({
  getTerminalRuntimeActions: () => ({
    sendInput,
  }),
}))

function decode(data: Uint8Array | string): string {
  if (typeof data === "string") return data
  return new TextDecoder().decode(data)
}

describe("MobileTerminalKeys", () => {
  const noop = { onPaste: () => true, onSelect: () => {} }

  beforeEach(() => {
    sendInput.mockReset()
    toastError.mockReset()
    toastSuccess.mockReset()
  })

  it("emits the extra keys through the personal-console input path", async () => {
    const user = userEvent.setup()
    const onCtrl = vi.fn()
    render(
      <MobileTerminalKeys
        terminalId="t1"
        ctrlArmed={false}
        onCtrlArmedChange={onCtrl}
        {...noop}
      />
    )

    for (const name of ["Ctrl+C", "Escape", "Tab", "Shift+Tab", "Up"])
      await user.click(screen.getByRole("button", { name }))

    expect(sendInput.mock.calls.map((call) => decode(call[1]))).toEqual([
      "\u0003",
      "\u001b",
      "\t",
      "\u001b[Z",
      "\u001b[A",
    ])
    expect(sendInput.mock.calls.every((call) => call[0] === "t1")).toBe(true)
  })

  it("Ctrl arms the modifier instead of sending; any key disarms it", async () => {
    const user = userEvent.setup()
    const onCtrl = vi.fn()
    render(
      <MobileTerminalKeys
        terminalId="t1"
        ctrlArmed
        onCtrlArmedChange={onCtrl}
        {...noop}
      />
    )
    await user.click(screen.getByRole("button", { name: "Ctrl" }))
    expect(onCtrl).toHaveBeenLastCalledWith(false)
    expect(sendInput).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Tab" }))
    expect(onCtrl).toHaveBeenLastCalledWith(false)
  })

  it("paste reads the clipboard and reports a rejected multi-line paste", async () => {
    const user = userEvent.setup()
    const onPaste = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
    const readText = vi.fn().mockResolvedValue("a\nb")
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText },
    })
    render(
      <MobileTerminalKeys
        terminalId="t1"
        ctrlArmed={false}
        onCtrlArmedChange={vi.fn()}
        onPaste={onPaste}
        onSelect={vi.fn()}
      />
    )
    await user.click(screen.getByRole("button", { name: "paste" }))
    expect(onPaste).toHaveBeenLastCalledWith("a\nb")
    expect(toastError).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "paste" }))
    expect(toastError).toHaveBeenCalledWith("pasteMultiline")
  })

  it("paste falls back to a prompt without clipboard.readText (plain HTTP)", async () => {
    const user = userEvent.setup()
    const onPaste = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {},
    })
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("ls")
    render(
      <MobileTerminalKeys
        terminalId="t1"
        ctrlArmed={false}
        onCtrlArmedChange={vi.fn()}
        onPaste={onPaste}
        onSelect={vi.fn()}
      />
    )
    await user.click(screen.getByRole("button", { name: "paste" }))
    expect(prompt).toHaveBeenCalled()
    expect(onPaste).toHaveBeenCalledWith("ls")
    prompt.mockRestore()
  })

  it("select opens the native selection sheet", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <MobileTerminalKeys
        terminalId="t1"
        ctrlArmed={false}
        onCtrlArmedChange={vi.fn()}
        onPaste={() => true}
        onSelect={onSelect}
      />
    )
    await user.click(screen.getByRole("button", { name: "select" }))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(sendInput).not.toHaveBeenCalled()
  })

  it("the selection sheet shows plain selectable text and closes", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <MobileTerminalSelectSheet
        before={"old line\n"}
        after="current screen"
        fontFamily="monospace"
        onClose={onClose}
      />
    )
    expect(screen.getByText(/old line/).textContent).toContain("current screen")
    await user.click(screen.getByRole("button", { name: "done" }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
