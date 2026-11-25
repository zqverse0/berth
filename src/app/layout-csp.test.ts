import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const tauriConf = JSON.parse(
  readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8")
) as {
  app: {
    security: {
      csp: string | null
      dangerousDisableAssetCspModification: string[]
    }
  }
}

const layoutSource = readFileSync(
  resolve(process.cwd(), "src/app/layout.tsx"),
  "utf8"
)

describe("release CEF CSP configuration", () => {
  it("disables Tauri HTTP header CSP so tauri-runtime-cef does not append script-src hashes that invalidate unsafe-inline", () => {
    expect(tauriConf.app.security.csp).toBeNull()
    expect(tauriConf.app.security.dangerousDisableAssetCspModification).toEqual(
      expect.arrayContaining(["style-src", "script-src"])
    )
  })

  it("enforces CSP via production meta tag in RootLayout with unsafe-inline and remote WebSocket support", () => {
    expect(layoutSource).toContain('httpEquiv="Content-Security-Policy"')
    expect(layoutSource).toContain('process.env.NODE_ENV === "production"')
    const cspBlockMatch = layoutSource.match(
      /const APP_CSP = \[([\s\S]*?)\]\.join\("; "\)/
    )
    expect(cspBlockMatch).not.toBeNull()
    const cspBlock = cspBlockMatch![1]
    expect(cspBlock).toContain(
      "script-src 'self' 'unsafe-inline' blob: http://localhost:*"
    )
    expect(cspBlock).toContain(
      "style-src 'self' 'unsafe-inline' http://localhost:*"
    )
    expect(cspBlock).toContain("ws: wss:")
    expect(cspBlock).not.toMatch(/'(sha256|sha384|sha512|nonce)-/)
  })
})
