import { useAppUiStore } from "@/stores/app-ui-store"

export function reportAgentLaunchAlert(message: string, detail?: string): void {
  const trimmedDetail = detail?.trim()
  useAppUiStore
    .getState()
    .pushAlert(
      "error",
      message,
      trimmedDetail && trimmedDetail !== message ? trimmedDetail : undefined
    )
}
