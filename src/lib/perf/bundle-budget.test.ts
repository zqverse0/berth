import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { analyzeWorkspaceBundle } from "../../../scripts/perf-budget.mjs"

const tempDirs: string[] = []

function createExport(scriptSrc: string, scriptContent?: string) {
  const outDir = mkdtempSync(path.join(tmpdir(), "berth-bundle-budget-"))
  tempDirs.push(outDir)
  writeFileSync(
    path.join(outDir, "workspace.html"),
    `<script src="${scriptSrc}"></script>`
  )

  if (scriptContent !== undefined) {
    const scriptPath = path.join(outDir, scriptSrc.replace(/^\//, ""))
    mkdirSync(path.dirname(scriptPath), { recursive: true })
    writeFileSync(scriptPath, scriptContent)
  }

  return outDir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("analyzeWorkspaceBundle", () => {
  it("extracts workspace initial assets and checks budgets", () => {
    const outDir = createExport("/_next/main.js", "bundle")
    const result = analyzeWorkspaceBundle({ outDir })

    expect(result.scriptCount).toBe(1)
    expect(result.totalJsBytes).toBe(6)
    expect(result.topChunks[0].src).toBe("/_next/main.js")
    expect(result.passed).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  it("detects budget violations when threshold is exceeded", () => {
    const outDir = createExport("/_next/main.js", "bundle")
    const result = analyzeWorkspaceBundle({ outDir, maxInitialJsBytes: 1 })

    expect(result.passed).toBe(false)
    expect(result.violations[0]).toContain("exceeds budget")
  })

  it("fails when the export references a missing script", () => {
    const scriptSrc = "/_next/missing.js"
    const result = analyzeWorkspaceBundle({ outDir: createExport(scriptSrc) })

    expect(result.passed).toBe(false)
    expect(result.violations).toContain(
      `Referenced script ${scriptSrc} is missing from the export`
    )
  })
})
