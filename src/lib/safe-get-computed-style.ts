/**
 * Installs a defensive wrapper around window.getComputedStyle to gracefully handle
 * non-Element arguments (e.g. upstream bug in pdfjs-dist TextLayerBuilder calling
 * getComputedStyle(undefined) during global selectionchange events).
 */
export function installSafeGetComputedStyle(): void {
  if (
    typeof window === "undefined" ||
    typeof window.getComputedStyle !== "function"
  ) {
    return
  }

  const target = window.getComputedStyle as typeof window.getComputedStyle & {
    __berth_safe_guarded__?: boolean
  }
  if (target.__berth_safe_guarded__) {
    return
  }

  const originalGetComputedStyle = window.getComputedStyle.bind(window)
  let fallbackStyle: CSSStyleDeclaration | null = null

  const getFallbackStyle = (): CSSStyleDeclaration => {
    if (!fallbackStyle && typeof document !== "undefined") {
      try {
        const dummy = document.createElement("div")
        fallbackStyle = dummy.style
      } catch {
        fallbackStyle = {} as CSSStyleDeclaration
      }
    }
    return fallbackStyle ?? ({} as CSSStyleDeclaration)
  }

  const safeGetComputedStyle = (
    elt: Element,
    pseudoElt?: string | null
  ): CSSStyleDeclaration => {
    if (!elt || typeof (elt as unknown as Node).nodeType !== "number") {
      return getFallbackStyle()
    }
    try {
      return originalGetComputedStyle(elt, pseudoElt)
    } catch {
      return getFallbackStyle()
    }
  }

  safeGetComputedStyle.__berth_safe_guarded__ = true
  window.getComputedStyle =
    safeGetComputedStyle as typeof window.getComputedStyle
}
