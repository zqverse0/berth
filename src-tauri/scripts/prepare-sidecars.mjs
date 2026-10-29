#!/usr/bin/env node
//
// Prepare Tauri sidecars before `tauri build` / `tauri dev` consume them.
//
// What it does:
//   1. Resolves the target triple — `--target <triple>` arg, or
//      `TAURI_TARGET_TRIPLE` env, or the host's `rustc -vV` host triple.
//   2. Builds the GUI-owned berth-termd and berth-cli only when their
//      source/dependency inputs changed.
//   3. Copies each binary to `src-tauri/binaries/<name>-<triple>{.exe}` so
//      Tauri's externalBin bundler picks them up under their bare names.
//
// Why a separate script (not inline in beforeBuildCommand / GitHub Actions):
//   - Cross-compile in release.yml passes `--target <triple>` so we honour
//     the matrix triple rather than rebuilding for the host.
//   - Local `pnpm tauri dev` / `pnpm tauri build` invoke it without args and
//     build berth-termd for the host while locating sibling release artifacts.
//   - `--dev` (tauri dev / dev-trial) builds with the fast `sidecar-dev` cargo
//     profile; release packaging keeps the size-optimised `release` profile.
//   - Skippable: set `BERTH_SKIP_SIDECAR=1` when iterating on the frontend
//     and you don't need the bundled terminal/agent companions.
//
// Intentionally Node-only (no shell): runs identically on macOS, Linux,
// Windows GitHub runners.

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

const SCRIPT_FILE = fileURLToPath(import.meta.url)
const SCRIPT_DIR = dirname(SCRIPT_FILE)
const SRC_TAURI = resolve(SCRIPT_DIR, "..")
const BINARIES_DIR = join(SRC_TAURI, "binaries")
const CACHE_FILE = join(BINARIES_DIR, ".prepare-sidecars-cache.json")
const CACHE_VERSION = 4

// The desktop package owns the daemon and its peer command-line frontend.
export const BINARIES = [
  {
    packageName: "berth-terminald",
    binaryName: "berth-termd",
    sidecarName: "berth-termd",
    noDefaultFeatures: true,
  },
  {
    packageName: "berth-cli",
    binaryName: "berth",
    sidecarName: "berth-cli",
    noDefaultFeatures: false,
  },
]

// Optional runtimes such as berth-mcp are installed independently and are
// resolved by the GUI through BERTH_MCP_BIN, Settings, sibling development
// layouts, or PATH. Only GUI-owned binaries are staged into desktop packages.
const EXTERNAL_BINARIES = []

function log(msg) {
  console.log(`[prepare-sidecars] ${msg}`)
}

function die(msg) {
  console.error(`[prepare-sidecars][ERROR] ${msg}`)
  process.exit(1)
}

// Tauri bundles `berth-cli-<triple>`. The product command users type is `berth`.
// After staging the host sidecar, expose that same binary under the product name
// so `PATH=<repo>/src-tauri/binaries` and `bin/berth` resolve the current CLI.
export function syncHostCliCommand(
  sidecarPath,
  { isWindows, ext, target, host }
) {
  if (target !== host) return null
  if (!existsSync(sidecarPath)) return null
  const commandPath = join(dirname(sidecarPath), `berth${ext}`)
  mkdirSync(dirname(commandPath), { recursive: true })
  if (isWindows) {
    copyFileSync(sidecarPath, commandPath)
  } else {
    try {
      unlinkSync(commandPath)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    symlinkSync(basename(sidecarPath), commandPath)
  }
  if (!isWindows) chmodSync(commandPath, 0o755)
  log(`host command staged at ${commandPath}`)
  return commandPath
}

function filesEqual(left, right) {
  if (!existsSync(right)) return false
  if (statSync(left).size !== statSync(right).size) return false
  return readFileSync(left).equals(readFileSync(right))
}

// 先写同目录临时文件再 rename：目标正被执行（如常驻的 `berth attach`）时，
// 原地 copyFile 会 ETXTBSY；rename 只替换目录项，运行中的进程继续用旧 inode。
export function replaceFileSync(source, destination) {
  const temporary = `${destination}.tmp-${process.pid}`
  try {
    copyFileSync(source, temporary)
    renameSync(temporary, destination)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {}
    throw error
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function isUsableArtifact(path, target) {
  try {
    const info = statSync(path)
    if (!info.isFile() || info.size === 0) return false
    if (!target.includes("windows") && (info.mode & 0o111) === 0) return false
    return true
  } catch {
    return false
  }
}

/** Map Rust target triple → Bun standalone dist folder for TS berth-mcp Runtime. */
function bunDistRelative(binaryName, target) {
  if (binaryName !== "berth-mcp") return null
  if (target === "x86_64-unknown-linux-gnu")
    return "dist/bun-linux-x64/berth-mcp"
  if (target === "aarch64-unknown-linux-gnu")
    return "dist/bun-linux-arm64/berth-mcp"
  if (target === "x86_64-apple-darwin") return "dist/bun-darwin-x64/berth-mcp"
  if (target === "aarch64-apple-darwin")
    return "dist/bun-darwin-arm64/berth-mcp"
  if (target === "x86_64-pc-windows-msvc")
    return "dist/bun-windows-x64/berth-mcp.exe"
  // Prefer linux x64 dist when host triple is unusual (dev fallback).
  return "dist/bun-linux-x64/berth-mcp"
}

function externalArtifactCandidates(binary, target, profile) {
  const project = process.env[binary.projectEnv]?.trim()
  const projectRoot = project ? resolve(project) : binary.defaultProject
  const configured = process.env[binary.artifactEnv]?.trim()
  const candidates = []

  if (configured) candidates.push(resolve(configured))

  // TypeScript Runtime standalone (preferred over legacy Cargo target/)
  const bunRel = bunDistRelative(binary.binaryName, target)
  if (bunRel) {
    candidates.push(join(projectRoot, bunRel))
  }

  const targetOverride = process.env.CARGO_TARGET_DIR?.trim()
  const targetRoots = []
  if (targetOverride) {
    targetRoots.push(
      isAbsolute(targetOverride)
        ? targetOverride
        : resolve(projectRoot, targetOverride)
    )
  }
  targetRoots.push(join(projectRoot, "target"))

  for (const root of targetRoots) {
    candidates.push(join(root, target, profile, binary.binaryName))
    candidates.push(join(root, target, profile, `${binary.binaryName}.exe`))
    candidates.push(join(root, profile, binary.binaryName))
    candidates.push(join(root, profile, `${binary.binaryName}.exe`))
  }

  return { projectRoot, candidates }
}

function resolveExternalArtifact(binary, target, profile) {
  const { projectRoot, candidates } = externalArtifactCandidates(
    binary,
    target,
    profile
  )
  const artifact = candidates.find((candidate) =>
    isUsableArtifact(candidate, target)
  )
  if (artifact) return artifact

  const configured = process.env[binary.artifactEnv]?.trim()
  const hint = configured
    ? `the configured ${binary.artifactEnv} artifact is not usable`
    : `no usable artifact was found under ${projectRoot}`
  die(
    `${hint}; build ${binary.binaryName} in its independent project first, ` +
      `or set ${binary.artifactEnv} to an executable artifact path`
  )
}

function externalFingerprint(binary, source, target, profile) {
  const hash = createHash("sha256")
  hash.update(
    JSON.stringify({
      cacheVersion: CACHE_VERSION,
      binaryName: binary.binaryName,
      sidecarName: binary.sidecarName,
      source,
      target,
      profile,
    })
  )
  hash.update(readFileSync(source))
  return hash.digest("hex")
}

function stageExternalBinary(binary, target, profile, cache) {
  const source = resolveExternalArtifact(binary, target, profile)
  const ext = target.includes("windows") ? ".exe" : ""
  const destinationPath = join(
    BINARIES_DIR,
    `${binary.sidecarName}-${target}${ext}`
  )
  const destination = relative(SRC_TAURI, destinationPath)
  const destinationUsable = isUsableArtifact(destinationPath, target)
  const destinationHash = destinationUsable ? sha256File(destinationPath) : null
  const input = {
    fingerprint: externalFingerprint(binary, source, target, profile),
    packageVersion: "external-artifact",
  }
  const expected = {
    ...input,
    artifactHash: destinationHash,
    artifactUsable: destinationUsable,
    destination,
  }
  const key = cacheKey({
    sidecarName: binary.sidecarName,
    target,
    profile,
    noDefaultFeatures: false,
  })

  if (!cacheEntryNeedsBuild(cache.entries[key], expected)) {
    log(`cache hit for external ${binary.sidecarName}`)
    return
  }

  mkdirSync(BINARIES_DIR, { recursive: true })
  if (filesEqual(source, destinationPath)) {
    log(`external sidecar unchanged at ${destinationPath}`)
  } else {
    replaceFileSync(source, destinationPath)
    log(`external sidecar staged at ${destinationPath}`)
  }
  if (!target.includes("windows")) chmodSync(destinationPath, 0o755)

  cache.entries[key] = {
    cacheVersion: CACHE_VERSION,
    fingerprint: input.fingerprint,
    packageVersion: input.packageVersion,
    artifactHash: sha256File(destinationPath),
    destination,
  }
  saveCache(cache)
}

function parseArgs(argv) {
  const args = { target: null, dev: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--target" && argv[i + 1]) {
      args.target = argv[++i]
    } else if (a.startsWith("--target=")) {
      args.target = a.slice("--target=".length)
    } else if (a === "--dev") {
      args.dev = true
    }
  }
  return args
}

function resolveHostTriple() {
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    const line = out.split(/\r?\n/).find((l) => l.startsWith("host:"))
    if (!line) throw new Error("rustc -vV missing host: line")
    return line.replace(/^host:\s*/, "").trim()
  } catch (e) {
    die(`cannot determine host triple via rustc -vV: ${e.message}`)
  }
}

function loadCargoMetadata() {
  try {
    return JSON.parse(
      execFileSync(
        "cargo",
        ["metadata", "--format-version", "1", "--no-deps"],
        {
          encoding: "utf8",
          cwd: SRC_TAURI,
        }
      )
    )
  } catch (e) {
    die(`cannot read Cargo workspace metadata: ${e.message}`)
  }
}

function loadToolchainFingerprint() {
  try {
    return {
      cargo: execFileSync("cargo", ["-V"], { encoding: "utf8" }).trim(),
      rustc: execFileSync("rustc", ["-vV"], { encoding: "utf8" }).trim(),
      node: process.version,
    }
  } catch (e) {
    die(`cannot determine build toolchain: ${e.message}`)
  }
}

function workspacePackages(metadata) {
  return new Map(metadata.packages.map((pkg) => [pkg.name, pkg]))
}

function packageDependencyClosure(metadata, packageName) {
  const packages = workspacePackages(metadata)
  const visited = new Set()
  const result = []

  function visit(name) {
    if (visited.has(name)) return
    const pkg = packages.get(name)
    if (!pkg) return
    visited.add(name)
    result.push(pkg)
    for (const dependency of pkg.dependencies) {
      if (dependency.path && dependency.kind !== "dev") {
        visit(dependency.name)
      }
    }
  }

  visit(packageName)
  return result
}

export function collectFiles(root) {
  const files = []
  const ignoredDirectories = new Set([".git", "node_modules", "target"])

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(path)
      } else if (entry.isFile()) {
        files.push(path)
      }
    }
  }

  visit(root)
  return files.sort()
}

function sidecarInputFiles(binary, metadata) {
  const packages = packageDependencyClosure(metadata, binary.packageName)
  const files = new Set([
    SCRIPT_FILE,
    join(SRC_TAURI, "Cargo.toml"),
    join(SRC_TAURI, "Cargo.lock"),
    join(SRC_TAURI, "tauri.conf.json"),
  ])

  for (const pkg of packages) {
    for (const file of collectFiles(dirname(pkg.manifest_path))) {
      files.add(file)
    }
  }

  return [...files].filter(existsSync).sort()
}

function fingerprintInputs({ binary, target, profile, metadata, toolchain }) {
  const packages = packageDependencyClosure(metadata, binary.packageName)
  const packageVersions = packages
    .map((pkg) => `${pkg.name}@${pkg.version}`)
    .sort()
  const descriptor = {
    cacheVersion: CACHE_VERSION,
    packageName: binary.packageName,
    binaryName: binary.binaryName,
    sidecarName: binary.sidecarName,
    target,
    profile,
    noDefaultFeatures: binary.noDefaultFeatures,
    packageVersions,
    toolchain,
  }
  const hash = createHash("sha256")
  hash.update(JSON.stringify(descriptor))

  for (const file of sidecarInputFiles(binary, metadata)) {
    hash.update(relative(SRC_TAURI, file))
    hash.update("\0")
    hash.update(readFileSync(file))
    hash.update("\0")
  }

  return {
    fingerprint: hash.digest("hex"),
    packageVersion: packages.find((pkg) => pkg.name === binary.packageName)
      ?.version,
  }
}

function cacheKey({ sidecarName, target, profile, noDefaultFeatures }) {
  return JSON.stringify({ sidecarName, target, profile, noDefaultFeatures })
}

export function cacheEntryNeedsBuild(entry, expected) {
  if (!entry) return true
  if (entry.cacheVersion !== CACHE_VERSION) return true
  if (entry.fingerprint !== expected.fingerprint) return true
  if (entry.packageVersion !== expected.packageVersion) return true
  if (entry.destination !== expected.destination) return true
  if (!expected.artifactUsable) return true
  if (!expected.artifactHash || entry.artifactHash !== expected.artifactHash)
    return true
  return false
}

function emptyCache() {
  return { cacheVersion: CACHE_VERSION, entries: {} }
}

function loadCache() {
  if (!existsSync(CACHE_FILE)) return emptyCache()
  try {
    const cache = JSON.parse(readFileSync(CACHE_FILE, "utf8"))
    if (cache.cacheVersion !== CACHE_VERSION || !cache.entries) {
      log("sidecar cache format changed — rebuilding targets")
      return emptyCache()
    }
    return cache
  } catch (e) {
    log(`sidecar cache unreadable — rebuilding targets (${e.message})`)
    return emptyCache()
  }
}

function saveCache(cache) {
  mkdirSync(BINARIES_DIR, { recursive: true })
  const temporary = `${CACHE_FILE}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`)
  renameSync(temporary, CACHE_FILE)
}

function main() {
  if (process.env.BERTH_SKIP_SIDECAR === "1") {
    log("BERTH_SKIP_SIDECAR=1 — skipping sidecar preparation")
    return
  }

  const { target: cliTarget, dev: devBuild } = parseArgs(process.argv.slice(2))
  const target =
    cliTarget || process.env.TAURI_TARGET_TRIPLE || resolveHostTriple()
  const isWindows = target.includes("windows")
  const ext = isWindows ? ".exe" : ""
  const profile = devBuild ? "sidecar-dev" : "release"
  const metadata = loadCargoMetadata()
  const toolchain = loadToolchainFingerprint()
  const cache = loadCache()
  log(`target triple: ${target}`)

  // cargo build needs to run from src-tauri so it resolves the local manifest
  // and shares the swatinem/rust-cache key with other cargo invocations.
  for (const binary of BINARIES) {
    const input = fingerprintInputs({
      binary,
      target,
      profile,
      metadata,
      toolchain,
    })
    const key = cacheKey({
      sidecarName: binary.sidecarName,
      target,
      profile,
      noDefaultFeatures: binary.noDefaultFeatures,
    })
    const targetDir = resolve(
      SRC_TAURI,
      process.env.CARGO_TARGET_DIR || "target"
    )
    const built = join(targetDir, target, profile, `${binary.binaryName}${ext}`)
    const dest = join(BINARIES_DIR, `${binary.sidecarName}-${target}${ext}`)
    const destination = relative(SRC_TAURI, dest)
    const artifactUsable = isUsableArtifact(dest, target)
    const artifactHash = artifactUsable ? sha256File(dest) : null
    const expected = { ...input, artifactHash, artifactUsable, destination }

    if (!cacheEntryNeedsBuild(cache.entries[key], expected)) {
      log(`cache hit for ${binary.sidecarName} (${target})`)
      if (binary.binaryName === "berth") {
        syncHostCliCommand(dest, {
          isWindows,
          ext,
          target,
          host: resolveHostTriple(),
        })
      }
      continue
    }

    const profileArgs =
      profile === "release" ? ["--release"] : ["--profile", profile]
    const featureLabel = binary.noDefaultFeatures
      ? `${profileArgs.join(" ")} --no-default-features`
      : profileArgs.join(" ")
    log(
      `building ${binary.sidecarName} from ${binary.packageName}/${binary.binaryName} ` +
        `(${featureLabel})`
    )
    const args = [
      "build",
      ...profileArgs,
      "--package",
      binary.packageName,
      "--bin",
      binary.binaryName,
    ]
    if (binary.noDefaultFeatures) args.push("--no-default-features")
    args.push("--target", target)
    execFileSync("cargo", args, { stdio: "inherit", cwd: SRC_TAURI })

    if (!isUsableArtifact(built, target)) {
      die(
        `expected a non-empty executable artifact at ${built} after cargo build`
      )
    }

    mkdirSync(BINARIES_DIR, { recursive: true })
    if (filesEqual(built, dest)) {
      log(`sidecar unchanged at ${dest}`)
    } else {
      replaceFileSync(built, dest)
      log(`sidecar staged at ${dest}`)
    }
    if (!isWindows) {
      chmodSync(dest, 0o755)
    }

    cache.entries[key] = {
      cacheVersion: CACHE_VERSION,
      fingerprint: input.fingerprint,
      packageVersion: input.packageVersion,
      artifactHash: sha256File(dest),
      destination: relative(SRC_TAURI, dest),
    }
    saveCache(cache)

    if (binary.binaryName === "berth") {
      syncHostCliCommand(dest, {
        isWindows,
        ext,
        target,
        host: resolveHostTriple(),
      })
    }
  }

  for (const binary of EXTERNAL_BINARIES) {
    stageExternalBinary(binary, target, profile, cache)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main()
}
