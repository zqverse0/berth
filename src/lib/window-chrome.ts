/**
 * Shared geometry for the desktop window-chrome corner overlays.
 *
 * The aux / terminal cluster (top-right) is pinned to fixed overlays at the window's corners so
 * they never move — and never re-mount — when the side panels open or close
 * (that re-parenting is what used to make them flicker). Because the overlays
 * float ABOVE whichever column owns that edge, the column must reserve exactly
 * the overlay's width so its tabs / content never render underneath. Keeping the
 * overlay width and the column reservation in one place guarantees they agree.
 */

import { isDesktop, isRemoteBrowser } from "@/lib/transport"

/** 有原生窗口装饰（macOS 红绿灯、Windows/Linux 标题栏按钮）：只有桌面窗口有；经 tailnet 打开的浏览器页没有。 */
export function hasNativeWindowChrome(): boolean {
  return isDesktop() && !isRemoteBrowser()
}

/**
 * Clearance for the native macOS traffic lights, which float over the window's
 * top-left corner (nudged to Y=21 for the h-10 bar in the Rust window config).
 * The left cluster sits to their right.
 */
export const MAC_TRAFFIC_LIGHT_INSET = 76

/**
 * Windows/Linux caption buttons (min / max / close) occupy the window's
 * top-right corner. Mirrors `WINDOW_CONTROLS_WIDTH` in window-controls.tsx; the
 * right cluster sits to their left.
 */
export const WINDOW_CAPTION_WIDTH = 138

/**
 * The ActivityBar (`w-12`, rem-sized) owns the window's left edge and hosts the
 * sidebar toggle, open folder and settings; there is no top-left overlay.
 */
export const ACTIVITY_BAR_WIDTH = 48

/** Right cluster: aux panel toggle + terminal launcher/shortcuts. */
export const RIGHT_CHROME_CLUSTER = 80

/**
 * Scale a DOM button-cluster width by the app's rem-based zoom.
 *
 * The app "zoom" scales the root font-size (`documentElement.style.fontSize =
 * 16 * zoom/100`, see AppearanceProvider), so the rem-sized chrome buttons
 * (`h-6 w-6`, `gap-1`, `pl-3`/`pr-3`) grow with zoom. Their containers must grow
 * by the same factor or the buttons overflow and get clipped at high zoom. The
 * NATIVE insets do NOT scale this way — the macOS traffic lights keep a constant
 * horizontal inset (only their Y shifts with zoom, see `traffic_light_position_at`
 * in commands/windows.rs) and the Windows/Linux caption buttons are fixed 46px
 * each — so callers add those separately, outside this helper.
 */
function scaleCluster(px: number, zoom: number): number {
  return Math.round((px * zoom) / 100)
}

/**
 * Width the column right of the ActivityBar reserves at its top-left: only the
 * part of the macOS traffic lights the (zoom-scaled) activity bar doesn't cover.
 */
export function leftChromeReserve(macInset: boolean, zoom = 100): number {
  if (!macInset) return 0
  return Math.max(
    0,
    MAC_TRAFFIC_LIGHT_INSET - scaleCluster(ACTIVITY_BAR_WIDTH, zoom)
  )
}

/**
 * Width the window's right-edge column reserves for the right overlay.
 * `winLinuxCaption` adds the native caption-button strip (desktop Win/Linux);
 * `zoom` (a percent, default 100) scales the rem-sized button cluster, while the
 * fixed native caption strip stays constant.
 */
export function rightChromeReserve(
  winLinuxCaption: boolean,
  zoom = 100
): number {
  return (
    scaleCluster(RIGHT_CHROME_CLUSTER, zoom) +
    (winLinuxCaption ? WINDOW_CAPTION_WIDTH : 0)
  )
}

/**
 * The right-edge overlay's OWN width — just the (zoom-scaled) button cluster.
 * The native caption strip isn't part of this box; it's cleared by the overlay's
 * `right` offset (see `FolderLayoutShell`), so only the cluster is measured here.
 */
export function rightChromeClusterWidth(zoom = 100): number {
  return scaleCluster(RIGHT_CHROME_CLUSTER, zoom)
}
