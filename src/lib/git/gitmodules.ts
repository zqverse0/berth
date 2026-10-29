function unquoteGitConfigValue(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
  return trimmed
}

/** 只读取 Git 声明的 submodule 路径，不扫描工作区中的 `.git` 目录。 */
export function parseGitmodulePaths(content: string): Set<string> {
  const paths = new Set<string>()
  let inSubmoduleSection = false

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#") || line.startsWith(";")) continue
    if (line.startsWith("[") && line.endsWith("]")) {
      inSubmoduleSection = /^\[submodule\s+".*"\]$/i.test(line)
      continue
    }
    if (!inSubmoduleSection) continue
    const match = /^path\s*=\s*(.+)$/i.exec(line)
    if (!match) continue
    const path = unquoteGitConfigValue(match[1]).replace(/\\/g, "/")
    const normalized = path.replace(/^\.\//, "").replace(/\/$/, "")
    if (normalized && !normalized.startsWith("../") && normalized !== "..") {
      paths.add(normalized)
    }
  }

  return paths
}
