"use client"

import { useWorkspaceBackground } from "@/hooks/use-appearance"
import { FILL_MODE_STYLE } from "@/lib/workspace/workspace-background"

const MAX_TERMINAL_BACKGROUND_OVERLAY_OPACITY = 0.45

export function resolveTerminalBackgroundOverlayOpacity(
  maskOpacity: number
): number {
  return (
    Math.round(
      Math.min(
        MAX_TERMINAL_BACKGROUND_OVERLAY_OPACITY,
        Math.max(0, 1 - maskOpacity)
      ) * 100
    ) / 100
  )
}

export function TerminalBackgroundOverlay({ visible }: { visible: boolean }) {
  const {
    workspaceBgEnabled,
    workspaceBgImageUrl,
    workspaceBgMaskOpacity,
    workspaceBgImageBlur,
    workspaceBgFillMode,
  } = useWorkspaceBackground()

  if (!visible || !workspaceBgEnabled || !workspaceBgImageUrl) return null

  const fillStyle = FILL_MODE_STYLE[workspaceBgFillMode]
  const overscan = workspaceBgImageBlur

  return (
    <div
      aria-hidden
      data-terminal-background-overlay="true"
      className="pointer-events-none absolute inset-0 z-[1] overflow-hidden select-none"
      style={{
        opacity: resolveTerminalBackgroundOverlayOpacity(
          workspaceBgMaskOpacity
        ),
      }}
    >
      <div
        className="absolute bg-center"
        style={{
          inset: -overscan,
          backgroundAttachment: "fixed",
          backgroundImage: `url("${workspaceBgImageUrl}")`,
          backgroundSize: fillStyle.size,
          backgroundRepeat: fillStyle.repeat,
          filter: workspaceBgImageBlur
            ? `blur(${workspaceBgImageBlur}px)`
            : undefined,
        }}
      />
    </div>
  )
}
