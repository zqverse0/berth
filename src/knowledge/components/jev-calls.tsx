"use client"

import { useTranslations } from "next-intl"
import type { DecisionAnswer, DecisionCall } from "@/lib/model-provider"
import { entryTime } from "@/knowledge/components/jev-entries"
import { cn } from "@/lib/utils"

/** noul 至少这么高才在摘要里列出（是否写入按各调用方自己的阈值，不在这里判）。 */
const SHOWN = 0.5

function answerText(answer: DecisionAnswer | undefined) {
  if (!answer) return "—"
  switch (answer.type) {
    case "noul":
      return answer.noul.toFixed(2)
    case "choice":
      return `${answer.choice} ${answer.confidence.toFixed(2)}`
    case "score":
      return `${answer.legend[String(Math.round(answer.score))] ?? answer.score} ${answer.score.toFixed(2)}`
  }
}

/** 偏「是」的 noul 题，高的在前；其他题型都列。 */
function leaning(call: DecisionCall) {
  return Object.entries(call.answers ?? {})
    .filter(([, answer]) => answer.type !== "noul" || answer.noul >= SHOWN)
    .sort(
      ([, a], [, b]) =>
        (b.type === "noul" ? b.noul : 1) - (a.type === "noul" ? a.noul : 1)
    )
}

/**
 * Jev 调用记录，新的在前：什么时候、谁调的、为哪个会话的第几轮、耗时与 token、偏「是」的题。
 * 展开看每道题的问法与答案，以及发出去的完整输入。
 */
export function JevCalls({ calls }: { calls: DecisionCall[] }) {
  const t = useTranslations("Knowledge.jev")
  return (
    <ul className="space-y-1.5 text-xs">
      {calls.map((call) => {
        const shown = leaning(call)
        return (
          <li key={call.id} className="rounded border border-border/60 p-2">
            <details>
              <summary className="cursor-pointer list-none">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {call.caller}
                  </span>
                  <span>{entryTime(call.at)}</span>
                  {call.subject.session ? (
                    <span className="truncate">
                      {t("callSubject", {
                        session: call.subject.session.slice(0, 8),
                        turn: call.subject.turn ?? 0,
                      })}
                    </span>
                  ) : null}
                  <span className="ml-auto shrink-0">
                    {t("callCost", {
                      ms: call.ms,
                      tokens:
                        call.usage.input_tokens + call.usage.output_tokens,
                    })}
                  </span>
                </div>
                {call.error ? (
                  <p className="mt-1 text-destructive">{call.error}</p>
                ) : (
                  <p className="mt-1 text-muted-foreground">
                    {t("callSummary", {
                      count: Object.keys(call.questions).length,
                    })}
                    {shown.length > 0
                      ? ` · ${shown
                          .slice(0, 4)
                          .map(
                            ([key, answer]) => `${key} ${answerText(answer)}`
                          )
                          .join(" · ")}`
                      : ""}
                  </p>
                )}
              </summary>
              <table className="mt-2 w-full table-fixed">
                <tbody>
                  {Object.entries(call.questions).map(([key, question]) => {
                    const answer = call.answers?.[key]
                    return (
                      <tr key={key} className="align-top">
                        <td className="w-1/4 truncate py-0.5 pr-1 font-mono">
                          {key}
                        </td>
                        <td
                          className="py-0.5 pr-1 text-muted-foreground"
                          title={JSON.stringify(question.criteria)}
                        >
                          {question.instructions}
                        </td>
                        <td
                          className={cn(
                            "w-16 py-0.5 text-right tabular-nums",
                            answer?.type === "noul" &&
                              answer.noul >= SHOWN &&
                              "font-medium text-foreground"
                          )}
                        >
                          {answerText(answer)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="mt-2 text-muted-foreground">
                {t("callInput", { model: call.model, profile: call.profile })}
              </p>
              <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted/50 p-1.5 whitespace-pre-wrap">
                {JSON.stringify(call.state, null, 2)}
              </pre>
            </details>
          </li>
        )
      })}
    </ul>
  )
}
