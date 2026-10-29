import type { CSSProperties } from "react"
import {
  buildSplitGridTemplate,
  type SplitDirection,
  type SplitLayoutResult,
  type SplitPaneGeometry,
} from "@/lib/workspace/split-view"

// 每个拖动帧都改写根节点的轨道变量。自定义属性默认可继承，改一次整棵子树都要
// 重算样式（WebKitGTK 实测约 25ms/帧）；只有根节点自己读它，所以注册为不继承。
// 用 JS 注册：Tailwind 会裁掉 CSS 里没被样式表引用的 @property。
if (typeof CSS !== "undefined" && "registerProperty" in CSS) {
  try {
    CSS.registerProperty({
      name: "--split-grid-template",
      syntax: "*",
      inherits: false,
    })
  } catch {
    // HMR 重新执行模块时已注册过。
  }
}

type SplitViewRootStyle = CSSProperties & Record<`--${string}`, string | number>
type SplitGridItemKind = "pane" | "handle"
export type SplitGeometryPhase = "preview" | "commit" | "external"

interface SplitViewDomRenderer {
  writeResult: (options: {
    root: HTMLElement | null
    direction: SplitDirection
    result: SplitLayoutResult
    phase: SplitGeometryPhase
    crossSize: number | null
    onGeometry?: (
      geometry: readonly SplitPaneGeometry[],
      phase: SplitGeometryPhase
    ) => void
  }) => readonly SplitPaneGeometry[]
}

export function sanitizeSplitDomId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-")
}

export function getSplitGridItemStyle(
  direction: SplitDirection,
  slot: number,
  kind: SplitGridItemKind
): CSSProperties {
  if (slot < 0) return {}
  if (direction === "vertical") {
    return {
      gridColumn: 1,
      gridRow: kind === "pane" ? slot * 2 + 1 : slot * 2 + 2,
    }
  }
  return {
    gridColumn: kind === "pane" ? slot * 2 + 1 : slot * 2 + 2,
    gridRow: 1,
  }
}

export function getSplitViewRootStyle(
  direction: SplitDirection,
  style: CSSProperties | undefined
): SplitViewRootStyle {
  const rootStyle: SplitViewRootStyle = {
    ...style,
    "--split-grid-template": "0px",
  }
  if (direction === "vertical") {
    rootStyle.gridTemplateColumns = "minmax(0, 1fr)"
    rootStyle.gridTemplateRows = "var(--split-grid-template)"
  } else {
    rootStyle.gridTemplateColumns = "var(--split-grid-template)"
    rootStyle.gridTemplateRows = "minmax(0, 1fr)"
  }
  return rootStyle
}

function getCrossSize(
  root: HTMLElement | null,
  direction: SplitDirection,
  fixedCrossSize: number | null
): number {
  if (fixedCrossSize !== null) return fixedCrossSize
  const rect = root?.getBoundingClientRect()
  return direction === "horizontal"
    ? rect?.height || root?.clientHeight || 0
    : rect?.width || root?.clientWidth || 0
}

function getPaneGeometry(
  result: SplitLayoutResult,
  direction: SplitDirection,
  crossSize: number
): SplitPaneGeometry[] {
  return result.tracks.map((track) =>
    direction === "horizontal"
      ? {
          id: track.id,
          left: track.offset,
          top: 0,
          width: track.size,
          height: crossSize,
          size: track.size,
          offset: track.offset,
        }
      : {
          id: track.id,
          left: 0,
          top: track.offset,
          width: crossSize,
          height: track.size,
          size: track.size,
          offset: track.offset,
        }
  )
}

/** 只向最近的 SplitView 根节点写 grid geometry，并复用已写入的 template。 */
export function createSplitViewDomRenderer(): SplitViewDomRenderer {
  let lastRoot: HTMLElement | null = null
  let lastTemplate: string | null = null

  return {
    writeResult({
      root,
      direction,
      result,
      phase,
      crossSize: fixedCrossSize,
      onGeometry,
    }) {
      if (root) {
        const template = buildSplitGridTemplate(
          result.sizes,
          result.separatorSizes
        )
        if (root !== lastRoot || template !== lastTemplate) {
          root.style.setProperty("--split-grid-template", template)
          lastRoot = root
          lastTemplate = template
        }
      }

      const geometry = getPaneGeometry(
        result,
        direction,
        getCrossSize(root, direction, fixedCrossSize)
      )
      onGeometry?.(geometry, phase)
      return geometry
    },
  }
}
