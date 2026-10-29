"use client"

import { Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { createFolderResource } from "@/lib/workspace/folder-resource"
import { cn } from "@/lib/utils"

export interface NewResourceMenuProps {
  /** Open a new Agent conversation draft (caller supplies folder logic). */
  onNewAgent: () => void
  folderId: number
  className?: string
  /** Visual density for title-bar vs standalone strips. */
  variant?: "icon" | "button"
}

/**
 * Folder-owned Agent entry. Personal terminal creation is intentionally owned
 * by the project session manager; this button must never create a PTY.
 */
export function NewResourceMenu({
  onNewAgent,
  folderId,
  className,
  variant = "icon",
}: NewResourceMenuProps) {
  const t = useTranslations("Folder.terminal")

  const buttonClass = cn(
    variant === "icon"
      ? "mr-0.5 flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      : "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
    className
  )

  const openAgent = () => {
    void createFolderResource({
      folderId,
      kind: "conversation",
      onCreateConversation: onNewAgent,
    })
  }

  return (
    <button
      type="button"
      className={buttonClass}
      aria-label={t("newAgentConversation")}
      title={t("newAgentConversation")}
      onClick={(event) => {
        event.stopPropagation()
        openAgent()
      }}
    >
      <Plus className="h-3.5 w-3.5" />
      {variant === "button" ? <span>{t("newAgentConversation")}</span> : null}
    </button>
  )
}
