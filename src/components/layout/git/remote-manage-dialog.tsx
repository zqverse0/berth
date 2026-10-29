"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Plus, Trash2 } from "lucide-react"
import {
  gitAddRemote,
  gitFetchRemote,
  gitListRemotes,
  gitRemoveRemote,
  gitSetRemoteUrl,
} from "@/lib/api"

interface RemoteDraft {
  originalName: string | null
  originalUrl: string
  name: string
  url: string
  deleted: boolean
}

interface RemoteManageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  folderPath: string
  onSaved: () => void
}

interface RemoteManageFormProps {
  folderPath: string
  /** 弹窗宿主传入以关闭自身；tab 宿主不传（无离开语义，取消按钮隐藏）。 */
  onCancel?: () => void
  onSaved: () => void
}

function extractError(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>
    if (typeof value.detail === "string" && value.detail) return value.detail
    if (typeof value.message === "string" && value.message) return value.message
  }
  return String(error)
}

export function RemoteManageForm({
  folderPath,
  onCancel,
  onSaved,
}: RemoteManageFormProps) {
  const t = useTranslations("Folder.branchDropdown.dialogs")
  const tCommon = useTranslations("Folder.common")
  const [drafts, setDrafts] = useState<RemoteDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [loadingRemotes, setLoadingRemotes] = useState(true)
  const [errors, setErrors] = useState<Record<number, string>>({})

  useEffect(() => {
    let cancelled = false
    setErrors({})
    setLoadingRemotes(true)
    gitListRemotes(folderPath)
      .then((remotes) => {
        if (cancelled) return
        setDrafts(
          remotes.map((remote) => ({
            originalName: remote.name,
            originalUrl: remote.url,
            name: remote.name,
            url: remote.url,
            deleted: false,
          }))
        )
      })
      .catch((error) => {
        if (cancelled) return
        console.error("Failed to load remotes:", error)
        setDrafts([])
      })
      .finally(() => {
        if (!cancelled) setLoadingRemotes(false)
      })

    return () => {
      cancelled = true
    }
  }, [folderPath])

  const addDraft = () => {
    setDrafts((prev) => [
      ...prev,
      {
        originalName: null,
        originalUrl: "",
        name: "",
        url: "",
        deleted: false,
      },
    ])
  }

  const updateDraft = (index: number, field: "name" | "url", value: string) => {
    setDrafts((prev) =>
      prev.map((draft, draftIndex) =>
        draftIndex === index ? { ...draft, [field]: value } : draft
      )
    )
  }

  const removeDraft = (index: number) => {
    setDrafts((prev) =>
      prev.map((draft, draftIndex) =>
        draftIndex === index ? { ...draft, deleted: true } : draft
      )
    )
  }

  const handleSave = async () => {
    setSaving(true)
    setErrors({})
    const nextErrors: Record<number, string> = {}

    try {
      for (const draft of drafts) {
        if (draft.deleted && draft.originalName != null) {
          await gitRemoveRemote(folderPath, draft.originalName)
        }
      }

      for (const [index, draft] of drafts.entries()) {
        if (draft.deleted || draft.originalName != null) continue
        if (!draft.name || !draft.url) continue
        try {
          await gitAddRemote(folderPath, draft.name, draft.url)
        } catch (error) {
          nextErrors[index] = extractError(error)
        }
      }

      for (const [index, draft] of drafts.entries()) {
        if (draft.deleted || draft.originalName == null) continue
        if (draft.url === draft.originalUrl) continue
        try {
          await gitSetRemoteUrl(folderPath, draft.originalName, draft.url)
        } catch (error) {
          nextErrors[index] = extractError(error)
        }
      }

      for (const [index, draft] of drafts.entries()) {
        if (draft.deleted || nextErrors[index]) continue
        const remoteName = draft.originalName ?? draft.name
        if (!remoteName) continue
        try {
          await gitFetchRemote(folderPath, remoteName)
        } catch (error) {
          nextErrors[index] = extractError(error)
        }
      }

      if (Object.keys(nextErrors).length > 0) {
        setErrors(nextErrors)
        return
      }

      onSaved()
      onCancel?.()
    } catch (error) {
      console.error("Failed to save remotes:", error)
    } finally {
      setSaving(false)
    }
  }

  const visibleDrafts = drafts.filter((draft) => !draft.deleted)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1 p-3">
        <div className="space-y-2 pr-2">
          {loadingRemotes ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              ...
            </p>
          ) : visibleDrafts.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t("manageRemotesEmpty")}
            </p>
          ) : (
            drafts.map(
              (draft, index) =>
                !draft.deleted && (
                  <div key={index} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder={t("remoteNamePlaceholder")}
                        value={draft.name}
                        onChange={(event) =>
                          updateDraft(index, "name", event.target.value)
                        }
                        disabled={draft.originalName != null}
                        className={`h-8 w-32 shrink-0 text-sm ${errors[index] ? "border-destructive" : ""}`}
                      />
                      <Input
                        placeholder={t("remoteUrlPlaceholder")}
                        value={draft.url}
                        onChange={(event) =>
                          updateDraft(index, "url", event.target.value)
                        }
                        className={`h-8 min-w-0 flex-1 font-mono text-sm ${errors[index] ? "border-destructive" : ""}`}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => removeDraft(index)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                    {errors[index] && (
                      <p className="truncate pl-1 text-xs text-destructive">
                        {errors[index]}
                      </p>
                    )}
                  </div>
                )
            )
          )}
        </div>
      </ScrollArea>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t p-3">
        <Button
          variant="outline"
          size="sm"
          onClick={addDraft}
          disabled={saving}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t("addRemote")}
        </Button>
        <div className="flex gap-2">
          {onCancel ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={saving}
            >
              {tCommon("cancel")}
            </Button>
          ) : null}
          <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? t("savingRemotes") : tCommon("save")}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function RemoteManageDialog({
  open,
  onOpenChange,
  folderPath,
  onSaved,
}: RemoteManageDialogProps) {
  const t = useTranslations("Folder.branchDropdown.dialogs")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(36rem,calc(100vh-2rem))] max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("manageRemotesTitle")}</DialogTitle>
        </DialogHeader>
        {open && (
          <RemoteManageForm
            folderPath={folderPath}
            onCancel={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
