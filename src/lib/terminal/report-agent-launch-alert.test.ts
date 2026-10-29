import { beforeEach, describe, expect, it } from "vitest"
import { useAppUiStore } from "@/stores/app-ui-store"
import { reportAgentLaunchAlert } from "./report-agent-launch-alert"

describe("report-agent-launch-alert", () => {
  beforeEach(() => {
    useAppUiStore.getState().clearAlerts()
  })

  it("pushes a durable status-bar alert", () => {
    reportAgentLaunchAlert(
      "启动 Pi 失败",
      "Error: Unknown model: qwen-3.7-plus"
    )
    const alerts = useAppUiStore.getState().alerts
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({
      level: "error",
      message: "启动 Pi 失败",
      detail: "Error: Unknown model: qwen-3.7-plus",
    })
  })
})
