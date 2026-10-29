import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { configureDevInstance } from "./dev-instance-env.mjs"

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "berth-instance-test-"))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const home = join(base, "home")
  const runtime = join(base, "runtime")
  const releaseData =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support", "app.berth")
      : join(home, ".local", "share", "app.berth")
  for (const dir of [
    runtime,
    releaseData,
    join(home, ".berth"),
    join(home, ".berth-dev"),
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(join(releaseData, "berth.db"), "")
  return { base, home, runtime, releaseData }
}

function checkout(f) {
  const root = join(f.base, "checkout")
  mkdirSync(join(root, "bin"), { recursive: true })
  mkdirSync(join(root, "src-tauri", "binaries"), { recursive: true })
  copyFileSync(
    new URL("../bin/berth", import.meta.url),
    join(root, "bin", "berth")
  )
  writeFileSync(join(root, "src-tauri", "tauri.dev.conf.json"), "{}")
  const cli = join(root, "src-tauri", "binaries", "berth")
  writeFileSync(
    cli,
    '#!/bin/sh\nprintf "%s\\n" "${BERTH_HOME-}" "${BERTH_DATA_DIR-}" "${BERTH_DATA_FILE-}" "${BERTH_GUI_ENDPOINT-}" "${BERTH_TMPDIR-}" "${BERTH-}" "${BERTH_SDK_DAEMON_BINARY-}" "$1"\n'
  )
  chmodSync(cli, 0o755)
  const daemon = join(root, "src-tauri", "binaries", "berth-termd-host")
  writeFileSync(daemon, "#!/bin/sh\nexit 0\n")
  chmodSync(daemon, 0o755)
  return { cli: join(root, "bin", "berth"), daemon }
}

function runCli(cli, f, override = {}) {
  return spawnSync("sh", [cli, "--probe"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: f.home,
      XDG_RUNTIME_DIR: f.runtime,
      ...override,
    },
  })
}

test("dev GUI uses its own assets, database, endpoints and not its parent's pane", (t) => {
  const f = fixture(t)
  const env = {
    XDG_RUNTIME_DIR: f.runtime,
    BERTH: `/tmp/berth-${process.getuid()}/default,123,0`,
  }
  configureDevInstance(env, f.home)
  assert.equal(env.BERTH_HOME, join(f.home, ".berth-dev"))
  assert.equal(env.BERTH_DATA_DIR, join(f.home, ".berth-dev"))
  assert.equal(env.BERTH_DATA_FILE, "berth-dev.db")
  assert.equal(env.BERTH_GUI_ENDPOINT, join(f.runtime, "berth-dev", "gui"))
  assert.equal(env.BERTH_TMPDIR, join(f.runtime, "berth-dev"))
  assert.equal(env.BERTH, undefined)
})

test("isolated explicit paths stay configurable", (t) => {
  const f = fixture(t)
  const custom = join(f.base, "another-dev")
  const socketDir = join(f.runtime, "another-dev")
  const env = {
    XDG_RUNTIME_DIR: f.runtime,
    BERTH_HOME: custom,
    BERTH_DATA_DIR: custom,
    BERTH_DATA_FILE: "berth-dev.db",
    BERTH_GUI_ENDPOINT: join(socketDir, "gui"),
    BERTH_TMPDIR: socketDir,
  }
  configureDevInstance(env, f.home)
  assert.equal(env.BERTH_HOME, custom)
  assert.equal(env.BERTH_DATA_DIR, custom)
  assert.equal(env.BERTH_GUI_ENDPOINT, join(socketDir, "gui"))
  assert.equal(env.BERTH_TMPDIR, socketDir)

  const { cli } = checkout(f)
  const result = runCli(cli, f, env)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trimEnd().split("\n").slice(0, 5), [
    custom,
    custom,
    "berth-dev.db",
    join(socketDir, "gui"),
    socketDir,
  ])
})

test("dev GUI rejects installed roots, aliases, wrong database and release sockets", (t) => {
  const f = fixture(t)
  const alias = join(f.home, "release-link")
  symlinkSync(join(f.home, ".berth"), alias, "dir")
  const base = { XDG_RUNTIME_DIR: f.runtime }
  const bad = [
    [{ BERTH_HOME: alias }, /BERTH_HOME/],
    [{ BERTH_DATA_DIR: f.releaseData }, /BERTH_DATA_DIR/],
    [{ BERTH_DATA_FILE: "berth.db" }, /BERTH_DATA_FILE/],
    [{ BERTH_TMPDIR: "/tmp" }, /BERTH_TMPDIR/],
    [
      { BERTH_GUI_ENDPOINT: `/tmp/berth-${process.getuid()}/gui` },
      /BERTH_GUI_ENDPOINT/,
    ],
  ]
  for (const [override, reason] of bad) {
    assert.throws(
      () => configureDevInstance({ ...base, ...override }, f.home),
      reason
    )
  }
  const releaseSockets = join(f.base, "release sockets")
  mkdirSync(releaseSockets)
  assert.throws(
    () =>
      configureDevInstance(
        { ...base, TMUX_TMPDIR: releaseSockets, BERTH_TMPDIR: releaseSockets },
        f.home
      ),
    /BERTH_TMPDIR/
  )
  const dbAlias = join(f.home, ".berth-dev", "berth-dev.db")
  symlinkSync(join(f.releaseData, "berth.db"), dbAlias)
  assert.throws(
    () => configureDevInstance({ ...base }, f.home),
    /BERTH_DATA_FILE/
  )
})

test("dev GUI started in a release pane drops the inherited release instance", (t) => {
  const f = fixture(t)
  const custom = join(f.base, "another-dev")
  const env = {
    XDG_RUNTIME_DIR: f.runtime,
    BERTH_PANE: "%3",
    BERTH_TARGET_REF: "ref",
    BERTH_LAUNCH_INPUTS: "{}",
    BERTH: `/tmp/berth-${process.getuid()}/default,123,0`,
    BERTH_HOME: join(f.home, ".berth"),
    BERTH_DATA_DIR: custom,
    BERTH_DATA_FILE: "berth.db",
    BERTH_GUI_ENDPOINT: `/tmp/berth-${process.getuid()}/gui`,
    BERTH_TMPDIR: "/tmp",
  }
  configureDevInstance(env, f.home)
  assert.equal(env.BERTH_HOME, join(f.home, ".berth-dev"))
  // 不指向正式版的值保留（可能是用户在 pane 里显式设置的）。
  assert.equal(env.BERTH_DATA_DIR, custom)
  assert.equal(env.BERTH_DATA_FILE, "berth-dev.db")
  assert.equal(env.BERTH_GUI_ENDPOINT, join(f.runtime, "berth-dev", "gui"))
  assert.equal(env.BERTH_TMPDIR, join(f.runtime, "berth-dev"))
  for (const name of [
    "BERTH",
    "BERTH_PANE",
    "BERTH_TARGET_REF",
    "BERTH_LAUNCH_INPUTS",
  ]) {
    assert.equal(env[name], undefined, name)
  }
})

test("dev CLI uses its own database and daemon even inside a release pane", (t) => {
  const f = fixture(t)
  const { cli, daemon } = checkout(f)
  const result = runCli(cli, f, {
    BERTH: `/tmp/berth-${process.getuid()}/default,123,0`,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [
    join(f.home, ".berth-dev"),
    join(f.home, ".berth-dev"),
    "berth-dev.db",
    join(f.runtime, "berth-dev", "gui"),
    join(f.runtime, "berth-dev"),
    "",
    daemon,
    "--probe",
  ])
  const devSocket = join(
    f.runtime,
    "berth-dev",
    `berth-${process.getuid()}`,
    "other"
  )
  const devPane = runCli(cli, f, { BERTH: `${devSocket},123,0` })
  assert.equal(devPane.status, 0, devPane.stderr)
  assert.equal(devPane.stdout.trimEnd().split("\n")[5], `${devSocket},123,0`)
})

test("dev CLI refuses inherited release roots and explicit release endpoints", (t) => {
  const f = fixture(t)
  const { cli } = checkout(f)
  const alias = join(f.home, "release-link")
  symlinkSync(join(f.home, ".berth"), alias, "dir")
  const bad = [
    [{ BERTH_HOME: alias }, /BERTH_HOME/],
    [{ BERTH_DATA_DIR: f.releaseData }, /BERTH_DATA_DIR/],
    [{ BERTH_DATA_FILE: "berth.db" }, /BERTH_DATA_FILE/],
    [{ BERTH_TMPDIR: "/tmp" }, /BERTH_TMPDIR/],
    [
      { BERTH_GUI_ENDPOINT: `/tmp/berth-${process.getuid()}/gui` },
      /BERTH_GUI_ENDPOINT/,
    ],
  ]
  for (const [override, reason] of bad) {
    const result = runCli(cli, f, override)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, reason)
  }
  const releaseSockets = join(f.base, "release sockets")
  mkdirSync(releaseSockets)
  const inheritedRoot = runCli(cli, f, {
    TMUX_TMPDIR: releaseSockets,
    BERTH_TMPDIR: releaseSockets,
  })
  assert.equal(inheritedRoot.status, 1, inheritedRoot.stderr)
  assert.match(inheritedRoot.stderr, /BERTH_TMPDIR/)
  symlinkSync(
    join(f.releaseData, "berth.db"),
    join(f.home, ".berth-dev", "berth-dev.db")
  )
  assert.match(
    runCli(cli, f).stderr,
    /dev database resolves into installed Berth data/
  )
})
