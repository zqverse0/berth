// @ts-check
// 设备检查清单：SSH 连接 → 密钥 → berth 路径 → 版本 → 宿主运行。宿主（berth.devices.inspect）只给原始
// 检测结果，清单的步骤与判断在这里，文字由 app.js 按语言给出。

/** 连接失败是否因为还没配免密登录（服务器要密码）。 @param {string | null | undefined} message */
export function needsKeySetup(message) {
  return /permission denied|publickey|password/i.test(message ?? "")
}

/**
 * 由一次检测、对方概览与连线状态得出检查清单。前一项不通时后面的不检（`skipped`），还没有结果的为 `pending`。
 * @param {{
 *   check: { ok: boolean, message: string | null } | null,
 *   berth: string | null,
 *   overview: { version?: string, window?: string | null, hostable?: boolean } | null,
 *   localVersion: string | null,
 *   line: { open: boolean, error: string | null } | null,
 * }} input
 * @returns {import("berth").DeviceCheckItem[]}
 */
export function deviceChecklist({
  check,
  berth,
  overview,
  localVersion,
  line,
}) {
  if (!check)
    return /** @type {const} */ ([
      "ssh",
      "key",
      "berth",
      "version",
      "host",
    ]).map((id) => ({ id, state: "pending" }))
  const keyIssue = !check.ok && needsKeySetup(check.message)
  const reached = check.ok || keyIssue
  /** @type {import("berth").DeviceCheckItem} */
  const ssh = reached
    ? { id: "ssh", state: "ok" }
    : { id: "ssh", state: "fail", raw: check.message }
  /** @type {import("berth").DeviceCheckItem} */
  const key = !reached
    ? { id: "key", state: "skipped" }
    : keyIssue
      ? {
          id: "key",
          state: "fail",
          reason: { key: "keyMissing" },
          raw: check.message,
        }
      : { id: "key", state: "ok" }
  /** @type {import("berth").DeviceCheckItem} */
  const berthItem = !check.ok
    ? { id: "berth", state: "skipped" }
    : berth
      ? { id: "berth", state: "ok", raw: berth }
      : { id: "berth", state: "fail", reason: { key: "berthMissing" } }
  const hasBerth = berthItem.state === "ok"
  const remote = overview?.version
  /** @type {import("berth").DeviceCheckItem} */
  const version = !hasBerth
    ? { id: "version", state: "skipped" }
    : !overview || !localVersion
      ? { id: "version", state: "pending" }
      : !remote
        ? { id: "version", state: "fail", reason: { key: "versionUnknown" } }
        : remote === localVersion
          ? { id: "version", state: "ok", raw: remote }
          : {
              id: "version",
              state: "fail",
              reason: {
                key: "versionMismatch",
                values: { local: localVersion, remote },
              },
            }
  /** @type {import("berth").DeviceCheckItem} */
  const host = !hasBerth
    ? { id: "host", state: "skipped" }
    : line?.open
      ? { id: "host", state: "ok" }
      : overview && overview.window === undefined
        ? { id: "host", state: "fail", reason: { key: "berthOutdated" } }
        : overview && overview.window === null && !overview.hostable
          ? { id: "host", state: "fail", reason: { key: "windowUnavailable" } }
          : line?.error
            ? { id: "host", state: "fail", raw: line.error }
            : { id: "host", state: "pending" }
  return [ssh, key, berthItem, version, host]
}
