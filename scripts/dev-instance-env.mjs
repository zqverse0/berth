import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"

// 已存在的路径解析符号链接；尚未创建的目录继续解析其已有的父目录。
function actualPath(path) {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    return join(actualPath(dirname(absolute)), basename(absolute))
  }
}

function inside(path, root) {
  return path === root || path.startsWith(root + sep)
}

export function configureDevInstance(env, home = homedir()) {
  const devHome = join(home, ".berth-dev")
  const releaseHome = actualPath(join(home, ".berth"))
  const dataHome =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? env.APPDATA?.trim() || join(home, "AppData", "Roaming")
        : env.XDG_DATA_HOME?.trim() || join(home, ".local", "share")
  const releaseData = actualPath(join(dataHome, "app.berth"))
  const socketRoot = env.XDG_RUNTIME_DIR?.trim() || "/tmp"
  const releaseSocketRoots = ["/tmp", env.TMUX_TMPDIR?.trim(), socketRoot]
    .filter(Boolean)
    .map(actualPath)
  const releaseEndpoints = releaseSocketRoots.map((root) =>
    join(root, `berth-${process.getuid?.() ?? 0}`)
  )

  // 每个实例变量指向正式版时的报错；null 表示可用。
  const releaseUse = {
    BERTH_HOME: (value) =>
      insideRelease(value) &&
      "BERTH_HOME points into the installed Berth data; use a dev-only directory",
    BERTH_DATA_DIR: (value) =>
      insideRelease(value) &&
      "BERTH_DATA_DIR points into the installed Berth data; use a dev-only directory",
    BERTH_DATA_FILE: (value) =>
      value !== "berth-dev.db" &&
      "BERTH_DATA_FILE must be berth-dev.db for the dev instance",
    BERTH_TMPDIR: (value) =>
      (releaseSocketRoots.includes(actualPath(value)) &&
        "BERTH_TMPDIR points to an installed Berth socket root") ||
      (releaseEndpoints.some((root) => inside(actualPath(value), root)) &&
        "BERTH_TMPDIR points into an installed Berth socket directory"),
    BERTH_GUI_ENDPOINT: (value) =>
      releaseEndpoints.some(
        (root) => actualPath(value) === join(root, "gui")
      ) && "BERTH_GUI_ENDPOINT points to the installed Berth GUI",
  }
  function insideRelease(value) {
    const path = actualPath(value)
    return inside(path, releaseHome) || inside(path, releaseData)
  }

  // 在正式版终端（有 BERTH_PANE）里启动时，指向正式版的值是 pane 继承来的，丢掉改用 dev 默认值；
  // 不在 pane 里则是用户显式设置，照常拒绝。
  if (env.BERTH_PANE?.trim()) {
    for (const [name, conflict] of Object.entries(releaseUse)) {
      if (env[name]?.trim() && conflict(env[name])) delete env[name]
    }
  }

  if (!env.BERTH_HOME?.trim()) env.BERTH_HOME = devHome
  if (!env.BERTH_DATA_DIR?.trim()) env.BERTH_DATA_DIR = devHome
  if (!env.BERTH_DATA_FILE?.trim()) env.BERTH_DATA_FILE = "berth-dev.db"
  if (!env.BERTH_GUI_ENDPOINT?.trim()) {
    env.BERTH_GUI_ENDPOINT = join(socketRoot, "berth-dev", "gui")
  }
  if (!env.BERTH_TMPDIR?.trim())
    env.BERTH_TMPDIR = join(socketRoot, "berth-dev")

  for (const [name, conflict] of Object.entries(releaseUse)) {
    const reason = conflict(env[name])
    if (reason) throw new Error(reason)
  }
  if (
    inside(
      actualPath(join(env.BERTH_DATA_DIR, env.BERTH_DATA_FILE)),
      releaseData
    )
  ) {
    throw new Error(
      "BERTH_DATA_FILE resolves into the installed Berth database"
    )
  }

  // 从正式版终端启动 dev 时不要把父 pane 的连接身份传给 dev 子进程。
  for (const name of [
    "BERTH",
    "BERTH_PANE",
    "BERTH_TARGET_REF",
    "BERTH_LAUNCH_INPUTS",
  ]) {
    delete env[name]
  }
}
