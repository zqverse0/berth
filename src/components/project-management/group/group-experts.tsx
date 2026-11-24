"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Plus } from "lucide-react"
import { create } from "zustand"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { listExpertConfigs, type ExpertConfig } from "@/lib/agent/berth-group"
import { showProjectHome } from "@/lib/workspace/project-home"
import { useGroupWorkspaceStore } from "@/stores/group-workspace-store"
import { ExpertCreateForm } from "./expert-editor"

/**
 * 专家在本空间的配置（用哪个 Agent / 服务商 / 模型）：权威来源是后端 `group.experts`（`groups/experts.json`），
 * 这里只缓存最近一次读到的；专家页保存后调 `reload` 失效。
 */
export const useExpertConfigs = create<{
  byFolder: Record<number, Record<string, ExpertConfig | null>>
  reload: (folderId: number) => Promise<void>
}>((set) => ({
  byFolder: {},
  reload: async (folderId) => {
    const response = await listExpertConfigs(folderId)
    if (response.ok)
      set((state) => ({
        byFolder: {
          ...state.byFolder,
          [folderId]: Object.fromEntries(
            response.result.experts.map((entry) => [entry.id, entry.config])
          ),
        },
      }))
  },
}))

/** 读一次本空间的专家配置：专家 id → 配置（未配置为 null）。 */
export function useExpertConfigList(folderId: number) {
  const configs = useExpertConfigs((state) => state.byFolder[folderId])
  useEffect(() => {
    void useExpertConfigs.getState().reload(folderId)
  }, [folderId])
  return configs ?? {}
}

/** 侧栏专家页顶栏「＋」：新建专家，建好后首页打开它的编辑器。 */
export function ExpertNewButton() {
  const t = useTranslations("BerthTasks.group.members")
  const [creating, setCreating] = useState(false)
  return (
    <Popover open={creating} onOpenChange={setCreating}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-expert-new
          aria-label={t("newExpert")}
          title={t("newExpert")}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus aria-hidden="true" className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <ExpertCreateForm
          onCreated={(id) => {
            setCreating(false)
            openExpertEditor(id)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** 首页打开专家编辑器（提示词、skills、记忆…）。 */
export function openExpertEditor(id: string) {
  useGroupWorkspaceStore.getState().showExpert(id)
  showProjectHome()
}
