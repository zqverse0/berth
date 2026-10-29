/**
 * 缩放档位（百分比）。100 是默认。
 * 选用离散档位而非连续滑块，是为了与现有 ThemeMode 选择器保持视觉一致。
 */
export const ZOOM_LEVELS = [80, 90, 100, 110, 125, 150] as const

export type ZoomLevel = (typeof ZOOM_LEVELS)[number]

export const DEFAULT_ZOOM_LEVEL: ZoomLevel = 100
