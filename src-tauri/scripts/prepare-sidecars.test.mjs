import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  BINARIES,
  cacheEntryNeedsBuild,
  collectFiles,
  replaceFileSync,
  syncHostCliCommand,
} from "./prepare-sidecars.mjs"

const expected = {
  cacheVersion: 4,
  fingerprint: "fingerprint-a",
  packageVersion: "0.28.2",
  artifactHash: "artifact-a",
  artifactUsable: true,
  destination: "binaries/berth-linux-x86_64",
}

const validEntry = {
  cacheVersion: 4,
  fingerprint: "fingerprint-a",
  packageVersion: "0.28.2",
  artifactHash: "artifact-a",
  destination: "binaries/berth-linux-x86_64",
}

test("owned terminal binaries are staged and declared as Tauri sidecars", () => {
  const names = BINARIES.map((binary) => binary.sidecarName).sort()
  assert.deepEqual(names, ["berth-cli", "berth-termd"])

  const tauriConfig = JSON.parse(
    readFileSync(new URL("../tauri.conf.json", import.meta.url), "utf8")
  )
  const declared = tauriConfig.bundle.externalBin
    .map((entry) => entry.replace(/^binaries\//, ""))
    .sort()
  assert.deepEqual(declared, names)
})

test("cache entry is reusable only when source and artifact match", () => {
  assert.equal(cacheEntryNeedsBuild(validEntry, expected), false)
  assert.equal(cacheEntryNeedsBuild(undefined, expected), true)
  assert.equal(
    cacheEntryNeedsBuild(validEntry, { ...expected, fingerprint: "changed" }),
    true
  )
  assert.equal(
    cacheEntryNeedsBuild(validEntry, {
      ...expected,
      packageVersion: "changed",
    }),
    true
  )
  assert.equal(
    cacheEntryNeedsBuild(validEntry, { ...expected, artifactHash: "changed" }),
    true
  )
})

test("missing artifact hash always forces a rebuild", () => {
  assert.equal(
    cacheEntryNeedsBuild(validEntry, { ...expected, artifactHash: null }),
    true
  )
})

test("unusable or relocated artifacts never produce a cache hit", () => {
  assert.equal(
    cacheEntryNeedsBuild(validEntry, { ...expected, artifactUsable: false }),
    true
  )
  assert.equal(
    cacheEntryNeedsBuild(validEntry, {
      ...expected,
      destination: "binaries/other-target",
    }),
    true
  )
})

test("unknown cache versions are never reused", () => {
  assert.equal(
    cacheEntryNeedsBuild({ ...validEntry, cacheVersion: 0 }, expected),
    true
  )
})

test("collectFiles walks crate sources", () => {
  const root = fileURLToPath(
    new URL("../terminal/cli/berth-cli", import.meta.url)
  )
  const files = collectFiles(root)
  assert.ok(files.some((file) => file.endsWith("Cargo.toml")))
  assert.ok(files.some((file) => file.endsWith("main.rs")))
})

test("host CLI command is the product name berth", () => {
  const cli = BINARIES.find((binary) => binary.sidecarName === "berth-cli")
  assert.equal(cli.binaryName, "berth")

  const dir = mkdtempSync(join(tmpdir(), "berth-host-cli-"))
  const sidecar = join(dir, "berth-cli-x86_64-unknown-linux-gnu")
  writeFileSync(sidecar, "cli")
  const command = syncHostCliCommand(sidecar, {
    isWindows: false,
    ext: "",
    target: "x86_64-unknown-linux-gnu",
    host: "x86_64-unknown-linux-gnu",
  })
  assert.equal(command, join(dir, "berth"))
  assert.equal(readFileSync(command, "utf8"), "cli")
})

test(
  "replaceFileSync swaps a sidecar that is currently executing",
  { skip: process.platform === "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "berth-sidecar-busy-"))
    const busy = join(root, "berth-cli")
    copyFileSync("/bin/sleep", busy)
    const child = spawn(busy, ["30"], { stdio: "ignore" })
    await new Promise((resolve) => child.once("spawn", resolve))
    try {
      // 原地写正在执行的文件会 ETXTBSY，这���是 tauri dev 重启失败的原因。
      assert.throws(() => copyFileSync("/bin/true", busy), { code: "ETXTBSY" })
      const next = join(root, "next")
      writeFileSync(next, "new sidecar")
      replaceFileSync(next, busy)
      assert.equal(readFileSync(busy, "utf8"), "new sidecar")
    } finally {
      child.kill()
    }
  }
)
