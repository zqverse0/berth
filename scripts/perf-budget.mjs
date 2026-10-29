import fs from "node:fs"
import path from "node:path"

const OUT_DIR = path.resolve(process.cwd(), "out")

const DEFAULT_BUDGETS = {
  maxInitialJsBytes: 2.8 * 1024 * 1024, // 2.8 MB uncompressed ceiling
  maxSingleChunkBytes: 800 * 1024, // 800 KB per chunk ceiling
}

export function analyzeWorkspaceBundle(options = {}) {
  const { outDir = OUT_DIR, ...budgetOptions } = options
  const budgets = { ...DEFAULT_BUDGETS, ...budgetOptions }
  const workspaceHtml = path.join(outDir, "workspace.html")

  if (!fs.existsSync(workspaceHtml)) {
    throw new Error(
      `workspace.html not found at ${workspaceHtml}. Run "pnpm build" first.`
    )
  }

  const html = fs.readFileSync(workspaceHtml, "utf8")
  const scriptRegex = /<script[^>]*src="([^"]+)"/g
  const cssRegex = /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g

  const scripts = []
  let match
  while ((match = scriptRegex.exec(html)) !== null) {
    scripts.push(match[1])
  }

  const stylesheets = []
  while ((match = cssRegex.exec(html)) !== null) {
    stylesheets.push(match[1])
  }

  let totalJsBytes = 0
  const chunkDetails = []

  for (const src of scripts) {
    const relativePath = src.replace(/^\//, "")
    const fullPath = path.join(outDir, relativePath)
    if (fs.existsSync(fullPath)) {
      const stats = fs.statSync(fullPath)
      const size = stats.size
      totalJsBytes += size
      chunkDetails.push({ src, size, path: fullPath })
    } else {
      chunkDetails.push({ src, size: 0, missing: true })
    }
  }

  chunkDetails.sort((a, b) => b.size - a.size)

  let totalCssBytes = 0
  for (const href of stylesheets) {
    const relativePath = href.replace(/^\//, "")
    const fullPath = path.join(outDir, relativePath)
    if (fs.existsSync(fullPath)) {
      totalCssBytes += fs.statSync(fullPath).size
    }
  }

  const violations = []
  if (totalJsBytes > budgets.maxInitialJsBytes) {
    violations.push(
      `Initial JS Payload (${(totalJsBytes / 1024 / 1024).toFixed(2)} MB) exceeds budget of ${(budgets.maxInitialJsBytes / 1024 / 1024).toFixed(2)} MB`
    )
  }

  for (const chunk of chunkDetails) {
    if (chunk.missing) {
      violations.push(
        `Referenced script ${chunk.src} is missing from the export`
      )
      continue
    }
    if (chunk.size > budgets.maxSingleChunkBytes) {
      violations.push(
        `Chunk ${chunk.src} (${(chunk.size / 1024).toFixed(1)} KB) exceeds single chunk budget of ${(budgets.maxSingleChunkBytes / 1024).toFixed(1)} KB`
      )
    }
  }

  return {
    totalJsBytes,
    totalCssBytes,
    scriptCount: scripts.length,
    stylesheetCount: stylesheets.length,
    topChunks: chunkDetails.slice(0, 10),
    violations,
    passed: violations.length === 0,
  }
}

// CLI runner
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname)
) {
  try {
    const result = analyzeWorkspaceBundle()
    console.log(
      "\n================ Frontend Performance Budget ================"
    )
    console.log(`Workspace Initial Scripts:     ${result.scriptCount}`)
    console.log(
      `Workspace Initial JS Payload: ${(result.totalJsBytes / 1024 / 1024).toFixed(2)} MB (${(result.totalJsBytes / 1024).toFixed(1)} KB)`
    )
    console.log(
      `Workspace Initial CSS Payload: ${(result.totalCssBytes / 1024).toFixed(1)} KB`
    )
    console.log("-------------------------------------------------------------")
    console.log("Top 10 Largest Initial Chunks:")
    for (const chunk of result.topChunks) {
      console.log(
        `  ${(chunk.size / 1024).toFixed(1).padStart(7)} KB  ${chunk.src}`
      )
    }
    console.log("=============================================================")

    if (!result.passed) {
      console.error("\n[PERF BUDGET VIOLATION]")
      for (const v of result.violations) {
        console.error(`  - ${v}`)
      }
      process.exit(1)
    } else {
      console.log("\n✓ All performance budget checks passed.\n")
    }
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
