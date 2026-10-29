export interface MenuAnchor {
  left: number
  top: number
  right: number
  bottom: number
}

export interface ElementSize {
  width: number
  height: number
}

export interface ViewportSize {
  width: number
  height: number
}

export interface ComputeMenuPositionOptions {
  /** Padding kept between the menu and viewport edges. Default is 12px. */
  margin?: number
  /** Gap between the anchor and the menu. Default is 8px. */
  gap?: number
  /** Preferred vertical placement. Default is 'above'. */
  preferredPlacement?: "above" | "below"
  /** 不因空间不足翻到另一侧。原生 WebView 下方会被挡住。 */
  forcePlacement?: "above" | "below"
  /** 菜单顶边不得高于此值，避免盖住窗口 Tab 栏。 */
  minTop?: number
}

export interface MenuPosition {
  left: number
  top: number
  placement: "above" | "below"
}

const DEFAULT_MARGIN = 12
const DEFAULT_GAP = 8

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * 计算浮动菜单 / 胶囊工具栏在视口内的安全坐标。
 *
 * - 水平方向：默认对齐选中区域或点击点的水平中心。当靠近屏幕左右边缘时，
 *   自动向屏幕内侧平移偏移（"往旁边显示"），避免被视口边界挤压或导致文字折行变形。
 * - 垂直方向：默认优先在锚点上方显示；若上方空间不足，自动翻转至下方；若两边均不足，
 *   选择空间更大的一侧并限制在视口边界内。
 */
export function computeMenuPosition(
  anchor: MenuAnchor,
  size: ElementSize,
  viewport: ViewportSize,
  options: ComputeMenuPositionOptions = {}
): MenuPosition {
  const margin = options.margin ?? DEFAULT_MARGIN
  const gap = options.gap ?? DEFAULT_GAP
  const preferredPlacement = options.preferredPlacement ?? "above"
  const forcePlacement = options.forcePlacement

  // 1. 水平定位：以锚点水平中心为基准，向内平移收敛
  const anchorCenterX = (anchor.left + anchor.right) / 2
  const rawLeft = anchorCenterX - size.width / 2
  const left = clamp(rawLeft, margin, viewport.width - size.width - margin)

  // 2. 垂直定位：根据上下可用空间动态决策
  const roomAbove = anchor.top - margin
  const roomBelow = viewport.height - anchor.bottom - margin
  const neededHeight = size.height + gap

  let placement: "above" | "below"
  if (forcePlacement) {
    placement = forcePlacement
  } else if (preferredPlacement === "above") {
    if (roomAbove >= neededHeight) {
      placement = "above"
    } else if (roomBelow >= neededHeight) {
      placement = "below"
    } else {
      placement = roomAbove >= roomBelow ? "above" : "below"
    }
  } else {
    if (roomBelow >= neededHeight) {
      placement = "below"
    } else if (roomAbove >= neededHeight) {
      placement = "above"
    } else {
      placement = roomBelow >= roomAbove ? "below" : "above"
    }
  }

  const rawTop =
    placement === "above" ? anchor.top - gap - size.height : anchor.bottom + gap

  let top = clamp(rawTop, margin, viewport.height - size.height - margin)
  if (options.minTop != null) {
    top = Math.max(top, options.minTop)
  }

  return { left, top, placement }
}
