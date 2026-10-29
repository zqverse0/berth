import { act } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import {
  createAgentLaunchController,
  useAgentLaunchStore,
} from "./agent-launch-store"

const initialRequest = {
  folderId: 7,
  workingDirectory: "/repo",
  preferredAgentType: "codex" as const,
}

describe("agent launch store", () => {
  beforeEach(() => {
    useAgentLaunchStore.setState({ request: null })
  })

  it("stores a project launch request without an ACP phase", () => {
    act(() => useAgentLaunchStore.getState().requestLaunch(initialRequest))
    expect(useAgentLaunchStore.getState().request).toEqual(initialRequest)
  })

  it("consumes the initial prompt once", () => {
    const store = createAgentLaunchController()
    const request = {
      ...initialRequest,
      initialDraft: {
        blocks: [{ type: "text" as const, text: "Fix it" }],
        displayText: "Fix it",
      },
    }
    store.getState().requestLaunch(request)
    expect(store.getState().consumeInitialDraft()).toEqual(request.initialDraft)
    expect(store.getState().consumeInitialDraft()).toBeNull()
  })

  it("keeps the existing draft prompt while aligning its selected Agent", () => {
    const store = createAgentLaunchController()
    store.getState().requestLaunch({
      ...initialRequest,
      initialDraft: {
        blocks: [{ type: "text", text: "Keep" }],
        displayText: "Keep",
      },
    })
    store.getState().ensureRequest({
      ...initialRequest,
      preferredAgentType: "claude_code",
    })
    expect(store.getState().request).toMatchObject({
      preferredAgentType: "claude_code",
      initialDraft: { displayText: "Keep" },
    })
  })
})
