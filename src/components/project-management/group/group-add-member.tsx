"use client"

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ChevronLeft, Plus } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { MemberAvatar } from "./group-timeline"

/**
 * 侧栏群组视图顶栏的「＋」入群：先选 Agent（tool.json 声明 `agent.acp` 的插件），
 * 再填启动栏表单（专家、服务商、模型…）。
 */
export function GroupAddMember({
  addable,
  addForm,
}: {
  /** 能以 ACP 成员入群的 Agent。 */
  addable: readonly { id: string; name: string }[]
  /** 选中 Agent 后的入群表单；`close` 收起弹层。 */
  addForm: (agent: string, close: () => void) => ReactNode
}) {
  const t = useTranslations("BerthTasks.group")
  const [adding, setAdding] = useState(false)
  const [agent, setAgent] = useState<string | null>(null)
  return (
    <Popover
      open={adding}
      onOpenChange={(open) => {
        setAdding(open)
        if (!open) setAgent(null)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-group-add
          aria-label={t("add.title")}
          title={t("add.title")}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus aria-hidden="true" className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        {agent ? (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="flex items-center gap-1 self-start rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setAgent(null)}
            >
              <ChevronLeft aria-hidden="true" className="size-3.5" />
              {addable.find((item) => item.id === agent)?.name ?? agent}
            </button>
            {addForm(agent, () => {
              setAdding(false)
              setAgent(null)
            })}
          </div>
        ) : (
          <div className="flex flex-col">
            <span className="px-2 py-1 text-xs text-muted-foreground">
              {addable.length ? t("add.title") : t("add.empty")}
            </span>
            {addable.map((item) => (
              <button
                key={item.id}
                type="button"
                data-group-add-agent={item.id}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => setAgent(item.id)}
              >
                <MemberAvatar
                  agent={item.id}
                  name={item.id}
                  className="size-5 rounded-full [&_svg]:size-3"
                />
                {item.name}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
