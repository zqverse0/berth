import { Compartment, EditorState } from "@codemirror/state"
import { describe, expect, it } from "vitest"
import {
  EditorDocumentRegistry,
  type EditorDocumentRuntime,
} from "./document-registry"

function runtime(id: string): EditorDocumentRuntime {
  const registry = new EditorDocumentRegistry()
  const state = EditorState.create({ doc: id })
  const seed: EditorDocumentRuntime = {
    id,
    state,
    scrollTop: 0,
    appearance: new Compartment(),
    capabilities: new Compartment(),
    language: new Compartment(),
    visuals: new Compartment(),
    callbacks: new Compartment(),
  }
  registry.set(seed)
  return registry.get(id)!
}

describe("EditorDocumentRegistry", () => {
  it("uses stable tab identity instead of file content or path", () => {
    const registry = new EditorDocumentRegistry()
    const first = runtime("tab:first")
    const second = runtime("tab:second")

    registry.set(first)
    registry.set(second)

    expect(registry.size).toBe(2)
    expect(registry.get("tab:first")?.state.doc.toString()).toBe("tab:first")
  })

  it("releases documents that no longer own a live tab", () => {
    const registry = new EditorDocumentRegistry()
    registry.set(runtime("keep"))
    registry.set(runtime("close"))

    registry.retain(new Set(["keep"]))

    expect(registry.get("keep")).toBeDefined()
    expect(registry.get("close")).toBeUndefined()
  })
})
