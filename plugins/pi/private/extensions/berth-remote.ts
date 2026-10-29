/**
 * Berth Remote
 *
 * 只在远程项目里由 launch.js 加载（`ctx.remote`）：bash 工具与用户 `!` 命令交给
 * `berth remote exec`（即 `ctx.remote.execCommand`）：目录换算、设备上的 bash、连接复用、
 * 中断时清理设备进程都在 Berth 里。文件读写工具不动（挂载点就是同一份文件）。
 */

import { spawn } from "node:child_process"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
  type BashOperations,
  createBashTool,
} from "@earendil-works/pi-coding-agent"

const ops: BashOperations = {
  exec: (command, cwd, { onData, signal, timeout }) =>
    new Promise((resolve, reject) => {
      // stdin 保持打开：berth 退出（被中断）时它关闭，设备端据此结束命令。
      const child = spawn(
        "berth",
        ["remote", "exec", "--cwd", cwd, "--", command],
        {
          stdio: ["pipe", "pipe", "pipe"],
        }
      )
      let timedOut = false
      const timer = timeout
        ? setTimeout(() => {
            timedOut = true
            child.kill()
          }, timeout * 1000)
        : undefined
      child.stdout.on("data", onData)
      child.stderr.on("data", onData)
      const onAbort = () => child.kill()
      signal?.addEventListener("abort", onAbort, { once: true })
      const done = () => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      child.on("error", (error) => {
        done()
        reject(error)
      })
      child.on("close", (code) => {
        done()
        if (signal?.aborted) reject(new Error("aborted"))
        else if (timedOut) reject(new Error(`timeout:${timeout}`))
        else resolve({ exitCode: code })
      })
    }),
}

export default function (pi: ExtensionAPI) {
  const target = process.env.BERTH_REMOTE_TARGET
  if (!target || !process.env.BERTH_REMOTE_MOUNT) return

  const localCwd = process.cwd()
  const localBash = createBashTool(localCwd)

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, _ctx) {
      return createBashTool(localCwd, { operations: ops }).execute(
        id,
        params,
        signal,
        onUpdate
      )
    },
  })

  pi.on("user_bash", () => ({ operations: ops }))

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("berth-remote", ctx.ui.theme.fg("accent", `⇄ ${target}`))
  })
}
