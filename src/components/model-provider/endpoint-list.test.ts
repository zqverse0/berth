import { describe, expect, it } from "vitest"
import {
  endpointError,
  endpointExamples,
  outsideCommands,
  type EndpointRow,
} from "./endpoint-list"

const row = (patch: Partial<EndpointRow>): EndpointRow => ({
  kind: "chat",
  name: "",
  apiUrl: "https://x.example/v1",
  ...patch,
})

describe("endpointError", () => {
  it("accepts known kinds plus uniquely named other endpoints", () => {
    expect(
      endpointError([
        row({}),
        row({ kind: "other", name: "search", apiUrl: "https://s.example" }),
      ])
    ).toBeNull()
  })

  it("rejects bad, reserved and duplicate names", () => {
    expect(endpointError([row({ kind: "other", name: "Search" })])).toBe(
      "endpoints.nameInvalid"
    )
    expect(endpointError([row({ kind: "other", name: "" })])).toBe(
      "endpoints.nameInvalid"
    )
    expect(endpointError([row({ kind: "other", name: "chat" })])).toBe(
      "endpoints.nameReserved"
    )
    expect(endpointError([row({}), row({})])).toBe("endpoints.duplicate")
  })

  it("ignores rows without a URL", () => {
    expect(endpointError([row({ kind: "other", name: "", apiUrl: "" })])).toBe(
      null
    )
  })
})

describe("endpointExamples", () => {
  const address = "http://127.0.0.1:15722/p/3/chat"

  it("does not double the version segment the user already typed", () => {
    const [chat] = endpointExamples(row({}), address)
    expect(chat.code).toContain(`${address}/chat/completions`)
    const [bare] = endpointExamples(
      row({ apiUrl: "https://x.example" }),
      address
    )
    expect(bare.code).toContain(`${address}/v1/chat/completions`)
  })

  it("covers images and embeddings on the OpenAI-compatible endpoint", () => {
    const labels = endpointExamples(row({}), address).map((e) => e.label)
    expect(labels).toEqual(["chat", "image", "embedding", "sdk"])
  })

  it("points decision calls at /v1/systemone", () => {
    const [decision] = endpointExamples(
      row({ kind: "systemone", apiUrl: "https://api.typesafe.ai" }),
      "http://127.0.0.1:15722/p/73/systemone"
    )
    expect(decision.code).toContain(
      "http://127.0.0.1:15722/p/73/systemone/v1/systemone"
    )
  })
})

describe("outsideCommands", () => {
  it("fills in the provider id for script, .env and agent use", () => {
    expect(outsideCommands(68).map((item) => item.code)).toEqual([
      "berth provider run 68 -- python your_script.py",
      "berth provider env 68 --dotenv > .env",
      "berth provider run 68 --agent <tool-id>",
    ])
  })
})
