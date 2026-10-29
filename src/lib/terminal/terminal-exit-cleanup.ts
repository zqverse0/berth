import { getTerminalSession } from "@/lib/api"
import { reportAgentLaunchAlert } from "@/lib/terminal/report-agent-launch-alert"

const EXIT_RESULT_VISIBLE_MS = 1_500
/** 屏幕底部常是空行，多读一屏再只留最后几行非空输出。 */
const FAILURE_CAPTURE_LINES = 200
const FAILURE_DETAIL_LINES = 20

/** 本页已报告过的失败退出；标签页重新挂载不重复弹。 */
const reportedFailures = new Set<string>()

export function scheduleTerminalExitCleanup(
  terminalId: string,
  removeRecord: (terminalId: string) => Promise<void>
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    void removeRecord(terminalId).catch(() => {
      // Another attached client may already have removed the shared record.
      // The authoritative primary-tabs event performs local view cleanup.
    })
  }, EXIT_RESULT_VISIBLE_MS)
}

/**
 * 进程退出的唯一处理：正常退出短暂停留后回收；非 0 退出（Agent pane 由 termd
 * `remain-on-exit failed` 保留）不关标签，告警带上最后输出，原因始终看得到。
 */
export function handleTerminalExit(
  terminalId: string,
  exitCode: number | null | undefined,
  describeFailure: (code: number) => string,
  removeRecord: (terminalId: string) => Promise<void>,
  readTail: (terminalId: string) => Promise<string | undefined> = async (id) =>
    (await getTerminalSession(id, { tailLines: FAILURE_CAPTURE_LINES })).tail
): void {
  if (exitCode == null || exitCode === 0) {
    scheduleTerminalExitCleanup(terminalId, removeRecord)
    return
  }
  if (reportedFailures.has(terminalId)) return
  reportedFailures.add(terminalId)
  void readTail(terminalId)
    .catch(() => undefined)
    .then((tail) =>
      reportAgentLaunchAlert(describeFailure(exitCode), lastLines(tail))
    )
}

function lastLines(text: string | undefined): string | undefined {
  const lines = (text ?? "").split("\n").filter((line) => line.trim())
  return lines.slice(-FAILURE_DETAIL_LINES).join("\n") || undefined
}
