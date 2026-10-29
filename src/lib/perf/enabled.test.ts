import { afterEach, describe, expect, it, vi } from "vitest"
import {
  perfEnabled,
  setEnabled,
  isTransportActive,
  setTransportActive,
  __resetTransportActiveForTests,
  _internal,
} from "./enabled"

describe("enabled", () => {
  afterEach(() => {
    try {
      window.localStorage.removeItem(_internal.STORAGE_KEY)
    } catch {
      // ignore
    }
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    __resetTransportActiveForTests()
  })

  it("returns false by default", () => {
    expect(perfEnabled()).toBe(false)
  })

  it("returns true after setEnabled(true)", () => {
    setEnabled(true)
    expect(perfEnabled()).toBe(true)
  })

  it("returns false after setEnabled(false)", () => {
    setEnabled(true)
    setEnabled(false)
    expect(perfEnabled()).toBe(false)
  })

  it("returns false in production regardless of flag", () => {
    vi.stubEnv("NODE_ENV", "production")
    setEnabled(true)
    expect(perfEnabled()).toBe(false)
  })

  it("persists to localStorage", () => {
    setEnabled(true)
    expect(window.localStorage.getItem(_internal.STORAGE_KEY)).toBe("1")
    setEnabled(false)
    expect(window.localStorage.getItem(_internal.STORAGE_KEY)).toBeNull()
  })
})

describe("transport active state", () => {
  afterEach(() => {
    __resetTransportActiveForTests()
  })

  it("is false by default", () => {
    expect(isTransportActive()).toBe(false)
  })

  it("can be set to true", () => {
    setTransportActive(true)
    expect(isTransportActive()).toBe(true)
  })

  it("can be reset to false", () => {
    setTransportActive(true)
    setTransportActive(false)
    expect(isTransportActive()).toBe(false)
  })

  it("is independent from perfEnabled() configured flag", () => {
    // Simulate: user called __perf.on() but hasn't reloaded
    setEnabled(true)
    // configured is true, but active is still false
    expect(perfEnabled()).toBe(true)
    expect(isTransportActive()).toBe(false)
  })

  it("both can be true after reload with flag set", () => {
    setEnabled(true)
    setTransportActive(true)
    expect(perfEnabled()).toBe(true)
    expect(isTransportActive()).toBe(true)
  })
})
