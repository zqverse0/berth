import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MobileTerminalKeys } from "./mobile-terminal-keys"

const sendInput = vi.fn()

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
  beforeEach(() => {
    sendInput.mockReset()
  })

  it("emits the extra keys through the personal-console input path", async () => {
    const user = userEvent.setup()
    const onCtrl = vi.fn()
    render(
      <MobileTerminalKeys
        terminalId="t1"
        ctrlArmed={false}
        onCtrlArmedChange={onCtrl}
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
      />
    )
    await user.click(screen.getByRole("button", { name: "Ctrl" }))
    expect(onCtrl).toHaveBeenLastCalledWith(false)
    expect(sendInput).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Tab" }))
    expect(onCtrl).toHaveBeenLastCalledWith(false)
  })
})
