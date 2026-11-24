"use client"

import { useEffect, useState } from "react"

export type PlatformType = "macos" | "windows" | "linux" | "unknown"

export function detectPlatform(): PlatformType {
  if (typeof navigator === "undefined") return "unknown"

  const platform = navigator.platform.toLowerCase()
  const userAgent = navigator.userAgent.toLowerCase()

  if (platform.includes("mac") || userAgent.includes("mac os")) {
    return "macos"
  }

  if (platform.includes("win") || userAgent.includes("windows")) {
    return "windows"
  }

  if (
    platform.includes("linux") ||
    userAgent.includes("linux") ||
    userAgent.includes("x11")
  ) {
    return "linux"
  }

  return "unknown"
}

/** WebKit 内核（WebKitGTK / Safari）；Chromium（含 CEF）UA 也带 AppleWebKit，靠 `Chrome/` 区分。 */
export function isWebKitEngine(): boolean {
  if (typeof navigator === "undefined") return false
  const userAgent = navigator.userAgent
  return userAgent.includes("AppleWebKit/") && !userAgent.includes("Chrome/")
}

export function usePlatform() {
  const [platform, setPlatform] = useState<PlatformType>("unknown")

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setPlatform(detectPlatform())
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [])

  return {
    platform,
    isMac: platform === "macos",
    isWindows: platform === "windows",
    isLinux: platform === "linux",
  }
}
