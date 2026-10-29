import { beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "./notify"
import { useAppUiStore } from "@/stores/app-ui-store"

describe("notify", () => {
  beforeEach(() => useAppUiStore.getState().clearAlerts())

  it("routes toasts into the status bar alerts instead of a popup", () => {
    const onClick = vi.fn()
    toast.success("Saved")
    toast.error("Failed", { description: "detail" })
    toast("Opened elsewhere", { action: { label: "Switch", onClick } })

    const alerts = useAppUiStore.getState().alerts
    expect(alerts.map((alert) => [alert.level, alert.message])).toEqual([
      ["info", "Saved"],
      ["error", "Failed"],
      ["info", "Opened elsewhere"],
    ])
    expect(alerts[1].detail).toBe("detail")
    const action = alerts[2].actions?.[0]
    if (action && "run" in action) action.run()
    expect(onClick).toHaveBeenCalled()
  })
})
