import { describe, expect, it } from "vitest"

import {
  isTranslateProviderId,
  translateText,
  TRANSLATE_PROVIDER_AUTO,
} from "./translate"

describe("translateText", () => {
  it("rejects empty text before calling host", async () => {
    await expect(translateText({ text: "  " })).rejects.toThrow("Empty text")
  })
})

describe("isTranslateProviderId", () => {
  it("accepts auto, free, and commercial ids", () => {
    expect(isTranslateProviderId(TRANSLATE_PROVIDER_AUTO)).toBe(true)
    expect(isTranslateProviderId("tencenttransmart")).toBe(true)
    expect(isTranslateProviderId("openaiCompatible")).toBe(true)
    expect(isTranslateProviderId("unknown")).toBe(false)
  })
})
