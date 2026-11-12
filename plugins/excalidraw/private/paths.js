// 包内脚本共用：命令行传来的相对路径按调用者的当前目录解析。

export function absolute(path) {
  if (path.startsWith("/") || path.startsWith("~")) return path
  const cwd = berth.env.vars.PWD
  if (!cwd)
    throw new Error(`cannot resolve relative path ${path}: PWD is unset`)
  return `${cwd.replace(/\/+$/, "")}/${path}`
}
