/**
 * 主窗口的提示统一进左下角告警中心（状态栏），不弹窗；调用形状沿用 sonner 的 `toast`。
 * 独立的提交 / 推送 / 合并 / 贮藏窗口没有状态栏，仍直接用 sonner。
 */
import { useAppUiStore, type AlertLevel } from "@/stores/app-ui-store"

interface NotifyOptions {
  description?: string
  action?: { label: string; onClick: () => void }
}

function push(level: AlertLevel) {
  return (message: string, options?: NotifyOptions) => {
    const action = options?.action
    useAppUiStore
      .getState()
      .pushAlert(
        level,
        message,
        options?.description,
        action ? [{ label: action.label, run: action.onClick }] : undefined
      )
  }
}

const info = push("info")

export const toast = Object.assign(info, {
  success: info,
  info,
  message: info,
  warning: push("warning"),
  error: push("error"),
})
