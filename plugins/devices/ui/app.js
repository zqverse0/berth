// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// 「设备」侧栏面板：选一台设备看概览与检查清单、挑哪些对方项目显示在侧栏、在对方建项目、开 SSH 终端、
// 配置免密、移除；顶部「＋」添加设备。本机也是一台设备（id 0）：看概览与项目、添加项目、开终端。
// 连接与对方项目 / 终端并入本机由宿主负责（berth.devices）。

const TEXT = {
  "zh-CN": {
    empty: "还没有设备。点右上角「＋」添加一台 SSH 能连上的机器。",
    add: "添加设备",
    addHint:
      "填一个 SSH 能连上的目标。Berth 只记名称和目标；端口、密钥、跳板机写在 ~/.ssh/config。",
    target: "SSH 目标",
    name: "名称（留空则用 SSH 目标）",
    adding: "连接测试中…",
    confirm: "添加",
    cancel: "取消",
    status: { checking: "检测中", online: "在线", offline: "连不上" },
    needsKey: "需配置免密",
    recheck: "重新检测",
    overview: "概览",
    system: "系统",
    berth: "对方 Berth",
    version: "版本",
    versions: (/** @type {string} */ l, /** @type {string} */ r) =>
      `本机 ${l} · 对方 ${r}`,
    checklist: "检查清单",
    steps: {
      ssh: "SSH 连接",
      key: "免密登录",
      berth: "Berth 路径",
      version: "版本",
      host: "宿主运行",
    },
    checks: {
      keyMissing: "需要密码登录：用下方「配置免密登录」装上本机公钥",
      berthMissing: "对方没有装 Berth，只能开 SSH 终端",
      versionUnknown: "对方 Berth 版本过旧，不报版本",
      versionMismatch: (/** @type {Record<string, string>} */ v) =>
        `版本不一致：本机 ${v.local}，对方 ${v.remote}`,
      berthOutdated: "对方 Berth 版本过旧，升级后才能使用它的项目",
      windowUnavailable: "对方 Berth 没在运行，打开后自动连上",
    },
    projects: "项目",
    shownHint: "勾选的项目显示在侧栏；对方新建的项目不会自动出现。",
    noProjects: "对方还没有项目",
    noCache: "还没读到对方的项目",
    members: (/** @type {number} */ n) => `${n} 个成员`,
    addProject: "在对方新建项目",
    addLocalProject: "添加项目",
    localTerminal: "打开终端",
    up: "上一级",
    addHere: "在此建项目",
    noDirs: "没有子目录",
    actions: "操作",
    terminal: "打开 SSH 终端",
    setupKey: "配置免密登录",
    keyStarted:
      "已在终端里运行 ssh-copy-id：确认指纹并输入一次密码，完成后点「重新检测」",
    remove: "移除设备",
    removeConfirm: "确认移除（对方的项目与终端不受影响）",
    errors: {
      "device.nameRequired": "请填写名称",
      "device.nameTaken": "已有同名设备",
      "device.targetInvalid":
        "SSH 目标无效：不能为空、不能含空格、不能以 - 开头",
      "device.timeout": "连接超时（10 秒），请确认设备在线、网络可达",
    },
  },
  en: {
    empty: "No devices yet. Use “+” at the top to add a machine SSH can reach.",
    add: "Add device",
    addHint:
      "Enter an SSH target Berth can reach. Berth only stores the name and target; ports, keys and jump hosts belong in ~/.ssh/config.",
    target: "SSH target",
    name: "Name (defaults to the SSH target)",
    adding: "Testing connection…",
    confirm: "Add",
    cancel: "Cancel",
    status: { checking: "Checking", online: "Online", offline: "Unreachable" },
    needsKey: "Needs key setup",
    recheck: "Check again",
    overview: "Overview",
    system: "System",
    berth: "Berth there",
    version: "Version",
    versions: (/** @type {string} */ l, /** @type {string} */ r) =>
      `Here ${l} · there ${r}`,
    checklist: "Checklist",
    steps: {
      ssh: "SSH connection",
      key: "Key login",
      berth: "Berth path",
      version: "Version",
      host: "Host running",
    },
    checks: {
      keyMissing:
        "Password login only: use “Set up key login” below to install this machine's public key",
      berthMissing: "Berth is not installed there; only SSH terminals work",
      versionUnknown: "Berth there is too old to report its version",
      versionMismatch: (/** @type {Record<string, string>} */ v) =>
        `Versions differ: ${v.local} here, ${v.remote} there`,
      berthOutdated: "Berth there is too old; upgrade it to use its projects",
      windowUnavailable: "Berth is not running there; it connects once opened",
    },
    projects: "Projects",
    shownHint:
      "Checked projects appear in the sidebar; new projects on the device don't show up automatically.",
    noProjects: "No projects there yet",
    noCache: "Projects not loaded yet",
    members: (/** @type {number} */ n) =>
      n === 1 ? "1 member" : `${n} members`,
    addProject: "New project on the device",
    addLocalProject: "Add project",
    localTerminal: "Open terminal",
    up: "Up",
    addHere: "Create project here",
    noDirs: "No subdirectories",
    actions: "Actions",
    terminal: "Open SSH terminal",
    setupKey: "Set up key login",
    keyStarted:
      "Running ssh-copy-id in a terminal: confirm the host key and enter the password once, then “Check again”",
    remove: "Remove device",
    removeConfirm: "Confirm removal (nothing changes on the device)",
    errors: {
      "device.nameRequired": "Enter a name",
      "device.nameTaken": "A device with this name already exists",
      "device.targetInvalid":
        "Invalid SSH target: must be non-empty, contain no spaces and not start with -",
      "device.timeout":
        "Connection timed out (10s). Check that the device is online and reachable",
    },
  },
}

import { deviceChecklist, needsKeySetup } from "./checklist.js"

await berth.ready
const t = berth.ui.locale.startsWith("zh") ? TEXT["zh-CN"] : TEXT.en
const api = berth.devices

/** @param {unknown} error */
const message = (error) => {
  const text = error instanceof Error ? error.message : String(error)
  return /** @type {Record<string, string>} */ (t.errors)[text] ?? text
}

/**
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {(Node | string | null | false)[]} [children]
 */
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value)
    else if (key === "checked" || key === "value")
      /** @type {any} */ (el)[key] = value
    else if (value === true) el.setAttribute(key, "")
    else if (value !== false && value != null) el.setAttribute(key, value)
  }
  for (const child of children) if (child) el.append(child)
  return el
}

/** 页面的全部状态。 */
const model = {
  /** @type {import("berth").DeviceInfo[]} */ devices: [],
  /** @type {number | null} */ selected: null,
  /** 选中设备的检测结果。 @type {Awaited<ReturnType<typeof api.inspect>> | null} */
  inspect: null,
  inspecting: false,
  /** @type {{ target: string, name: string, saving: boolean, error: string | null, candidates: string[] } | null} */
  adding: null,
  /** 在对方建项目时的目录浏览。 @type {{ path: string, dirs: string[], error: string | null } | null} */
  browse: null,
  removing: false,
  /** @type {string | null} */ error: null,
}

const current = () =>
  model.devices.find((device) => device.id === model.selected) ?? null

async function loadDevices(force = false) {
  const { devices, selected } = await api.list()
  // 状态推送很频繁：没变就不重画（重画会打断正在输入的表单）
  if (!force && JSON.stringify(devices) === JSON.stringify(model.devices))
    return
  model.devices = devices
  // 宿主要求的选中只在打开时用一次；之后的请求经 onSelect 到达
  if (
    force &&
    selected != null &&
    devices.some((device) => device.id === selected)
  )
    select(selected, false)
  else if (!current()) select(devices[0]?.id ?? null, false)
  render()
}

/** @param {number | null} id @param {boolean} [draw] */
function select(id, draw = true) {
  if (id === model.selected) return draw && render()
  model.selected = id
  model.inspect = null
  model.browse = null
  model.removing = false
  model.error = null
  if (id != null) void inspect()
  if (draw) render()
}

async function inspect() {
  const id = model.selected
  if (id == null) return
  model.inspecting = true
  render()
  try {
    const result = await api.inspect(id)
    if (id === model.selected) model.inspect = result
  } catch (error) {
    if (id === model.selected) model.error = message(error)
  } finally {
    if (id === model.selected) model.inspecting = false
    render()
  }
}

/** 运行一个操作，失败显示原因。 @param {() => Promise<unknown>} action */
async function run(action) {
  model.error = null
  try {
    await action()
  } catch (error) {
    model.error = message(error)
  }
  render()
}

async function openAdd() {
  model.adding = {
    target: "",
    name: "",
    saving: false,
    error: null,
    candidates: [],
  }
  render()
  const candidates = await api.candidates().catch(() => [])
  if (model.adding) model.adding.candidates = candidates
  render()
}

async function saveAdd() {
  const form = model.adding
  const target = form?.target.trim()
  if (!form || !target || form.saving) return
  form.saving = true
  form.error = null
  render()
  try {
    const { id } = await api.add(form.name.trim() || target, target)
    model.adding = null
    await loadDevices()
    select(id)
  } catch (error) {
    form.saving = false
    form.error = message(error)
    render()
  }
}

/** @param {string} path */
async function browse(path) {
  const id = model.selected
  if (id == null) return
  try {
    const listed = await api.dirs(id, path)
    model.browse = { ...listed, error: null }
  } catch (error) {
    model.browse = { path, dirs: [], error: message(error) }
  }
  render()
}

/** @param {string} path */
const parentOf = (path) =>
  path === "/" ? null : path.replace(/\/[^/]+\/?$/, "") || "/"

function renderAdd() {
  const form = model.adding
  if (!form) return null
  return h(
    "form",
    {
      class: "form",
      onsubmit: (/** @type {Event} */ e) => (
        e.preventDefault(),
        void saveAdd()
      ),
    },
    [
      h("div", { class: "small muted" }, [t.addHint]),
      h("input", {
        list: "device-candidates",
        placeholder: `${t.target}（user@100.64.0.6）`,
        value: form.target,
        autofocus: true,
        oninput: (/** @type {any} */ e) => (form.target = e.target.value),
      }),
      h(
        "datalist",
        { id: "device-candidates" },
        form.candidates.map((host) => h("option", { value: host }))
      ),
      h("input", {
        placeholder: t.name,
        value: form.name,
        oninput: (/** @type {any} */ e) => (form.name = e.target.value),
      }),
      form.error ? h("div", { class: "error small" }, [form.error]) : null,
      form.error && needsKeySetup(form.error)
        ? h(
            "button",
            {
              type: "button",
              class: "outline",
              onclick: () =>
                void run(async () => {
                  await api.setupKey(form.target.trim())
                  berth.ui.notify(t.keyStarted)
                }),
            },
            [t.setupKey]
          )
        : null,
      h("div", { class: "row" }, [
        h("span", { class: "grow" }),
        h(
          "button",
          { type: "button", onclick: () => ((model.adding = null), render()) },
          [t.cancel]
        ),
        h(
          "button",
          {
            type: "submit",
            class: "outline",
            disabled: form.saving || !form.target.trim(),
          },
          [form.saving ? t.adding : t.confirm]
        ),
      ]),
    ]
  )
}

/** @param {import("berth").DeviceInfo} device */
function renderDevice(device) {
  const result = model.inspect
  const overview = result?.overview ?? null
  /** @type {(Node | null | false)[]} */
  const parts = []

  parts.push(
    h("div", { class: "row", style: "margin-top:10px" }, [
      h("span", { class: "dot", "data-state": device.status }),
      h("span", { class: "grow truncate" }, [
        device.keyMissing ? t.needsKey : t.status[device.status],
      ]),
      h(
        "button",
        {
          class: "outline",
          disabled: model.inspecting,
          onclick: () => void inspect(),
        },
        [t.recheck]
      ),
    ])
  )
  if (model.error) parts.push(h("div", { class: "error small" }, [model.error]))

  parts.push(
    h("section", {}, [
      h("h2", {}, [t.overview]),
      h("dl", {}, [
        device.local ? null : h("dt", {}, [t.target]),
        device.local
          ? null
          : h("dd", { title: device.target }, [device.target]),
        h("dt", {}, [t.system]),
        h("dd", {}, [
          overview
            ? [overview.host, overview.os, overview.arch]
                .filter(Boolean)
                .join(" · ")
            : "—",
        ]),
        device.local ? null : h("dt", {}, [t.berth]),
        device.local
          ? null
          : h("dd", { title: result?.berth ?? "" }, [result?.berth ?? "—"]),
        h("dt", {}, [t.version]),
        h("dd", {}, [
          device.local
            ? (result?.localVersion ?? "—")
            : t.versions(result?.localVersion ?? "—", overview?.version ?? "—"),
        ]),
      ]),
    ])
  )

  if (!device.local)
    parts.push(
      h("section", {}, [
        h("h2", {}, [t.checklist]),
        h(
          "ul",
          {},
          (result
            ? deviceChecklist(result)
            : deviceChecklist({
                check: null,
                berth: null,
                overview: null,
                localVersion: null,
                line: null,
              })
          ).map((item) => {
            const reason = item.reason
              ? /** @type {Record<string, any>} */ (t.checks)[item.reason.key]
              : null
            const why =
              typeof reason === "function"
                ? reason(item.reason?.values ?? {})
                : (reason ??
                  (item.state === "fail" ? message(item.raw ?? "") : null))
            return h("li", { class: "check", "data-state": item.state }, [
              h("span", { class: "mark" }, [
                { ok: "✓", fail: "✕", pending: "…", skipped: "–" }[item.state],
              ]),
              h("span", {}, [t.steps[item.id]]),
              h("span", {}, []),
              why ? h("span", { class: "why" }, [why]) : null,
            ])
          })
        ),
        model.inspecting && !result
          ? h("div", { class: "muted small" }, [t.status.checking])
          : null,
      ])
    )

  if (device.node) {
    const mains = (overview?.projects ?? []).filter(
      (project) =>
        !project.project || project.project.main_folder_id === project.id
    )
    parts.push(
      h("section", {}, [
        h("h2", {}, [t.projects]),
        device.local ? null : h("div", { class: "small muted" }, [t.shownHint]),
        h(
          "ul",
          {},
          mains.map((project) => {
            const members = (overview?.projects ?? []).filter(
              (item) => (item.project?.main_folder_id ?? item.id) === project.id
            ).length
            return h("li", {}, [
              h("label", { class: "row project", title: project.path }, [
                device.local
                  ? null
                  : h("input", {
                      type: "checkbox",
                      checked: device.shown.includes(project.path),
                      onchange: (/** @type {any} */ e) =>
                        void run(() =>
                          api.show(device.id, project.path, e.target.checked)
                        ),
                    }),
                h("span", { class: "grow truncate" }, [
                  project.project?.name ?? project.name,
                ]),
                members > 1
                  ? h("span", { class: "small muted" }, [t.members(members)])
                  : null,
              ]),
            ])
          })
        ),
        mains.length === 0
          ? h("div", { class: "small muted" }, [
              overview ? t.noProjects : t.noCache,
            ])
          : null,
        device.local
          ? h(
              "button",
              {
                class: "outline",
                style: "margin-top:6px",
                onclick: () =>
                  void run(async () => {
                    const added = await api.addProject(0)
                    if (added) {
                      berth.ui.notify(added.name)
                      await inspect()
                    }
                  }),
              },
              [`＋ ${t.addLocalProject}`]
            )
          : model.browse
            ? renderBrowse(device)
            : h(
                "button",
                {
                  class: "outline",
                  style: "margin-top:6px",
                  disabled: device.status !== "online",
                  onclick: () => void browse(""),
                },
                [`＋ ${t.addProject}`]
              ),
      ])
    )
  }

  parts.push(
    h("section", {}, [
      h("h2", {}, [t.actions]),
      h("div", { class: "actions" }, [
        h(
          "button",
          {
            class: "outline",
            onclick: () => void run(() => api.openTerminal(device.id)),
          },
          [device.local ? t.localTerminal : t.terminal]
        ),
        device.local
          ? null
          : h(
              "button",
              {
                class: "outline",
                onclick: () =>
                  void run(async () => {
                    await api.setupKey(device.id)
                    berth.ui.notify(t.keyStarted)
                  }),
              },
              [t.setupKey]
            ),
        device.local
          ? null
          : model.removing
            ? h(
                "button",
                {
                  class: "outline danger",
                  onclick: () =>
                    void run(async () => {
                      await api.remove(device.id)
                      model.removing = false
                    }),
                },
                [t.removeConfirm]
              )
            : h(
                "button",
                {
                  class: "danger",
                  onclick: () => ((model.removing = true), render()),
                },
                [t.remove]
              ),
      ]),
    ])
  )
  return parts
}

/** @param {import("berth").DeviceInfo} device */
function renderBrowse(device) {
  const state = model.browse
  if (!state) return null
  const parent = parentOf(state.path)
  return h("div", { class: "form" }, [
    h("div", { class: "small truncate", title: state.path }, [
      state.path || "~",
    ]),
    state.error ? h("div", { class: "error small" }, [state.error]) : null,
    h("ul", { class: "dirs" }, [
      parent
        ? h("li", {}, [
            h("button", { onclick: () => void browse(parent) }, [`↑ ${t.up}`]),
          ])
        : null,
      ...state.dirs.map((dir) =>
        h("li", {}, [
          h(
            "button",
            {
              onclick: () =>
                void browse(`${state.path.replace(/\/$/, "")}/${dir}`),
            },
            [`📁 ${dir}`]
          ),
        ])
      ),
      state.dirs.length === 0
        ? h("li", { class: "small muted" }, [t.noDirs])
        : null,
    ]),
    h("div", { class: "row" }, [
      h("span", { class: "grow" }),
      h("button", { onclick: () => ((model.browse = null), render()) }, [
        t.cancel,
      ]),
      h(
        "button",
        {
          class: "outline",
          disabled: !state.path,
          onclick: () =>
            void run(async () => {
              const added = await api.addProject(device.id, state.path)
              model.browse = null
              // 新项目直接显示在侧栏：在对方建项目就是为了在这里用
              await api.show(device.id, state.path, true)
              berth.ui.notify(added.name)
            }),
        },
        [t.addHere]
      ),
    ]),
  ])
}

function render() {
  const app = /** @type {HTMLElement} */ (document.getElementById("app"))
  const device = current()
  const head = h("div", { class: "row" }, [
    model.devices.length
      ? h(
          "select",
          {
            class: "grow",
            onchange: (/** @type {any} */ e) => select(Number(e.target.value)),
          },
          model.devices.map((item) =>
            h(
              "option",
              { value: String(item.id), selected: item.id === model.selected },
              [`${item.status === "online" ? "● " : "○ "}${item.name}`]
            )
          )
        )
      : h("span", { class: "grow" }),
    h(
      "button",
      { title: t.add, "aria-label": t.add, onclick: () => void openAdd() },
      ["＋"]
    ),
  ])
  app.replaceChildren(
    head,
    ...[renderAdd()].filter((node) => node != null),
    ...(device
      ? renderDevice(device).filter((node) => node instanceof Node)
      : model.adding
        ? []
        : [h("div", { class: "muted", style: "padding:16px 4px" }, [t.empty])])
  )
}

api.onChange(() => void loadDevices())
api.onSelect((id) => select(id))
await loadDevices(true)
