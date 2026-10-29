import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SandboxedHtmlDocument } from "./sandboxed-html-document"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

afterEach(cleanup)

function frameOf(container: HTMLElement): HTMLIFrameElement {
  const frame = container.querySelector("iframe")
  expect(frame).not.toBeNull()
  return frame as HTMLIFrameElement
}

describe("SandboxedHtmlDocument", () => {
  it("renders srcdoc in an untrusted sandbox without allow-same-origin", () => {
    const { container } = render(
      <SandboxedHtmlDocument srcDoc="<p>hello</p>" title="doc" />
    )
    const frame = frameOf(container)
    expect(frame.getAttribute("srcdoc")).toBe("<p>hello</p>")
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
  })

  it("keeps the opaque origin in trusted mode too", () => {
    const { container } = render(
      <SandboxedHtmlDocument srcDoc="<p>x</p>" title="doc" trusted />
    )
    const sandbox = frameOf(container).getAttribute("sandbox") ?? ""
    expect(sandbox).toContain("allow-scripts")
    expect(sandbox).not.toContain("allow-same-origin")
    expect(sandbox).not.toContain("allow-top-navigation")
  })

  it("renders nothing without a document (loading/error states stay empty)", () => {
    const { container } = render(
      <SandboxedHtmlDocument srcDoc="" title="doc" />
    )
    expect(container.querySelector("iframe")).toBeNull()
  })

  it("re-keys the frame on trust changes so the sandbox flags are re-applied", () => {
    const { container, rerender } = render(
      <SandboxedHtmlDocument srcDoc="<p>x</p>" title="doc" />
    )
    const first = frameOf(container)
    rerender(<SandboxedHtmlDocument srcDoc="<p>x</p>" title="doc" trusted />)
    // key 切换会重建 iframe：srcdoc 一致但 sandbox 契约换档
    const second = frameOf(container)
    expect(second.getAttribute("sandbox")).toContain("allow-popups")
    expect(second).not.toBe(first)
  })
})
