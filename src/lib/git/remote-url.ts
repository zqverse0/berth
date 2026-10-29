/**
 * Git 远程 URL → 可在浏览器打开的 https 地址；无法识别（本地路径、file://）返回 null。
 * 覆盖 scp 风格 `git@host:owner/repo.git`、`ssh://git@host[:port]/owner/repo.git`、
 * `https://[user@]host/owner/repo.git`。
 */
export function remoteWebUrl(url: string): string | null {
  const trimmed = url.trim()
  const scp = trimmed.match(/^[\w.-]+@([\w.-]+):(?!\/\/)(.+)$/)
  const host = scp?.[1]
  const path = scp?.[2]
  if (host && path) return `https://${host}/${stripGit(path)}`
  try {
    const u = new URL(trimmed)
    if (!["https:", "http:", "ssh:", "git:"].includes(u.protocol)) return null
    const scheme = u.protocol === "http:" ? "http" : "https"
    return `${scheme}://${u.hostname}/${stripGit(u.pathname.replace(/^\/+/, ""))}`
  } catch {
    return null
  }
}

function stripGit(path: string): string {
  return path.replace(/\/+$/, "").replace(/\.git$/, "")
}
