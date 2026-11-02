"use client"

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  ListChecks,
  Loader2,
  MessageSquare,
  RefreshCw,
  X,
} from "lucide-react"
import { toast } from "@/lib/notify"
import { toErrorMessage } from "@/lib/app-error"
import {
  FILE_TREE_DROP_DEVICE_ATTR,
  hasFileTreeDragType,
  readFileTreeDragPayload,
} from "@/lib/files/file-tree-dnd"
import { decodeBase64, encodeBase64 } from "@/lib/terminal/terminal-stream"
import {
  NODE_FIRST_SCREEN,
  NODE_MAX_READ,
  cancelDeviceTransfer,
  deviceRequest,
  startDeviceTransfer,
  transferInto,
  useDeviceTransfers,
  partError,
  useDeviceOverview,
  useNodeRequest,
  type Device,
  type NodeEntry,
  type NodeError,
  type NodeListing,
  type NodeProject,
  type NodeProjectOverview,
  type NodeReadHead,
  type NodeRequest,
} from "@/lib/devices"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** 超过这么大的文件只显示首屏、不编辑。 */
const MAX_EDIT = 4 * 1024 * 1024

/** 远端项目里能打开的东西：文件可编辑，会话 / 任务 / 笔记只读。 */
type RemoteItem =
  | { kind: "file"; path: string; label: string }
  | { kind: "doc"; request: NodeRequest; label: string }

const ROW =
  "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-xs hover:bg-accent/60"

function indent(depth: number) {
  return { paddingLeft: `${depth * 12 + 8}px` }
}

/**
 * 把本机文件树的条目拖进对方目录即传过去。桌面端的放下由文件树按 `data-tree-drop-device` 命中提交
 * （WebKit 收不到 DOM drop），这里的 `onDrop` 是网页端的路径。离线时不接收。
 */
function useDeviceDrop(deviceId: number, live: boolean) {
  const t = useTranslations("Folder.fileTreeTab")
  return (dir: string) =>
    live
      ? {
          [FILE_TREE_DROP_DEVICE_ATTR]: `${deviceId}:${dir}`,
          onDragOver: (event: DragEvent) => {
            if (!hasFileTreeDragType(event.dataTransfer)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = "copy"
          },
          onDrop: (event: DragEvent) => {
            const payload = readFileTreeDragPayload(event.dataTransfer)
            if (!payload) return
            event.preventDefault()
            if (payload.kind === "dir") {
              toast.error(t("toasts.transferDirUnsupported"))
              return
            }
            transferInto({ deviceId, dir }, payload.absPath).catch((error) =>
              toast.error(t("toasts.transferFailed"), {
                description: toErrorMessage(error),
              })
            )
          },
        }
      : {}
}

/** 传到这台设备的文件：进度、取消；失败或取消后可重试（从断点续上）或移除。 */
function DeviceTransfers({ deviceId }: { deviceId: number }) {
  const t = useTranslations("Folder.sidebar.devices")
  const { transfers, dismiss } = useDeviceTransfers(deviceId)
  if (transfers.length === 0) return null
  const action = (label: string, Icon: typeof X, onClick: () => void) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Icon className="size-3" />
    </button>
  )
  return (
    <ul aria-label={t("remote.transfers")}>
      {transfers.map((item) => {
        const name = item.dest.split("/").pop()
        const percent =
          item.total > 0 ? Math.floor((item.sent / item.total) * 100) : 0
        return (
          <li
            key={item.id}
            className="flex h-7 items-center gap-1.5 pr-2 text-xs"
            style={indent(1)}
            title={item.error ?? `${item.source} → ${item.dest}`}
          >
            <span className="min-w-0 flex-1 truncate">{name}</span>
            {item.state === "running" ? (
              <>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {percent}%
                </span>
                {action(
                  t("remote.transferCancel"),
                  X,
                  () => void cancelDeviceTransfer(item.id).catch(() => {})
                )}
              </>
            ) : (
              <>
                <span
                  className={cn(
                    "shrink-0",
                    item.state === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  )}
                >
                  {t(
                    item.state === "failed"
                      ? "remote.transferFailed"
                      : "remote.transferCancelled"
                  )}
                </span>
                {action(
                  t("remote.transferRetry"),
                  RefreshCw,
                  () =>
                    void startDeviceTransfer(
                      deviceId,
                      item.source,
                      item.dest
                    ).catch((error) =>
                      toast.error(t("remote.transferFailed"), {
                        description: toErrorMessage(error),
                      })
                    )
                )}
                {action(t("remote.transferDismiss"), X, () => dismiss(item.id))}
              </>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * 节点设备下的项目：对方 Berth 里的全部项目。展开即一次取齐项目概览（文件根目录、会话、任务、笔记），
 * 先出缓存再取最新；离线时只显示缓存并灰掉。
 */
export function DeviceProjects({
  device,
  live,
  onAddProject,
}: {
  device: Pick<Device, "id" | "name">
  /** 数据通道在线；否则只用缓存。 */
  live: boolean
  onAddProject: () => void
}) {
  const t = useTranslations("Folder.sidebar.devices")
  const overview = useDeviceOverview(device.id)
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
  const [item, setItem] = useState<RemoteItem | null>(null)
  const drop = useDeviceDrop(device.id, live)

  return (
    <div
      className={cn(!live && "opacity-60")}
      title={live ? undefined : t("remote.offline")}
    >
      {!overview ? (
        <p className="flex h-7 items-center gap-1.5 px-8 text-xs text-muted-foreground">
          {live ? (
            <>
              <Loader2 aria-hidden className="size-3 animate-spin" />
              {t("remote.loading")}
            </>
          ) : (
            t("remote.noCache")
          )}
        </p>
      ) : overview.projects.length === 0 ? (
        <button
          type="button"
          onClick={onAddProject}
          className="h-7 px-8 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          {t("emptyDevice")}
        </button>
      ) : (
        overview.projects.map((project) => (
          <div key={project.id}>
            <button
              type="button"
              title={project.path}
              aria-expanded={expanded[project.id] === true}
              onClick={() =>
                setExpanded((prev) => ({
                  ...prev,
                  [project.id]: !prev[project.id],
                }))
              }
              className={ROW}
              style={indent(1)}
              {...drop(project.path)}
            >
              <Folder
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="truncate">{project.name}</span>
            </button>
            {expanded[project.id] ? (
              <RemoteProject
                deviceId={device.id}
                project={project}
                live={live}
                onOpen={setItem}
              />
            ) : null}
          </div>
        ))
      )}
      <DeviceTransfers deviceId={device.id} />
      <Dialog
        open={item !== null}
        onOpenChange={(open) => !open && setItem(null)}
      >
        <DialogContent className="flex h-[75vh] flex-col sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="truncate">{item?.label}</DialogTitle>
            <DialogDescription>
              {t("runsOn", { name: device.name })}
            </DialogDescription>
          </DialogHeader>
          {item?.kind === "file" ? (
            <RemoteFile
              key={item.path}
              deviceId={device.id}
              path={item.path}
              live={live}
            />
          ) : item ? (
            <RemoteDoc
              deviceId={device.id}
              request={item.request}
              live={live}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 载入中 / 出错（带重试）的一行；有数据时只在出错时出现。 */
function RequestStatus({
  loading,
  error,
  reload,
  depth,
}: {
  loading: boolean
  error: NodeError | null
  reload: () => void
  depth: number
}) {
  const t = useTranslations("Folder.sidebar.devices")
  if (error)
    return (
      <div
        className="flex min-h-7 items-center gap-1.5 pr-2 text-xs text-destructive"
        style={indent(depth)}
      >
        <span className="min-w-0 flex-1 truncate" title={error.message}>
          {error.message}
        </span>
        <button
          type="button"
          title={t("remote.retry")}
          aria-label={t("remote.retry")}
          onClick={reload}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className="size-3" />
        </button>
      </div>
    )
  if (loading)
    return (
      <p
        className="flex h-7 items-center gap-1.5 text-xs text-muted-foreground"
        style={indent(depth)}
      >
        <Loader2 aria-hidden className="size-3 animate-spin" />
        {t("remote.loading")}
      </p>
    )
  return null
}

function RemoteProject({
  deviceId,
  project,
  live,
  onOpen,
}: {
  deviceId: number
  project: NodeProject
  live: boolean
  onOpen: (item: RemoteItem) => void
}) {
  const t = useTranslations("Folder.sidebar.devices")
  const { data, error, loading, reload } = useNodeRequest<NodeProjectOverview>(
    deviceId,
    { op: "project", project: project.id },
    live
  )
  const [open, setOpen] = useState<Record<string, boolean>>({ files: true })
  const section = (
    id: string,
    Icon: typeof Folder,
    label: string,
    body: () => ReactNode
  ) => (
    <div key={id}>
      <button
        type="button"
        aria-expanded={open[id] === true}
        onClick={() => setOpen((prev) => ({ ...prev, [id]: !prev[id] }))}
        className={cn(ROW, "text-muted-foreground")}
        style={indent(2)}
      >
        {open[id] ? (
          <ChevronDown aria-hidden className="size-3 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-3 shrink-0" />
        )}
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      {open[id] ? body() : null}
    </div>
  )
  const leaf = (
    key: string,
    label: string,
    item: RemoteItem,
    hint?: string
  ) => (
    <button
      key={key}
      type="button"
      title={hint ?? label}
      onClick={() => onOpen(item)}
      className={ROW}
      style={indent(3)}
    >
      <span className="truncate">{label}</span>
    </button>
  )
  const failed = (part: Parameters<typeof partError>[0]) => {
    const partFailed = partError(part)
    return partFailed ? (
      <p
        className="truncate text-xs text-destructive"
        style={indent(3)}
        title={partFailed.message}
      >
        {partFailed.message}
      </p>
    ) : null
  }

  return (
    <>
      <RequestStatus
        loading={loading && !data}
        error={error}
        reload={reload}
        depth={2}
      />
      {data ? (
        <>
          {section(
            "files",
            Folder,
            t("remote.files"),
            () =>
              failed(data.root) ?? (
                <RemoteEntries
                  deviceId={deviceId}
                  dir={project.path}
                  entries={(data.root as NodeListing).entries}
                  depth={3}
                  live={live}
                  onOpen={onOpen}
                />
              )
          )}
          {section(
            "sessions",
            MessageSquare,
            t("remote.sessions"),
            () =>
              failed(data.sessions) ??
              ("sessions" in data.sessions ? data.sessions.sessions : []).map(
                (session) =>
                  leaf(
                    session.session_id,
                    session.title || t("remote.untitled"),
                    {
                      kind: "doc",
                      label: session.title || t("remote.untitled"),
                      request: {
                        op: "session",
                        id: session.session_id,
                        agent: session.agent,
                      },
                    },
                    `${session.agent} · ${session.session_id}`
                  )
              )
          )}
          {section(
            "tasks",
            ListChecks,
            t("remote.tasks"),
            () =>
              failed(data.tasks) ??
              ("tasks" in data.tasks ? data.tasks.tasks : []).map((task) =>
                leaf(task.id, task.title, {
                  kind: "doc",
                  label: task.title,
                  request: { op: "task", project: project.id, task: task.id },
                })
              )
          )}
          {section(
            "notes",
            BookOpen,
            t("remote.notes"),
            () =>
              failed(data.notes) ??
              ("notes" in data.notes ? data.notes.notes : []).map((note) =>
                leaf(note.path, note.title, {
                  kind: "doc",
                  label: note.title,
                  request: {
                    op: "note",
                    project: project.id,
                    name: note.title,
                  },
                })
              )
          )}
        </>
      ) : null}
    </>
  )
}

/** 目录条目：目录按需展开（`List` 先出缓存，版本未变只传 `unchanged`），文件点开。 */
function RemoteEntries({
  deviceId,
  dir,
  entries,
  depth,
  live,
  onOpen,
}: {
  deviceId: number
  dir: string
  entries: NodeEntry[]
  depth: number
  live: boolean
  onOpen: (item: RemoteItem) => void
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const drop = useDeviceDrop(deviceId, live)
  return (
    <>
      {entries.map((entry) => {
        const path = `${dir.replace(/\/+$/, "")}/${entry.name}`
        return (
          <div key={entry.name}>
            <button
              type="button"
              title={path}
              aria-expanded={
                entry.dir ? expanded[entry.name] === true : undefined
              }
              onClick={() =>
                entry.dir
                  ? setExpanded((prev) => ({
                      ...prev,
                      [entry.name]: !prev[entry.name],
                    }))
                  : onOpen({ kind: "file", path, label: entry.name })
              }
              className={ROW}
              style={indent(depth)}
              {...(entry.dir ? drop(path) : {})}
            >
              {entry.dir ? (
                <Folder
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              ) : (
                <File
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              )}
              <span className="truncate">{entry.name}</span>
            </button>
            {entry.dir && expanded[entry.name] ? (
              <RemoteDir
                deviceId={deviceId}
                path={path}
                depth={depth + 1}
                live={live}
                onOpen={onOpen}
              />
            ) : null}
          </div>
        )
      })}
    </>
  )
}

function RemoteDir({
  deviceId,
  path,
  depth,
  live,
  onOpen,
}: {
  deviceId: number
  path: string
  depth: number
  live: boolean
  onOpen: (item: RemoteItem) => void
}) {
  const t = useTranslations("Folder.sidebar.devices")
  const { data, error, loading, reload } = useNodeRequest<NodeListing>(
    deviceId,
    { op: "list", path },
    live
  )
  return (
    <>
      <RequestStatus
        loading={loading && !data}
        error={error}
        reload={reload}
        depth={depth}
      />
      {data?.entries.length === 0 ? (
        <p className="text-xs text-muted-foreground" style={indent(depth)}>
          {t("remote.empty")}
        </p>
      ) : null}
      {data ? (
        <RemoteEntries
          deviceId={deviceId}
          dir={path}
          entries={data.entries}
          depth={depth}
          live={live}
          onOpen={onOpen}
        />
      ) : null}
    </>
  )
}

/** 会话 / 任务 / 笔记的只读正文。 */
function RemoteDoc({
  deviceId,
  request,
  live,
}: {
  deviceId: number
  request: NodeRequest
  live: boolean
}) {
  const t = useTranslations("Folder.sidebar.devices")
  const { data, error, loading, reload } = useNodeRequest<{
    text?: string
    prdText?: string
    body?: string
  }>(deviceId, request, live)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {!live ? (
        <p className="text-xs text-muted-foreground">{t("remote.offline")}</p>
      ) : null}
      <RequestStatus
        loading={loading && !data}
        error={error}
        reload={reload}
        depth={0}
      />
      {data ? (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md border p-3 text-xs">
          {data.text ?? data.prdText ?? data.body ?? ""}
        </pre>
      ) : null}
    </div>
  )
}

function concat(chunks: Uint8Array[]) {
  const out = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  )
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * 远端文件：先出缓存的首屏，再取最新首屏并续读其余；读全才能编辑。
 * 保存带读到时的版本，对方改过则报冲突、不覆盖。
 */
function RemoteFile({
  deviceId,
  path,
  live,
}: {
  deviceId: number
  path: string
  live: boolean
}) {
  const t = useTranslations("Folder.sidebar.devices")
  const [file, setFile] = useState({
    content: "",
    version: null as string | null,
    size: 0,
    binary: false,
    complete: false,
    loading: true,
    saving: false,
    dirty: false,
    conflict: false,
    error: null as NodeError | null,
  })
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    []
  )

  const load = useCallback(async (): Promise<void> => {
    const first: NodeRequest = {
      op: "read",
      path,
      offset: 0,
      len: NODE_FIRST_SCREEN,
    }
    const hit = await deviceRequest<NodeReadHead>(deviceId, first, {
      cached: true,
    }).catch(() => null)
    if (!alive.current) return
    if (hit && "result" in hit)
      setFile((prev) =>
        prev.dirty
          ? prev
          : {
              ...prev,
              content: new TextDecoder().decode(decodeBase64(hit.body)),
              version: hit.result.version,
              size: hit.result.size,
              binary: hit.result.binary,
              complete: false,
            }
      )
    if (!live) {
      setFile((prev) => ({ ...prev, loading: false }))
      return
    }
    let head: NodeReadHead | null = null
    let chunks: Uint8Array[] = []
    let received = 0
    reading: for (let attempt = 0; attempt < 3; attempt++) {
      const reply = await deviceRequest<NodeReadHead>(deviceId, first)
      if (!alive.current) return
      if ("error" in reply) {
        setFile((prev) => ({ ...prev, loading: false, error: reply.error }))
        return
      }
      head = reply.result
      chunks = [decodeBase64(reply.body)]
      received = chunks[0].length
      while (!head.binary && head.size <= MAX_EDIT && received < head.size) {
        const next = await deviceRequest<NodeReadHead>(deviceId, {
          op: "read",
          path,
          offset: received,
          len: NODE_MAX_READ,
        })
        if (!alive.current) return
        if ("error" in next) {
          setFile((prev) => ({ ...prev, loading: false, error: next.error }))
          return
        }
        // 续读途中对方改了：从头再读（最多三次）。
        if (next.result.version !== head.version && attempt < 2)
          continue reading
        const chunk = decodeBase64(next.body)
        if (chunk.length === 0) break
        chunks.push(chunk)
        received += chunk.length
      }
      break
    }
    if (!head) return
    setFile({
      content: new TextDecoder().decode(concat(chunks)),
      version: head.version,
      size: head.size,
      binary: head.binary,
      complete: received >= head.size,
      loading: false,
      saving: false,
      dirty: false,
      conflict: false,
      error: null,
    })
  }, [deviceId, path, live])

  useEffect(() => {
    // load 里的 setState 都在 await 之后。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const reload = () => {
    setFile((prev) => ({
      ...prev,
      loading: true,
      dirty: false,
      conflict: false,
      error: null,
    }))
    void load()
  }

  const save = async () => {
    setFile((prev) => ({ ...prev, saving: true, error: null }))
    const reply = await deviceRequest<{ version: string }>(
      deviceId,
      { op: "write", path, version: file.version },
      { body: encodeBase64(new TextEncoder().encode(file.content)) }
    ).catch((error: unknown) => ({
      error: { kind: "internal", message: String(error) },
    }))
    if (!alive.current) return
    setFile((prev) =>
      "error" in reply
        ? {
            ...prev,
            saving: false,
            conflict: reply.error.kind === "conflict",
            error: reply.error.kind === "conflict" ? null : reply.error,
          }
        : {
            ...prev,
            saving: false,
            dirty: false,
            version: reply.result.version,
          }
    )
  }

  const editable = live && file.complete && !file.binary && !file.conflict
  const notice = !live
    ? t("remote.offline")
    : file.binary
      ? t("remote.binary")
      : file.size > MAX_EDIT
        ? t("remote.tooLarge")
        : null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {notice ? (
        <p className="text-xs text-muted-foreground">{notice}</p>
      ) : null}
      {file.conflict ? (
        <p role="alert" className="text-xs text-destructive">
          {t("remote.conflict")}
        </p>
      ) : null}
      {file.error ? (
        <p role="alert" className="break-words text-xs text-destructive">
          {file.error.message}
        </p>
      ) : null}
      {file.binary ? null : (
        <textarea
          aria-label={path}
          spellCheck={false}
          readOnly={!editable}
          value={file.content}
          onChange={(event) =>
            setFile((prev) => ({
              ...prev,
              content: event.target.value,
              dirty: true,
            }))
          }
          className="min-h-0 flex-1 resize-none rounded-md border bg-transparent p-3 font-mono text-xs outline-none"
        />
      )}
      <div className="flex items-center justify-end gap-2">
        {file.loading ? (
          <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 aria-hidden className="size-3 animate-spin" />
            {t("remote.loading")}
          </span>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!live || file.loading}
          title={live ? undefined : t("remote.offline")}
          onClick={reload}
        >
          {t("remote.reload")}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!editable || !file.dirty || file.saving}
          title={live ? undefined : t("remote.offline")}
          onClick={() => void save()}
        >
          {file.saving ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : null}
          {t("remote.save")}
        </Button>
      </div>
    </div>
  )
}
