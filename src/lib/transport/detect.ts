export type TransportEnvironment = "tauri" | "unsupported"

export function detectEnvironment(): TransportEnvironment {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return "tauri"
  }
  return "unsupported"
}

/** 经 tailnet 用浏览器打开（宿主注入的 shim 打的标记）：链路慢，后台轮询要放缓。 */
export function isRemoteBrowser(): boolean {
  return typeof window !== "undefined" && "__BERTH_REMOTE__" in window
}

export function assertTauriEnvironment(): void {
  if (detectEnvironment() !== "tauri") {
    throw new Error(
      "Berth requires the desktop app runtime. Browser/web mode is no longer supported."
    )
  }
}
