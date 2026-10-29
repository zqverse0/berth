"use client"

import { useEffect } from "react"

/**
 * 手机软键盘弹出时，有的浏览器（iOS Safari）不缩布局视口，`fixed inset-0` 的界面下半截
 * 落在键盘后面。这里把可见区域（visualViewport）相对布局视口的上下缩进写进
 * `--vv-top` / `--vv-gap`，外壳与全屏面板据此贴着键盘上沿排版（同手机终端 App）。
 * 也有浏览器两者都缩，且先后不定：两边的 resize 都要重算，否则会留下过期的大缩进（黑屏）。
 */
export function useVisualViewportInsets(enabled: boolean): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!enabled || !viewport) return
    const root = document.documentElement
    const sync = () => {
      const gap = window.innerHeight - viewport.height - viewport.offsetTop
      root.style.setProperty("--vv-top", `${Math.max(0, viewport.offsetTop)}px`)
      root.style.setProperty("--vv-gap", `${Math.max(0, gap)}px`)
    }
    sync()
    viewport.addEventListener("resize", sync)
    viewport.addEventListener("scroll", sync)
    window.addEventListener("resize", sync)
    return () => {
      viewport.removeEventListener("resize", sync)
      viewport.removeEventListener("scroll", sync)
      window.removeEventListener("resize", sync)
      root.style.removeProperty("--vv-top")
      root.style.removeProperty("--vv-gap")
    }
  }, [enabled])
}
