import type {
  EditorReference,
  EditorReferenceTarget,
  PathProjection,
} from "./types"

function normalizePortablePath(path: string): string {
  const slash = path.replace(/\\/g, "/")
  const prefix = slash.match(/^(?:[A-Za-z]:|\/\/[^/]+\/[^/]+|\/)/)?.[0] ?? ""
  const rest = slash.slice(prefix.length)
  const parts: string[] = []
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue
    if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") {
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  const separator = prefix && !prefix.endsWith("/") ? "/" : ""
  return `${prefix}${separator}${parts.join("/")}` || "."
}

function isWithinPath(path: string, root: string): boolean {
  const normalizedPath = normalizePortablePath(path)
  const normalizedRoot = normalizePortablePath(root).replace(/\/+$/, "")
  const insensitive = /^[A-Za-z]:/.test(normalizedRoot)
  const candidate = insensitive ? normalizedPath.toLowerCase() : normalizedPath
  const base = insensitive ? normalizedRoot.toLowerCase() : normalizedRoot
  return candidate === base || candidate.startsWith(`${base}/`)
}

export function projectReferencePath(
  reference: EditorReference,
  target: Extract<
    EditorReferenceTarget,
    { kind: "agent-terminal" | "shell-terminal" }
  >
): PathProjection {
  if (reference.sourceBackendInstanceId !== target.backendInstanceId) {
    return { kind: "unreachable", reason: "backend-mismatch" }
  }
  if (reference.workspacePath) {
    const absolute = normalizePortablePath(reference.absolutePath)
    const workspacePath = normalizePortablePath(reference.workspacePath)
    const suffix = `/${workspacePath}`
    const workspaceRoot = absolute.endsWith(suffix)
      ? absolute.slice(0, -suffix.length)
      : null
    if (
      workspaceRoot &&
      normalizePortablePath(target.cwd).replace(/\/+$/, "") === workspaceRoot
    ) {
      return { kind: "reachable", path: workspacePath, absolute: false }
    }
  }
  if (target.cwd && isWithinPath(reference.absolutePath, target.cwd)) {
    const root = normalizePortablePath(target.cwd).replace(/\/+$/, "")
    const path = normalizePortablePath(reference.absolutePath)
    return {
      kind: "reachable",
      path: path.slice(root.length).replace(/^\/+/, "") || ".",
      absolute: false,
    }
  }
  return {
    kind: "reachable",
    path: normalizePortablePath(reference.absolutePath),
    absolute: true,
  }
}

export function normalizeAbsolutePath(path: string): string {
  return normalizePortablePath(path)
}
