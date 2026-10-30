import { getTransport, isDesktop } from "./transport"

import { getCurrentEffectiveAppLocale } from "./i18n"
import type {
  AgentType,
  AppLocale,
  DbConversationDetail,
  FolderDetail,
  CreateChatConversationResult,
  CreateChatDirResult,
  WorktreeResolution,
  DbConversationSummary,
  ProjectAgentSessionPage,
  ProjectAgentSessionPageRequest,
  ResolveProjectAgentSessionResult,
  ProjectSessionOverview,
  SetCurrentDocumentContextRequest,
  PrimaryTab,
  PrimaryTabsSnapshot,
  SavePrimaryTabsOutcome,
  GitStatusEntry,
  GitBranchList,
  GitHeadInfo,
  GitPullResult,
  GitPushResult,
  GitPushInfo,
  GitMergeResult,
  GitRebaseResult,
  GitResetMode,
  GitConflictFileVersions,
  GitCommitResult,
  GitRemote,
  GitStashEntry,
  FolderCommand,
  TerminalDescriptor,
  CreateTerminalSessionRequest,
  FileTreeNode,
  WorkspaceFileEntry,
  WorkspaceReferenceMatch,
  DirectoryEntry,
  FilePreviewContent,
  FileEditContent,
  FileSaveResult,
  WorkspaceSnapshotResponse,
  GitLogResult,
  GitLogFileChange,
  AvailableTerminalShells,
  SystemLanguageSettings,
  SystemProxySettings,
  SystemRenderingSettings,
  SystemTerminalSettings,
  GitCredentials,
  GitDetectResult,
  GitSettings,
  GitHubAccountsSettings,
  GitHubTokenValidation,
  ModelProviderInfo,
  UpdateModelProviderResult,
  QuickMessage,
  PreviewToolInfo,
  ToolUpdateCheck,
  RuntimeCapabilities,
} from "./types"

export async function getRuntimeCapabilities(): Promise<RuntimeCapabilities> {
  return {
    primaryTabsV2: true,
    personalTerminalV2: true,
  }
}

export async function listProjectAgentSessions(
  request: ProjectAgentSessionPageRequest
): Promise<ProjectAgentSessionPage> {
  return getTransport().call("list_project_agent_sessions", { request })
}

export async function listProjectSessionOverview(
  folderId: number,
  limit: number
): Promise<ProjectSessionOverview> {
  return getTransport().call("list_project_session_overview", {
    folderId,
    limit,
  })
}

export async function resolveProjectAgentSession(params: {
  folderId: number
  agentType: AgentType
  externalId: string
}): Promise<ResolveProjectAgentSessionResult> {
  return getTransport().call("resolve_project_agent_session", params)
}

// ─── Office tools ───

export async function installPreviewTool(
  taskId: string,
  path: string,
  toolId?: string,
  update?: boolean
): Promise<PreviewToolInfo> {
  // The vendor installer downloads + extracts a multi-MB binary; allow well
  // beyond the default 60s web-call timeout so slow networks don't surface a
  // spurious timeout while progress is still streaming. Sits 30s ABOVE the
  // backend's own 600s deadline so the backend's structured timeout error wins
  // the race instead of a generic transport abort. `taskId` correlates the
  // `app://preview-tool-install` stream the preview subscribes to. `path` picks
  // the plugin that previews this file type; its install script runs. `toolId`
  // (Settings → Tools) picks the plugin directly and ignores `path`; `update`
  // prefers the program's own update command over re-running the installer.
  return getTransport().call(
    "install_preview_tool",
    { taskId, path, toolId, update },
    { timeoutMs: 630_000 }
  )
}

/** Latest version from plugin `toolId`'s `latest` source; null when it declares none. Hits the network. */
export async function checkToolUpdate(
  toolId: string
): Promise<ToolUpdateCheck | null> {
  return getTransport().call("tool_update_check", { toolId })
}

/** Whether plugin `toolId`'s program is installed and runs; null when it declares none. */
export async function getPreviewToolStatus(
  toolId: string
): Promise<PreviewToolInfo | null> {
  return getTransport().call("preview_tool_status", { toolId })
}

/** A provider mark (protocol watch/1 `mark-update`, see docs/contribution-points.md). */
export interface PreviewMark {
  id?: string
  path: string
  color?: string | null
  note?: string | null
  find?: string | null
  tofix?: string | null
  stale?: boolean
}

/**
 * Start (or share, by ref-count) the enabled preview plugin's long-lived server
 * for a file (`org.berth.preview`, protocol watch/1). `path` is relative to
 * `rootPath`. Returns the loopback `port`, the first snapshot and the plugin's
 * preview `script`; live refresh comes from the provider's SSE channel.
 */
export async function startPreviewWatch(
  rootPath: string,
  path: string
): Promise<{
  port: number
  html?: string | null
  marks?: PreviewMark[] | null
  /** The providing plugin's `org.berth.preview.script`, injected into the frame. */
  script?: string | null
}> {
  return getTransport().call("start_preview_watch", { rootPath, path })
}

/** Release one reference to a file's watch preview server. */
export async function stopPreviewWatch(
  rootPath: string,
  path: string
): Promise<void> {
  return getTransport().call("stop_preview_watch", { rootPath, path })
}

/**
 * Re-fetch the current preview HTML of a live office watch server (server-side
 * loopback GET). The desktop Office preview renders snapshots in the sandboxed
 * srcdoc document, so refreshes pull a new snapshot instead of reloading a
 * visible child WebView.
 */
export async function refreshPreviewWatchHtml(port: number): Promise<string> {
  return getTransport().call("preview_watch_refresh_html", { port })
}

export async function setTrayLocale(locale: AppLocale): Promise<void> {
  return getTransport().call("set_tray_locale", { locale })
}

export async function updateTrafficLightPosition(zoom: number): Promise<void> {
  return getTransport().call("update_traffic_light_position", { zoom })
}

export async function updateAppearanceMode(mode: string): Promise<void> {
  return getTransport().call("update_appearance_mode", { mode })
}

export async function getSystemProxySettings(): Promise<SystemProxySettings> {
  return getTransport().call("get_system_proxy_settings")
}

export async function updateSystemProxySettings(
  settings: SystemProxySettings
): Promise<SystemProxySettings> {
  return getTransport().call("update_system_proxy_settings", { settings })
}

export async function getSystemLanguageSettings(): Promise<SystemLanguageSettings> {
  return getTransport().call("get_system_language_settings")
}

export async function updateSystemLanguageSettings(
  settings: SystemLanguageSettings
): Promise<SystemLanguageSettings> {
  return getTransport().call("update_system_language_settings", { settings })
}

export async function getSystemTerminalSettings(): Promise<SystemTerminalSettings> {
  return getTransport().call("get_system_terminal_settings")
}

export async function updateSystemTerminalSettings(
  settings: SystemTerminalSettings
): Promise<SystemTerminalSettings> {
  return getTransport().call("update_system_terminal_settings", { settings })
}

export async function getAvailableTerminalShells(): Promise<AvailableTerminalShells> {
  return getTransport().call("get_available_terminal_shells")
}

export async function probeTerminalShellPath(path: string): Promise<boolean> {
  return getTransport().call("probe_terminal_shell_path", { path })
}

export async function getSystemRenderingSettings(): Promise<SystemRenderingSettings> {
  return getTransport().call("get_system_rendering_settings")
}

export async function updateSystemRenderingSettings(
  settings: SystemRenderingSettings
): Promise<SystemRenderingSettings> {
  return getTransport().call("update_system_rendering_settings", { settings })
}

export {
  getLogSettings,
  setLogSettings,
  getRecentLogs,
  openLogsDir,
  subscribeLogAppended,
  subscribeLogSettingsChanged,
  LOG_APPENDED_EVENT,
  LOG_SETTINGS_CHANGED_EVENT,
} from "./api/logging"

// --- Version Control ---

export async function detectGit(): Promise<GitDetectResult> {
  return getTransport().call("detect_git")
}

export async function testGitPath(path: string): Promise<GitDetectResult> {
  return getTransport().call("test_git_path", { path })
}

export async function getGitSettings(): Promise<GitSettings> {
  return getTransport().call("get_git_settings")
}

export async function updateGitSettings(
  settings: GitSettings
): Promise<GitSettings> {
  return getTransport().call("update_git_settings", { settings })
}

export async function getGitHubAccounts(): Promise<GitHubAccountsSettings> {
  return getTransport().call("get_github_accounts")
}

export async function validateGitHubToken(
  serverUrl: string,
  token: string
): Promise<GitHubTokenValidation> {
  return getTransport().call("validate_github_token", { serverUrl, token })
}

export async function updateGitHubAccounts(
  settings: GitHubAccountsSettings
): Promise<GitHubAccountsSettings> {
  return getTransport().call("update_github_accounts", { settings })
}

export async function saveAccountToken(
  accountId: string,
  token: string
): Promise<void> {
  return getTransport().call("save_account_token", { accountId, token })
}

export async function getAccountToken(
  accountId: string
): Promise<string | null> {
  return getTransport().call("get_account_token", { accountId })
}

export async function deleteAccountToken(accountId: string): Promise<void> {
  return getTransport().call("delete_account_token", { accountId })
}

export async function getFolder(folderId: number): Promise<FolderDetail> {
  return getTransport().call("get_folder", { folderId })
}

export async function listAllConversations(params?: {
  folder_ids?: number[] | null
  agent_type?: AgentType | null
  search?: string | null
  sort_by?: string | null
  include_children?: boolean | null
}): Promise<DbConversationSummary[]> {
  return getTransport().call("list_all_conversations", {
    folderIds: params?.folder_ids ?? null,
    agentType: params?.agent_type ?? null,
    search: params?.search ?? null,
    sortBy: params?.sort_by ?? null,
    includeChildren: params?.include_children ?? null,
  })
}

export async function listPrimaryTabs(): Promise<PrimaryTabsSnapshot> {
  return getTransport().call("list_primary_tabs")
}

export async function savePrimaryTabs(
  items: PrimaryTab[],
  expectedVersion: number,
  origin: string
): Promise<SavePrimaryTabsOutcome> {
  return getTransport().call("save_primary_tabs", {
    items,
    expectedVersion,
    origin,
  })
}

export async function listOpenFolderDetails(): Promise<FolderDetail[]> {
  return getTransport().call("list_open_folder_details")
}

export async function listAllFolderDetails(): Promise<FolderDetail[]> {
  return getTransport().call("list_all_folder_details")
}

export async function openFolderById(folderId: number): Promise<FolderDetail> {
  return getTransport().call("open_folder_by_id", { folderId })
}

export async function removeFolderFromWorkspace(
  folderId: number,
  deleteWorktree = false
): Promise<void> {
  return getTransport().call("remove_folder_from_workspace", {
    folderId,
    deleteWorktree,
  })
}

export async function reorderFolders(ids: number[]): Promise<void> {
  return getTransport().call("reorder_folders", { ids })
}

export async function updateFolderAlias(
  folderId: number,
  alias: string | null,
  pinned?: boolean,
  updateAlias = true
): Promise<FolderDetail> {
  return getTransport().call("update_folder_alias", {
    folderId,
    alias,
    updateAlias,
    ...(pinned === undefined ? {} : { pinned }),
  })
}

/** worktree 目录与分支一起改名；目录里还有终端在跑时后端拒绝。 */
export async function renameWorktree(
  folderId: number,
  name: string
): Promise<FolderDetail> {
  return getTransport().call("rename_worktree", { folderId, name })
}

export async function getFolderConversation(
  conversationId: number
): Promise<DbConversationDetail> {
  return getTransport().call("get_folder_conversation", { conversationId })
}

/** 会话源文件的变化标记（只 stat 不解析），用于低成本判断是否需要重读详情。 */
export async function getConversationSourceRevision(
  conversationId: number
): Promise<string | null> {
  return getTransport().call("get_conversation_source_revision", {
    conversationId,
  })
}

export async function cloneRepository(
  url: string,
  targetDir: string,
  credentials?: GitCredentials | null
): Promise<void> {
  return getTransport().call("clone_repository", {
    url,
    targetDir,
    credentials: credentials ?? null,
  })
}

export async function setCurrentDocumentContext(
  request: SetCurrentDocumentContextRequest
): Promise<void> {
  await getTransport().call("set_current_document_context", {
    request,
  } as unknown as Record<string, unknown>)
}

export async function setCurrentWorkspaceTerminal(
  terminalId: string | null
): Promise<void> {
  await getTransport().call("set_current_workspace_terminal", { terminalId })
}

export async function clearCurrentDocumentContext(
  conversationId: number
): Promise<void> {
  await setCurrentDocumentContext({
    conversationId,
    clear: true,
    kind: "",
  })
}

export async function getGitBranch(path: string): Promise<string | null> {
  return getTransport().call("get_git_branch", { path })
}

export async function getGitHead(path: string): Promise<GitHeadInfo> {
  return getTransport().call("get_git_head", { path })
}

export async function gitInit(path: string): Promise<void> {
  return getTransport().call("git_init", { path })
}

export async function gitPull(
  path: string,
  credentials?: GitCredentials | null
): Promise<GitPullResult> {
  return getTransport().call("git_pull", {
    path,
    credentials: credentials ?? null,
  })
}

export async function gitStartPullMerge(
  path: string,
  upstreamCommit?: string | null
): Promise<void> {
  return getTransport().call("git_start_pull_merge", { path, upstreamCommit })
}

export async function gitFetch(
  path: string,
  credentials?: GitCredentials | null
): Promise<string> {
  return getTransport().call("git_fetch", {
    path,
    credentials: credentials ?? null,
  })
}

export async function gitPushInfo(path: string): Promise<GitPushInfo> {
  return getTransport().call("git_push_info", { path })
}

export async function gitPush(
  path: string,
  remote?: string | null,
  credentials?: GitCredentials | null,
  folderId?: number | null
): Promise<GitPushResult> {
  return getTransport().call("git_push", {
    path,
    remote: remote ?? null,
    credentials: credentials ?? null,
    folderId: folderId ?? null,
  })
}

export async function gitNewBranch(
  path: string,
  branchName: string,
  startPoint?: string
): Promise<void> {
  return getTransport().call("git_new_branch", {
    path,
    branchName,
    startPoint: startPoint ?? null,
  })
}

export async function gitWorktreeAdd(
  path: string,
  branchName: string,
  worktreePath: string
): Promise<void> {
  return getTransport().call("git_worktree_add", {
    path,
    branchName,
    worktreePath,
  })
}

export async function gitCheckout(
  path: string,
  branchName: string
): Promise<void> {
  return getTransport().call("git_checkout", { path, branchName })
}

export async function gitListAllBranches(path: string): Promise<GitBranchList> {
  return getTransport().call("git_list_all_branches", { path })
}

export async function gitMerge(
  path: string,
  branchName: string
): Promise<GitMergeResult> {
  return getTransport().call("git_merge", { path, branchName })
}

export async function gitRebase(
  path: string,
  branchName: string
): Promise<GitRebaseResult> {
  return getTransport().call("git_rebase", { path, branchName })
}

export async function gitDeleteBranch(
  path: string,
  branchName: string,
  force: boolean = false
): Promise<string> {
  return getTransport().call("git_delete_branch", {
    path,
    branchName,
    force,
  })
}

export async function gitDeleteRemoteBranch(
  path: string,
  remote: string,
  branch: string,
  credentials?: GitCredentials | null
): Promise<void> {
  return getTransport().call("git_delete_remote_branch", {
    path,
    remote,
    branch,
    credentials: credentials ?? null,
  })
}

export async function gitListConflicts(path: string): Promise<string[]> {
  return getTransport().call("git_list_conflicts", { path })
}

export async function gitConflictFileVersions(
  path: string,
  file: string
): Promise<GitConflictFileVersions> {
  return getTransport().call("git_conflict_file_versions", { path, file })
}

export async function gitResolveConflict(
  path: string,
  file: string,
  content: string
): Promise<void> {
  return getTransport().call("git_resolve_conflict", { path, file, content })
}

export async function gitAbortOperation(
  path: string,
  operation: string
): Promise<void> {
  return getTransport().call("git_abort_operation", { path, operation })
}

export async function gitContinueOperation(
  path: string,
  operation: string
): Promise<void> {
  return getTransport().call("git_continue_operation", { path, operation })
}

export async function openMergeWindow(
  folderId: number,
  operation: string,
  upstreamCommit?: string | null
): Promise<void> {
  const locale = getCurrentEffectiveAppLocale()
  if (isDesktop()) {
    return getTransport().call("open_merge_window", {
      folderId,
      operation,
      upstreamCommit: upstreamCommit ?? null,
      locale,
    })
  }
  const result = await getTransport().call<{ path: string }>(
    "open_merge_window",
    {
      folderId,
      operation,
      upstreamCommit: upstreamCommit ?? null,
      locale,
    }
  )
  window.open(result.path, `merge-${folderId}`)
}

export async function openStashWindow(folderId: number): Promise<void> {
  const locale = getCurrentEffectiveAppLocale()
  if (isDesktop()) {
    return getTransport().call("open_stash_window", {
      folderId,
      locale,
    })
  }
  const result = await getTransport().call<{ path: string }>(
    "open_stash_window",
    { folderId, locale }
  )
  window.open(result.path, `stash-${folderId}`)
}

export async function openPushWindow(folderId: number): Promise<void> {
  const locale = getCurrentEffectiveAppLocale()
  if (isDesktop()) {
    return getTransport().call("open_push_window", {
      folderId,
      locale,
    })
  }
  const result = await getTransport().call<{ path: string }>(
    "open_push_window",
    { folderId, locale }
  )
  window.open(result.path, `push-${folderId}`)
}

export async function gitStashPush(
  path: string,
  message?: string,
  keepIndex?: boolean
): Promise<string> {
  return getTransport().call("git_stash_push", {
    path,
    message: message ?? null,
    keepIndex: keepIndex ?? false,
  })
}

export async function gitStashList(path: string): Promise<GitStashEntry[]> {
  return getTransport().call("git_stash_list", { path })
}

export async function gitStashApply(
  path: string,
  stashRef: string
): Promise<string> {
  return getTransport().call("git_stash_apply", { path, stashRef })
}

export async function gitStashDrop(
  path: string,
  stashRef: string
): Promise<string> {
  return getTransport().call("git_stash_drop", { path, stashRef })
}

export async function gitStashShow(
  path: string,
  stashRef: string
): Promise<GitStatusEntry[]> {
  return getTransport().call("git_stash_show", { path, stashRef })
}

export async function gitListRemotes(path: string): Promise<GitRemote[]> {
  return getTransport().call("git_list_remotes", { path })
}

export async function gitFetchRemote(
  path: string,
  name: string,
  credentials?: GitCredentials | null
): Promise<string> {
  return getTransport().call("git_fetch_remote", {
    path,
    name,
    credentials: credentials ?? null,
  })
}

export async function gitAddRemote(
  path: string,
  name: string,
  url: string
): Promise<void> {
  return getTransport().call("git_add_remote", { path, name, url })
}

export async function gitRemoveRemote(
  path: string,
  name: string
): Promise<void> {
  return getTransport().call("git_remove_remote", { path, name })
}

export async function gitSetRemoteUrl(
  path: string,
  name: string,
  url: string
): Promise<void> {
  return getTransport().call("git_set_remote_url", { path, name, url })
}

export async function gitStatus(
  path: string,
  showAllUntracked?: boolean
): Promise<GitStatusEntry[]> {
  return getTransport().call("git_status", {
    path,
    showAllUntracked: showAllUntracked ?? null,
  })
}

export async function gitDiff(path: string, file?: string): Promise<string> {
  return getTransport().call("git_diff", { path, file: file ?? null })
}

export async function gitDiffWithBranch(
  path: string,
  branch: string,
  file?: string
): Promise<string> {
  return getTransport().call("git_diff_with_branch", {
    path,
    branch,
    file: file ?? null,
  })
}

export async function gitShowDiff(
  path: string,
  commit: string,
  file?: string
): Promise<string> {
  return getTransport().call("git_show_diff", {
    path,
    commit,
    file: file ?? null,
  })
}

export async function gitShowFile(
  path: string,
  file: string,
  refName?: string
): Promise<string> {
  return getTransport().call("git_show_file", {
    path,
    file,
    refName: refName ?? null,
  })
}

export async function gitIsTracked(
  path: string,
  file: string
): Promise<boolean> {
  return getTransport().call("git_is_tracked", { path, file })
}

export async function gitCommit(
  path: string,
  message: string,
  files: string[],
  folderId?: number | null
): Promise<GitCommitResult> {
  return getTransport().call("git_commit", {
    path,
    message,
    files,
    folderId: folderId ?? null,
  })
}

export async function gitRollbackFile(
  path: string,
  file: string
): Promise<void> {
  return getTransport().call("git_rollback_file", { path, file })
}

export async function gitAddFiles(
  path: string,
  files: string[]
): Promise<void> {
  return getTransport().call("git_add_files", { path, files })
}

// Window management commands

export async function openFolder(path: string): Promise<FolderDetail> {
  return getTransport().call("open_folder", { path })
}

/**
 * Open a freshly created git worktree directory as a folder, recording the root
 * folder it descends from (`sourceFolderId` is the folder the worktree was
 * created from; the backend flattens to the root). Lets the worktree folder be
 * merged under its parent in the sidebar.
 */
export async function openWorktreeFolder(
  path: string,
  sourceFolderId: number
): Promise<FolderDetail> {
  return getTransport().call("open_worktree_folder", { path, sourceFolderId })
}

/**
 * 以 folder 所属 repo 家族为单位与 `git worktree list` 对账：登记新 worktree、
 * 移除已删除的（后端决定 open/closed 的清理深度）。返回对账后的家族详情。
 */
export async function reconcileWorktreeFamily(
  folderId: number
): Promise<FolderDetail[]> {
  return getTransport().call("reconcile_worktree_family", { folderId })
}

/**
 * Resolve where `branch` is checked out across the repo's worktrees. Returns the
 * canonical worktree path (or null if the branch isn't checked out anywhere) and
 * the registered folder id owning that path (or null for an external worktree).
 * Path matching is canonicalized on the host that runs git, so it is correct for
 * symlinked and remote-workspace paths the webview cannot resolve.
 */
export async function resolveWorktreeFolder(
  repoPath: string,
  branch: string
): Promise<WorktreeResolution> {
  return getTransport().call("resolve_worktree_folder", { repoPath, branch })
}

export async function openCommitWindow(folderId: number): Promise<void> {
  const locale = getCurrentEffectiveAppLocale()
  if (isDesktop()) {
    return getTransport().call("open_commit_window", {
      folderId,
      locale,
    })
  }
  const result = await getTransport().call<{ path: string }>(
    "open_commit_window",
    { folderId, locale }
  )
  window.open(result.path, `commit-${folderId}`)
}

// Cross-window handoff for the project launcher, which lives in its own
// window/tab and can't reach the workspace's React state directly. The
// backend upserts the folder and emits `folder://open-in-workspace` carrying
// the FolderDetail through the shared EventEmitter; the transport layer routes
// that to the right workspace window in every runtime (local Tauri bus, the
// server's WebSocket broadcaster for web, and the remote server's broadcaster
// for remote desktop), so only windows talking to this backend react. The
// workspace subscribes via WorkspaceOpenFolderListener.
export const FOLDER_OPEN_IN_WORKSPACE_EVENT = "folder://open-in-workspace"

// CLI handoff: `berth open <path>[:line]` asks the GUI control socket to open
// a file. The backend validates the path and emits this event; only the main
// workspace window subscribes (WorkspaceOpenFileListener) so auxiliary windows
// never double-open the file.
export const WORKSPACE_OPEN_FILE_EVENT = "workspace://open-file"

// Agent hook (`berth group hook`) reported a state or group change through the
// control socket (`agent.changed`). Wake-up only: listeners re-read pane state
// and the group ledger instead of waiting for the next poll.
export const AGENT_CHANGED_EVENT = "agent://changed"

export interface WorkspaceOpenFilePayload {
  path: string
  line: number | null
}

// One open request registered by the control plane. The event above is only a
// wake-up; the main window claims this list, performs the open, and settles
// each request from its actual completion point (agent contract §4).
export interface WorkspaceOpenFileClaim {
  request_id: number
  path: string
  line: number | null
  remaining_ms: number
}

/** Claim every unexpired `berth open` request. Main window only. */
export async function claimOpenFileRequests(): Promise<
  WorkspaceOpenFileClaim[]
> {
  // Tauri 按参数名绑定：command 的第二个形参名是 `request`。
  return getTransport().call("workspace_open_file_handoff", {
    request: { operation: "claim" },
  })
}

export type WorkspaceOpenFileOutcome =
  | { state: "opened"; path: string; line: number | null }
  | { state: "failed"; message: string }

/** 只转发实际打开或定位结果，不用请求值补齐缺失的回执。 */
export async function settleOpenFileRequest(
  requestId: number,
  outcome: WorkspaceOpenFileOutcome
): Promise<void> {
  await getTransport().call("workspace_open_file_handoff", {
    request: {
      operation: "complete",
      request_id: requestId,
      state: outcome.state,
      path: outcome.state === "opened" ? outcome.path : null,
      line: outcome.state === "opened" ? outcome.line : null,
      message: outcome.state === "failed" ? outcome.message : null,
    },
  })
}

export async function openFolderInWorkspace(
  path: string
): Promise<FolderDetail> {
  return getTransport().call("open_folder_in_workspace", { path })
}

/**
 * Create a folderless "chat mode" conversation. The backend lazily creates a
 * dated per-conversation scratch dir and a dedicated hidden chat folder
 * backing it, then the conversation. Returns the new conversation id plus that
 * folder so the caller can seed `allFolders` (cwd / active-folder) immediately.
 */
export async function createChatConversation(
  agentType: AgentType,
  title?: string,
  // Reuse a scratch dir already minted by `createChatDir` (eager connect) so the
  // ACP cwd never moves across the first send; omit to let the backend mint one.
  existingDir?: string
): Promise<CreateChatConversationResult> {
  return getTransport().call("create_chat_conversation", {
    agentType,
    title: title ?? null,
    existingDir: existingDir ?? null,
  })
}

/**
 * Eagerly create a chat-mode scratch directory (filesystem only — no DB rows)
 * and return its path, so a chat draft can connect ACP at a real cwd the instant
 * "no-folder mode" is selected, before any first prompt.
 */
export async function createChatDir(): Promise<CreateChatDirResult> {
  return getTransport().call("create_chat_dir", {})
}

// Folder command management

export async function listFolderCommands(
  folderId: number
): Promise<FolderCommand[]> {
  return getTransport().call("list_folder_commands", { folderId })
}

export async function createFolderCommand(
  folderId: number,
  name: string,
  command: string
): Promise<FolderCommand> {
  return getTransport().call("create_folder_command", {
    folderId,
    name,
    command,
  })
}

export async function updateFolderCommand(
  id: number,
  name?: string,
  command?: string,
  sortOrder?: number
): Promise<FolderCommand> {
  return getTransport().call("update_folder_command", {
    id,
    name: name ?? null,
    command: command ?? null,
    sortOrder: sortOrder ?? null,
  })
}

export async function deleteFolderCommand(id: number): Promise<void> {
  return getTransport().call("delete_folder_command", { id })
}

// Quick message management

export async function quickMessagesList(): Promise<QuickMessage[]> {
  return getTransport().call("quick_messages_list")
}

export async function quickMessagesCreate(params: {
  title: string
  content: string
}): Promise<QuickMessage> {
  return getTransport().call("quick_messages_create", {
    title: params.title,
    content: params.content,
  })
}

export async function quickMessagesUpdate(params: {
  id: number
  title?: string
  content?: string
}): Promise<QuickMessage> {
  return getTransport().call("quick_messages_update", {
    id: params.id,
    title: params.title ?? null,
    content: params.content ?? null,
  })
}

export async function quickMessagesDelete(id: number): Promise<void> {
  return getTransport().call("quick_messages_delete", { id })
}

// Directory browser (for web/server mode)

export async function getHomeDirectory(): Promise<string> {
  return getTransport().call("get_home_directory")
}

export async function listDirectoryEntries(
  path: string
): Promise<DirectoryEntry[]> {
  return getTransport().call("list_directory_entries", { path })
}

// Hard ceiling for a single attachment, kept in lockstep with the server's
// `UPLOAD_MAX_BYTES`. Aligned with axum's default multipart body limit (and
// with the fact that anything larger won't fit a model context anyway).
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024

// i18n_key values the Rust upload layer stamps via `with_i18n` and that
// the frontend branches on. MUST stay in lockstep with the Rust
// constants `UPLOAD_I18N_KEY_TOO_LARGE` / `UPLOAD_I18N_KEY_NOT_A_FILE`
// in `src-tauri/src/app_error.rs`. If either side renames the literal,
// the Rust unit test
// `commands::remote_proxy::tests::upload_i18n_keys_have_expected_values`
// fails — that's the CI tripwire keeping the two languages aligned.
export const UPLOAD_I18N_KEY_TOO_LARGE = "errors.upload.tooLarge"
export const UPLOAD_I18N_KEY_NOT_A_FILE = "errors.upload.notAFile"

// Structured error thrown by the upload functions when an attachment
// would be empty (0 bytes). Callers should recognize it and silently
// skip — attaching a zero-byte ResourceLink would be a no-op for the
// agent and a confusing chip in the UI. Modeled as a real `Error`
// subclass so it carries a proper stack trace through async pipelines
// (a bare object literal would lose that), and so existing `instanceof
// Error` catch-rendering in the UI doesn't see an undefined `message`.
//
// The `code` field is preserved for the legacy duck-type check path —
// any callers still inspecting `.code === UPLOAD_ERROR_EMPTY` continue
// to work, but new code should rely on `isEmptyAttachmentError` or
// `instanceof EmptyAttachmentError`.
export const UPLOAD_ERROR_EMPTY = "attachment_empty"

export class EmptyAttachmentError extends Error {
  readonly code = UPLOAD_ERROR_EMPTY
  readonly fileName: string

  constructor(fileName: string) {
    super(`Empty file skipped: ${fileName}`)
    this.name = "EmptyAttachmentError"
    this.fileName = fileName
  }
}

export function isEmptyAttachmentError(err: unknown): boolean {
  if (err instanceof EmptyAttachmentError) return true
  // Tolerate the older bare-object shape so anything thrown through an
  // IPC boundary (which strips the class identity) still gets caught.
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === UPLOAD_ERROR_EMPTY
  )
}

// File tree and git log commands

export async function getFileTree(
  path: string,
  maxDepth?: number
): Promise<FileTreeNode[]> {
  return getTransport().call("get_file_tree", {
    path,
    maxDepth: maxDepth ?? null,
  })
}

/**
 * Flat, gitignore-aware listing of every file/dir under `path`. Ignored
 * directories are pruned during the backend walk (no depth cap), so deeply
 * nested files are reachable while the payload stays small. Used by file search.
 */
export async function listWorkspaceFiles(
  path: string
): Promise<WorkspaceFileEntry[]> {
  return getTransport().call("list_workspace_files", { path })
}

/**
 * Resolve a cleaned pointer selection against the live workspace filesystem
 * (no cached index): returns 0..N matches whose relative path equals the
 * query or ends with `/query`, or a direct stat hit for absolute/`~` refs.
 */
export async function resolveWorkspaceReference(
  root: string,
  text: string
): Promise<WorkspaceReferenceMatch[]> {
  return getTransport().call("resolve_workspace_reference", { root, text })
}

export async function startWorkspaceStateStream(
  rootPath: string,
  wantsTreeGit = true
): Promise<WorkspaceSnapshotResponse> {
  return getTransport().call("start_workspace_state_stream", {
    rootPath,
    wantsTreeGit,
  })
}

export async function stopWorkspaceStateStream(
  rootPath: string,
  wantsTreeGit = true
): Promise<void> {
  return getTransport().call("stop_workspace_state_stream", {
    rootPath,
    wantsTreeGit,
  })
}

export async function getWorkspaceSnapshot(
  rootPath: string,
  sinceSeq?: number
): Promise<WorkspaceSnapshotResponse> {
  return getTransport().call("get_workspace_snapshot", {
    rootPath,
    sinceSeq: sinceSeq ?? null,
  })
}

export async function readFileBase64(
  path: string,
  maxBytes?: number
): Promise<string> {
  return getTransport().call("read_file_base64", {
    path,
    maxBytes: maxBytes ?? null,
  })
}

// Workspace-confined base64 read: `path` is relative to `rootPath` and is
// canonicalized server-side (resolving symlinks), so it can never read outside
// the workspace. Used by the HTML preview to inline local sub-resources safely.
export async function readWorkspaceFileBase64(
  rootPath: string,
  path: string,
  maxBytes?: number
): Promise<string> {
  return getTransport().call("read_workspace_file_base64", {
    rootPath,
    path,
    maxBytes: maxBytes ?? null,
  })
}

export async function readFilePreview(
  rootPath: string,
  path: string
): Promise<FilePreviewContent> {
  return getTransport().call("read_file_preview", { rootPath, path })
}

export async function readFileForEdit(
  rootPath: string,
  path: string
): Promise<FileEditContent> {
  return getTransport().call("read_file_for_edit", { rootPath, path })
}

export async function saveFileContent(
  rootPath: string,
  path: string,
  content: string,
  expectedEtag?: string | null
): Promise<FileSaveResult> {
  return getTransport().call("save_file_content", {
    rootPath,
    path,
    content,
    expectedEtag: expectedEtag ?? null,
  })
}

export async function saveFileCopy(
  rootPath: string,
  path: string,
  content: string
): Promise<FileSaveResult> {
  return getTransport().call("save_file_copy", {
    rootPath,
    path,
    content,
  })
}

export async function renameFileTreeEntry(
  rootPath: string,
  path: string,
  newName: string
): Promise<string> {
  return getTransport().call("rename_file_tree_entry", {
    rootPath,
    path,
    newName,
  })
}

/**
 * Move a file/directory into a different directory of the same workspace,
 * keeping its name. `sourcePath` and `destDir` are workspace-relative
 * (forward slashes); `destDir` is `""` for the workspace root. Resolves to the
 * moved entry's new workspace-relative path.
 */
export async function moveFileTreeEntry(
  rootPath: string,
  sourcePath: string,
  destDir: string
): Promise<string> {
  return getTransport().call("move_file_tree_entry", {
    rootPath,
    sourcePath,
    destDir,
  })
}

export async function deleteFileTreeEntry(
  rootPath: string,
  path: string
): Promise<void> {
  return getTransport().call("delete_file_tree_entry", { rootPath, path })
}

export async function createFileTreeEntry(
  rootPath: string,
  path: string,
  name: string,
  kind: "file" | "dir"
): Promise<string> {
  return getTransport().call("create_file_tree_entry", {
    rootPath,
    path,
    name,
    kind,
  })
}

export async function gitLog(
  path: string,
  limit?: number,
  branch?: string,
  remote?: string,
  skip?: number,
  author?: string,
  allBranches?: boolean,
  withFiles?: boolean
): Promise<GitLogResult> {
  return getTransport().call("git_log", {
    path,
    limit: limit ?? null,
    branch: branch ?? null,
    remote: remote ?? null,
    skip: skip ?? null,
    author: author ?? null,
    allBranches: allBranches ?? null,
    withFiles: withFiles ?? null,
  })
}

export async function gitCurrentUser(path: string): Promise<string | null> {
  return getTransport().call("git_current_user", { path })
}

export async function gitCommitFiles(
  path: string,
  commit: string
): Promise<GitLogFileChange[]> {
  return getTransport().call("git_commit_files", { path, commit })
}

// On-demand author search for the log filter — real repo authors matching
// `query` (case-insensitive, most-active first). Debounced client-side; no
// upfront full-repo scan.
export async function gitSearchAuthors(
  path: string,
  query: string,
  limit?: number
): Promise<string[]> {
  return getTransport().call("git_search_authors", {
    path,
    query,
    limit: limit ?? null,
  })
}

export async function gitCommitBranches(
  path: string,
  commit: string
): Promise<string[]> {
  return getTransport().call("git_commit_branches", { path, commit })
}

export async function gitReset(
  path: string,
  commit: string,
  mode: GitResetMode
): Promise<void> {
  return getTransport().call("git_reset", { path, commit, mode })
}

export async function createTerminalSession(
  request: CreateTerminalSessionRequest
): Promise<TerminalDescriptor> {
  return getTransport().call("terminal_create", {
    terminalId: request.terminalId ?? null,
    cwd: request.cwd,
    shell: request.shell ?? null,
    initialCommand: request.initialCommand ?? null,
    executable: request.executable ?? null,
    args: request.args ?? [],
    env: request.env ?? {},
    agentId: request.agentId ?? null,
    agentModeId: request.agentModeId ?? null,
    agentExtraArgs: request.agentExtraArgs ?? [],
    agentCapabilityValues: request.agentCapabilityValues ?? {},
    agentLaunchInputs: request.agentLaunchInputs ?? null,
    providerId: request.providerId ?? null,
    modelId: request.modelId ?? null,
    folderId: request.folderId ?? null,
    rows: request.rows,
    cols: request.cols,
    clientId: request.clientId ?? null,
  })
}

export async function listTerminalSessions(): Promise<TerminalDescriptor[]> {
  return getTransport().call("terminal_list_sessions")
}

export async function getTerminalSession(
  terminalId: string,
  options?: { tailLines?: number }
): Promise<TerminalDescriptor> {
  return getTransport().call("terminal_get_session", {
    terminalId,
    tailLines: options?.tailLines ?? null,
  })
}

/** 不经 attach 向终端发送一个 tmux 按键名（如 `Escape`、`C-c`）。 */
export async function sendTerminalKey(
  terminalId: string,
  key: string
): Promise<void> {
  return getTransport().call("terminal_send_key", { terminalId, key })
}

/** 不经 attach 向终端输入一行并回车（群组视图「运行命令」）。 */
export async function sendTerminalLine(
  terminalId: string,
  text: string
): Promise<void> {
  return getTransport().call("terminal_send_line", { terminalId, text })
}

export async function terminateTerminalSession(
  terminalId: string
): Promise<void> {
  return getTransport().call("terminal_terminate", { terminalId })
}

export async function removeTerminalRecord(terminalId: string): Promise<void> {
  return getTransport().call("terminal_remove_record", { terminalId })
}

// ---------------------------------------------------------------------------
// Model Providers
// ---------------------------------------------------------------------------

export async function listModelProviders(
  includeSecrets = true
): Promise<ModelProviderInfo[]> {
  return getTransport().call("list_model_providers", { includeSecrets })
}

export async function createModelProvider(params: {
  name: string
  apiUrl: string
  apiKey: string
  agentType?: string
  model?: string | null
  website?: string | null
  agentAllowlist?: string[] | null
  kind?: string | null
  overlays?: { agent_type: string; models: string }[] | null
  discoveryJson?: string | null
}): Promise<ModelProviderInfo> {
  return getTransport().call("create_model_provider", {
    name: params.name,
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
    agentType: params.agentType ?? "",
    model: params.model ?? null,
    website: params.website ?? null,
    agentAllowlist: params.agentAllowlist ?? null,
    kind: params.kind ?? null,
    overlays: params.overlays ?? null,
    discoveryJson: params.discoveryJson ?? null,
  })
}

export async function updateModelProvider(params: {
  id: number
  name?: string | null
  apiUrl?: string | null
  apiKey?: string | null
  agentType?: string | null
  model?: string | null
  website?: string | null
  agentAllowlist?: string[] | null
  overlays?: { agent_type: string; models: string }[] | null
  kind?: string | null
  discoveryJson?: string | null
}): Promise<UpdateModelProviderResult> {
  return getTransport().call("update_model_provider", {
    id: params.id,
    name: params.name ?? null,
    apiUrl: params.apiUrl ?? null,
    apiKey: params.apiKey ?? null,
    agentType: params.agentType ?? null,
    model: params.model ?? null,
    website: params.website ?? null,
    agentAllowlist: params.agentAllowlist ?? null,
    overlays: params.overlays ?? null,
    kind: params.kind ?? null,
    discoveryJson: params.discoveryJson ?? null,
  })
}

export async function deleteModelProvider(id: number): Promise<void> {
  return getTransport().call("delete_model_provider", { id })
}

// ─── Live feedback settings + submit ───────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────
// Backup & restore
// ───────────────────────────────────────────────────────────────────────────

export interface BackupManifestEntry {
  path: string
  size: number
  sha256: string
}

export interface BackupManifest {
  formatVersion: number
  kind: string
  createdAt: string
  appVersion: string
  latestMigration: string
  runtime: string
  includesExternalTranscripts: boolean
  includesSecrets: boolean
  entries: BackupManifestEntry[]
}

export type BackupPhase =
  | "snapshotting"
  | "archiving"
  | "encrypting"
  | "decrypting"
  | "extracting"
  | "verifying"
  | "swapping"
  | "done"
  | "cancelled"
  | "error"

export interface BackupProgress {
  opId: string
  phase: BackupPhase
  processedBytes: number
  totalBytes: number | null
  currentPath?: string | null
  error?: string | null
}

export interface BackupPreview {
  encrypted: boolean
  needsPassphrase: boolean
  manifest?: BackupManifest | null
  compatible: boolean
  rejectReason?: string | null
}

export interface StagedRestore {
  stagingDir: string
  manifest: BackupManifest
  restoredExternalPath?: string | null
  skippedConflicts: string[]
}

/** Where (if anywhere) external agent transcripts are restored. */
export type ExternalRestoreMode =
  | { mode: "skip" }
  | { mode: "side_location" }
  | { mode: "original_locations"; on_conflict: "overwrite" | "skip_existing" }

export interface BackupExportOptions {
  includeExternalTranscripts: boolean
  passphrase?: string | null
}

/**
 * Subscribe to backup/restore progress. Works in both runtimes: the backend
 * emits through the unified event bridge (Tauri webview + WS broadcaster).
 */
export async function listenBackupProgress(
  handler: (event: BackupProgress) => void
): Promise<() => void> {
  return getTransport().subscribe<BackupProgress>("backup://progress", handler)
}

/** Desktop export: native save dialog → write the archive to the chosen path. */
export async function exportBackupDesktop(
  opts: BackupExportOptions
): Promise<BackupManifest | null> {
  const { save } = await import("@tauri-apps/plugin-dialog")
  const encrypted = !!opts.passphrase
  const ext = encrypted ? "berthbak" : "berth.zip"
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
  const destPath = await save({
    defaultPath: `berth-backup-${stamp}.${ext}`,
    filters: [{ name: "Berth backup", extensions: [ext] }],
  })
  if (!destPath) return null
  return getTransport().call<BackupManifest>("backup_create", {
    options: {
      includeExternalTranscripts: opts.includeExternalTranscripts,
      passphrase: opts.passphrase ?? null,
    },
    destPath,
  })
}

/** Validate a backup (desktop: by path). */
export async function inspectBackupDesktop(
  srcPath: string,
  passphrase?: string | null
): Promise<BackupPreview> {
  return getTransport().call<BackupPreview>("backup_inspect", {
    srcPath,
    passphrase: passphrase ?? null,
  })
}

/** Stage a restore (desktop: by path). Applied on next app start. */
export async function stageRestoreDesktop(args: {
  srcPath: string
  passphrase?: string | null
  externalMode?: ExternalRestoreMode | null
}): Promise<StagedRestore> {
  return getTransport().call<StagedRestore>("backup_restore_stage", {
    srcPath: args.srcPath,
    passphrase: args.passphrase ?? null,
    externalMode: args.externalMode ?? null,
  })
}

export interface ExternalConflict {
  agent: string
  archivePath: string
  targetPath: string
  targetSize?: number | null
}

/** Scan a backup for external transcripts whose live target already exists. */
export async function scanExternalConflictsDesktop(
  srcPath: string,
  passphrase?: string | null
): Promise<ExternalConflict[]> {
  return getTransport().call<ExternalConflict[]>(
    "backup_scan_external_conflicts",
    { srcPath, passphrase: passphrase ?? null }
  )
}

// ─── Optional CodeMirror language packs ───

export interface EditorLanguagePackEntry {
  id: string
  version: string
  displayName: string
  extensions: string[]
  languageIds: string[]
  assetUrl: string
  signatureUrl: string
  sha256: string
  size: number
  editorApiVersion: number
  npmPackageName?: string
}

export interface InstalledEditorLanguagePack extends EditorLanguagePackEntry {
  enabled: boolean
  entryPath: string
  source: "catalog" | "npm"
  integrity?: string
}

export interface EditorLanguagePackSnapshot {
  catalog: EditorLanguagePackEntry[]
  installed: InstalledEditorLanguagePack[]
  catalogStatus: "available" | "offline" | "unavailable" | "unconfigured"
  catalogError?: string
  moduleSource?: string
}

export async function editorLanguagePackOperation(
  action:
    | "list"
    | "installed"
    | "install"
    | "update"
    | "uninstall"
    | "enable"
    | "disable"
    | "load"
    | "search-npm"
    | "install-npm"
    | "update-npm",
  packId?: string,
  options?: { query?: string; packageName?: string }
): Promise<EditorLanguagePackSnapshot> {
  return getTransport().call("editor_language_pack_operation", {
    operation: {
      action,
      packId: packId ?? null,
      query: options?.query ?? null,
      packageName: options?.packageName ?? null,
    },
  })
}
