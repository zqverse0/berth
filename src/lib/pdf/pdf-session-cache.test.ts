import { afterEach, describe, expect, it, vi } from "vitest"
import {
  __resetPdfSessionCacheForTests,
  acquirePdfSession,
} from "./pdf-session-cache"

function createSession() {
  const close = vi.fn().mockResolvedValue(undefined)
  return {
    session: {
      document: {} as never,
      sourceVersion: "v1",
      close,
    },
    close,
  }
}

afterEach(async () => {
  await __resetPdfSessionCacheForTests()
})

describe("pdf session cache", () => {
  it("shares one opening and retains the session after release", async () => {
    const created = createSession()
    const open = vi.fn().mockResolvedValue(created.session)

    const first = acquirePdfSession("pdf-a", async () => open())
    const firstLease = await first.promise
    firstLease.release()

    const secondLease = await acquirePdfSession("pdf-a", async () => open())
      .promise

    expect(open).toHaveBeenCalledTimes(1)
    expect(secondLease.session).toBe(created.session)
    expect(created.close).not.toHaveBeenCalled()
    secondLease.release()
  })

  it("evicts the oldest idle session when the warm limit is exceeded", async () => {
    const created = [
      createSession(),
      createSession(),
      createSession(),
      createSession(),
    ]
    for (const [index, item] of created.entries()) {
      const lease = await acquirePdfSession(
        `pdf-${index}`,
        async () => item.session
      ).promise
      lease.release()
    }

    await Promise.resolve()
    expect(created[0]!.close).toHaveBeenCalledTimes(1)
    for (const item of created.slice(1))
      expect(item.close).not.toHaveBeenCalled()
  })
})
