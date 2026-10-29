// 脚本环境的 `berth` 全局与 console（docs/plugin-architecture.md §2.4）。
// 宿主注入：__berth_call(method, paramsJson) → '{"result":…}' | '{"error":{"reason","message"}}'，
// __berth_write(fd, text)，__berth_static（JSON：pid、平台、版本、环境变量、storage 目录）。
// 每个方法都只是一条 `<命名空间>.<方法>` 消息的包装，参数一律按名字传，返回 Promise。
;(() => {
  const statics = JSON.parse(__berth_static)
  const failure = (reason, message) =>
    Object.assign(new Error(message), { reason })
  const call = (method, params) => {
    try {
      const reply = JSON.parse(
        __berth_call(method, JSON.stringify(params ?? {}))
      )
      return reply.error
        ? Promise.reject(failure(reply.error.reason, reply.error.message))
        : Promise.resolve(reply.result)
    } catch (error) {
      return Promise.reject(error)
    }
  }
  const text = (values) =>
    values
      .map((value) =>
        typeof value === "string"
          ? value
          : value instanceof Error
            ? value.stack
              ? `${value.message}\n${value.stack}`
              : String(value)
            : JSON.stringify(value)
      )
      .join(" ") + "\n"
  // 页面专属的命名空间：在脚本里调用即 reject `unsupported`，不是 TypeError。
  const unavailable = (namespace) =>
    new Proxy(
      {},
      {
        get: (_, name) =>
          typeof name === "string"
            ? () =>
                Promise.reject(
                  failure(
                    "unsupported",
                    `${namespace}.${name} is not available in scripts`
                  )
                )
            : undefined,
      }
    )

  globalThis.console = Object.freeze({
    log: (...values) => __berth_write(1, text(values)),
    info: (...values) => __berth_write(1, text(values)),
    warn: (...values) => __berth_write(2, text(values)),
    error: (...values) => __berth_write(2, text(values)),
  })

  globalThis.berth = Object.freeze({
    process: Object.freeze({
      run: (cmd, args, options) =>
        call("process.run", { cmd, args, ...options }),
      exec: (cmd, args, options) =>
        call("process.exec", { cmd, args, ...options }),
      open: (cmd, args, options) =>
        call("process.open", { cmd, args, ...options }).then((handle) =>
          Object.freeze({
            write: (text) => call("process.write", { handle, text }),
            readLine: (options) =>
              call("process.readLine", { handle, ...options }),
            close: () => call("process.close", { handle }),
          })
        ),
      which: (cmd) => call("process.which", { cmd }),
      pid: statics.pid,
      alive: (pid) => call("process.alive", { pid }),
      stdin: () => call("process.stdin"),
    }),
    fs: Object.freeze({
      readText: (path, options) => call("fs.readText", { path, ...options }),
      writeText: (path, text, options) =>
        call("fs.writeText", { path, text, ...options }),
      stat: (path) => call("fs.stat", { path }),
      list: (dir) => call("fs.list", { dir }),
      mkdir: (dir, options) => call("fs.mkdir", { dir, ...options }),
      remove: (path) => call("fs.remove", { path }),
      symlink: (target, link) => call("fs.symlink", { target, link }),
      copy: (from, to) => call("fs.copy", { from, to }),
      rename: (from, to) => call("fs.rename", { from, to }),
      resolve: (path) => call("fs.resolve", { path }),
    }),
    storage: Object.freeze({
      get: (key) =>
        call("storage.get", { key }).then((value) => value ?? undefined),
      set: (key, value) => call("storage.set", { key, value }),
      remove: (key) => call("storage.remove", { key }),
      dir: statics.storageDir,
    }),
    env: Object.freeze({
      platform: statics.platform,
      berthVersion: statics.berthVersion,
      vars: Object.freeze(statics.vars),
      project: () => call("env.project"),
    }),
    data: Object.freeze({
      parseToml: (text) => call("data.parseToml", { text }),
      stringifyToml: (value) => call("data.stringifyToml", { value }),
    }),
    files: unavailable("files"),
    tasks: unavailable("tasks"),
    knowledge: unavailable("knowledge"),
    agent: unavailable("agent"),
    scripts: unavailable("scripts"),
    ui: unavailable("ui"),
  })
})()
