export type SplitDirection = "horizontal" | "vertical"

export interface SplitPaneConstraint {
  id: string
  order?: number
  defaultSize?: number
  weight?: number
  minSize?: number
  maxSize?: number
  minSizePx?: number
  maxSizePx?: number
  collapsed?: boolean
  visible?: boolean
  collapsible?: boolean
  collapsedSizePx?: number
}

export interface SplitPaneBounds {
  id: string
  min: number
  max: number
  weight: number
  collapsible: boolean
  collapsedSize: number
  collapsed: boolean
  visible: boolean
}

export interface SplitTrack extends SplitPaneBounds {
  size: number
  offset: number
}

export interface SplitLayoutResult {
  containerSize: number
  availableSize: number
  separatorSizes: readonly number[]
  sizes: readonly number[]
  percentages: readonly number[]
  tracks: readonly SplitTrack[]
}

export interface SplitPaneGeometry {
  id: string
  left: number
  top: number
  width: number
  height: number
  size: number
  offset: number
}

export interface SolveSplitLayoutOptions {
  containerSize: number
  panes: readonly SplitPaneConstraint[]
  /** 初始 pane 像素尺寸，优先于百分比。 */
  initialPixels?: readonly number[]
  /** 初始 pane 尺寸，占可用 track 空间的百分比。 */
  initialPercentages?: readonly number[]
  /** 每个边界一项；缺失项使用一个 CSS 像素。 */
  separatorSizes?: readonly number[]
}

const DEFAULT_SEPARATOR_SIZE = 1
const EPSILON = 0.0001

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback
}

function positiveOr(value: number | undefined, fallback: number): number {
  const next = finiteOr(value, fallback)
  return next > 0 ? next : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function normalizeWeights(
  panes: readonly SplitPaneConstraint[],
  initialPercentages: readonly number[] | undefined
): number[] {
  const values = panes.map((pane, index) => {
    if (initialPercentages?.[index] !== undefined) {
      return Math.max(0, finiteOr(initialPercentages[index], 0))
    }
    if (pane.defaultSize !== undefined) {
      return Math.max(0, finiteOr(pane.defaultSize, 0))
    }
    return positiveOr(pane.weight, 1)
  })

  const total = sum(values)
  if (total > EPSILON) return values.map((value) => value / total)

  const fallback = panes.map((pane) => positiveOr(pane.weight, 1))
  const fallbackTotal = sum(fallback)
  return fallback.map((value) => value / (fallbackTotal || 1))
}

function resolveBounds(
  panes: readonly SplitPaneConstraint[],
  availableSize: number
): SplitPaneBounds[] {
  const bounds = panes.map((pane) => {
    const hidden = pane.visible === false
    const collapsed = pane.collapsed === true || hidden
    const collapsedSize = hidden
      ? 0
      : collapsed
        ? clamp(
            finiteOr(pane.collapsedSizePx, 0),
            0,
            Math.max(0, availableSize)
          )
        : 0
    const minFromPercent =
      availableSize * (Math.max(0, finiteOr(pane.minSize, 0)) / 100)
    const maxFromPercent = availableSize * (finiteOr(pane.maxSize, 100) / 100)
    const rawMin = collapsed
      ? collapsedSize
      : pane.collapsible
        ? collapsedSize
        : Math.max(0, finiteOr(pane.minSizePx, minFromPercent))
    const rawMax = collapsed
      ? collapsedSize
      : Math.max(rawMin, finiteOr(pane.maxSizePx, maxFromPercent))

    return {
      id: pane.id,
      min: Math.min(rawMin, availableSize),
      max: Math.min(Math.max(rawMin, rawMax), availableSize),
      weight: positiveOr(pane.weight, 1),
      collapsible: pane.collapsible === true,
      collapsedSize,
      collapsed,
      visible: pane.visible !== false,
    }
  })

  const minimumTotal = sum(bounds.map((bound) => bound.min))
  if (minimumTotal <= availableSize + EPSILON || minimumTotal <= EPSILON) {
    return bounds
  }

  // An impossible set of pixel minima should not make the CSS grid overflow.
  // Preserve the relative minimums and keep the solver's output finite; the
  // next real container measurement will solve the constraints again.
  const scale = availableSize / minimumTotal
  return bounds.map((bound) => ({
    ...bound,
    min: bound.min * scale,
    max: Math.max(bound.min * scale, bound.max * scale),
  }))
}

function distribute(
  sizes: number[],
  amount: number,
  candidates: readonly number[],
  capacity: (index: number, size: number) => number,
  weights: readonly number[]
): number {
  let remaining = amount
  let open = candidates.filter(
    (index) => capacity(index, sizes[index]) > EPSILON
  )

  while (remaining > EPSILON && open.length > 0) {
    const totalWeight = sum(open.map((index) => positiveOr(weights[index], 1)))
    if (totalWeight <= EPSILON) break

    let consumed = 0
    const saturated: number[] = []
    for (const index of open) {
      const share = (remaining * positiveOr(weights[index], 1)) / totalWeight
      const addition = Math.min(share, capacity(index, sizes[index]))
      sizes[index] += addition
      consumed += addition
      if (capacity(index, sizes[index]) <= EPSILON) saturated.push(index)
    }

    if (consumed <= EPSILON) break
    remaining -= consumed
    if (saturated.length > 0) {
      const saturatedSet = new Set(saturated)
      open = open.filter((index) => !saturatedSet.has(index))
    }
  }

  return amount - remaining
}

function fitSizes(
  rawSizes: readonly number[],
  bounds: readonly SplitPaneBounds[],
  availableSize: number,
  weights: readonly number[]
): number[] {
  const sizes = rawSizes.map((size, index) =>
    clamp(finiteOr(size, 0), bounds[index].min, bounds[index].max)
  )
  const currentTotal = sum(sizes)

  if (currentTotal < availableSize - EPSILON) {
    distribute(
      sizes,
      availableSize - currentTotal,
      sizes.map((_, index) => index),
      (index, size) => Math.max(0, bounds[index].max - size),
      weights
    )
  } else if (currentTotal > availableSize + EPSILON) {
    distribute(
      sizes,
      currentTotal - availableSize,
      sizes.map((_, index) => index),
      (index, size) => Math.max(0, size - bounds[index].min),
      weights
    )
    // If the constraints are impossible, the scaled minima above should have
    // prevented this branch from overflowing. Round-off is corrected here so
    // the grid template always consumes exactly the available track space.
    const overflow = sum(sizes) - availableSize
    if (overflow > EPSILON) {
      const last = sizes.length - 1
      if (last >= 0) sizes[last] = Math.max(0, sizes[last] - overflow)
    }
  }

  return sizes
}

/**
 * 以像素求解 pane 尺寸。百分比约束基于扣除分隔线后的空间解析，嵌套的
 * 横向与纵向 group 无需测量子节点即可复用同一契约。
 */
export function solveSplitLayout(
  options: SolveSplitLayoutOptions
): SplitLayoutResult {
  const containerSize = Math.max(0, finiteOr(options.containerSize, 0))
  const separatorSizes = Array.from(
    { length: Math.max(0, options.panes.length - 1) },
    (_, index) =>
      Math.max(
        0,
        finiteOr(options.separatorSizes?.[index], DEFAULT_SEPARATOR_SIZE)
      )
  )
  const separatorTotal = sum(separatorSizes)
  const availableSize = Math.max(0, containerSize - separatorTotal)
  const bounds = resolveBounds(options.panes, availableSize)
  const percentages = normalizeWeights(
    options.panes,
    options.initialPercentages
  )
  const rawSizes = options.initialPixels
    ? options.panes.map((_, index) =>
        finiteOr(options.initialPixels?.[index], 0)
      )
    : percentages.map((percentage) => percentage * availableSize)
  const sizes = fitSizes(rawSizes, bounds, availableSize, percentages)
  const tracks: SplitTrack[] = []
  let offset = 0
  for (let index = 0; index < options.panes.length; index += 1) {
    const bound = bounds[index]
    const size = sizes[index] ?? 0
    tracks.push({ ...bound, size, offset })
    offset += size + (separatorSizes[index] ?? 0)
  }

  const finalSizes = tracks.map((track) => track.size)
  const finalTotal = sum(finalSizes)
  return {
    containerSize,
    availableSize,
    separatorSizes,
    sizes: finalSizes,
    percentages:
      finalTotal > EPSILON
        ? finalSizes.map((size) => (size / finalTotal) * 100)
        : finalSizes.map(() => 0),
    tracks,
  }
}

/** 将分隔线增量应用到一个 handle 两侧的相邻 pane。 */
export function resizeSplitLayout(
  sizes: readonly number[],
  bounds: readonly SplitPaneBounds[],
  handleIndex: number,
  delta: number
): number[] {
  const next = sizes.map((size, index) =>
    clamp(finiteOr(size, 0), bounds[index]?.min ?? 0, bounds[index]?.max ?? 0)
  )
  const leftIndex = handleIndex
  const rightIndex = handleIndex + 1
  if (!bounds[leftIndex] || !bounds[rightIndex] || !Number.isFinite(delta)) {
    return next
  }

  const left = next[leftIndex]
  const right = next[rightIndex]
  if (delta > 0) {
    const amount = Math.min(
      delta,
      bounds[leftIndex].max - left,
      right - bounds[rightIndex].min
    )
    next[leftIndex] = left + Math.max(0, amount)
    next[rightIndex] = right - Math.max(0, amount)
  } else if (delta < 0) {
    const amount = Math.min(
      -delta,
      left - bounds[leftIndex].min,
      bounds[rightIndex].max - right
    )
    next[leftIndex] = left - Math.max(0, amount)
    next[rightIndex] = right + Math.max(0, amount)
  }

  return next
}

export function buildSplitGridTemplate(
  sizes: readonly number[],
  separatorSizes: readonly number[]
): string {
  return sizes
    .flatMap((size, index) => {
      const pane = `${Math.max(0, size).toFixed(3)}px`
      const separator = separatorSizes[index]
      return separator === undefined
        ? [pane]
        : [pane, `${Math.max(0, separator).toFixed(3)}px`]
    })
    .join(" ")
}

export function sameSplitSizes(
  left: readonly number[],
  right: readonly number[],
  epsilon = 0.01
): boolean {
  return (
    left.length === right.length &&
    left.every((size, index) => Math.abs(size - (right[index] ?? 0)) <= epsilon)
  )
}

export interface SplitGestureSessionOptions {
  initialSizes: readonly number[]
  bounds: readonly SplitPaneBounds[]
  handleIndex: number
  startPosition: number
  threshold?: number
  onPreview: (sizes: readonly number[]) => void
  onCommit: (sizes: readonly number[]) => void
  onCancel: () => void
  requestAnimationFrame?: (callback: FrameRequestCallback) => number
  cancelAnimationFrame?: (id: number) => void
}

export interface SplitGestureSession {
  move(position: number): void
  flush(): void
  commit(): void
  cancel(): void
  dispose(): void
}

/**
 * 与 Pointer 无关的拖拽事务，只负责计算和 rAF 生命周期；DOM pointer capture
 * 由 React SplitHandle 外壳负责。
 */
export function createSplitGestureSession(
  options: SplitGestureSessionOptions
): SplitGestureSession {
  const raf =
    options.requestAnimationFrame ??
    (typeof requestAnimationFrame === "function"
      ? requestAnimationFrame.bind(globalThis)
      : null)
  const caf =
    options.cancelAnimationFrame ??
    (typeof cancelAnimationFrame === "function"
      ? cancelAnimationFrame.bind(globalThis)
      : null)

  let disposed = false
  let settled = false
  let frame: number | null = null
  let pending = false
  let current = [...options.initialSizes]
  let previewed = [...current]
  let engaged = (options.threshold ?? 0) <= 0

  const cancelFrame = () => {
    if (frame === null) return
    caf?.(frame)
    frame = null
  }

  const flush = () => {
    if (disposed || settled || !pending) return
    pending = false
    previewed = [...current]
    options.onPreview(previewed)
  }

  const schedule = () => {
    if (frame !== null || !raf) {
      if (!raf) flush()
      return
    }
    frame = raf(() => {
      frame = null
      flush()
    })
  }

  return {
    move(position) {
      if (disposed || settled || !Number.isFinite(position)) return
      const delta = position - options.startPosition
      if (!engaged && Math.abs(delta) < (options.threshold ?? 0)) return
      engaged = true
      current = resizeSplitLayout(
        options.initialSizes,
        options.bounds,
        options.handleIndex,
        delta
      )
      if (sameSplitSizes(current, previewed)) return
      pending = true
      schedule()
    },
    flush,
    commit() {
      if (disposed || settled) return
      flush()
      settled = true
      cancelFrame()
      options.onCommit([...current])
    },
    cancel() {
      if (disposed || settled) return
      settled = true
      cancelFrame()
      pending = false
      options.onCancel()
    },
    dispose() {
      if (disposed) return
      disposed = true
      settled = true
      pending = false
      cancelFrame()
    },
  }
}
