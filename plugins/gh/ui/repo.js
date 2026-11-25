// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// GitHub 仓库可视化页面：展示核心指标、语言分布、目录结构、README、Issues / PR 与 Releases。

const TEXT = {
  "zh-CN": {
    loading: "正在加载仓库信息…",
    retry: "重试",
    missingRepo: "未指定仓库参数。",
    openGithub: "GitHub",
    star: "星标",
    starred: "已星标",
    copyClone: "复制 Clone",
    copied: "已复制 clone 命令",
    sendAgent: "发给 Agent",
    refresh: "刷新",
    stars: "Stars",
    forks: "Forks",
    watchers: "Watchers",
    openIssues: "Open Issues",
    updated: "最近推送",
    tabOverview: "概览",
    tabPulls: "Pull Requests",
    tabIssues: "Issues",
    tabReleases: "Releases",
    files: "根目录文件",
    expandFiles: "展开",
    collapseFiles: "收起",
    readme: "README",
    noReadme: "该仓库没有 README。",
    about: "仓库信息",
    branch: "默认分支",
    license: "协议",
    created: "创建于",
    homepage: "主页",
    archived: "已归档",
    privateRepo: "私有",
    latestReleases: "最近发布",
    prerelease: "预发布",
    noReleases: "暂无 Release。",
    noIssues: "暂无打开的 Issue。",
    noPulls: "暂无打开的 Pull Request。",
    comments: (/** @type {number} */ n) => `${n} 条评论`,
    askAgent: "发给 Agent",
    daysAgo: (/** @type {number} */ n) => `${n} 天前`,
    hoursAgo: (/** @type {number} */ n) => `${n} 小时前`,
    justNow: "刚刚",
  },
  en: {
    loading: "Loading repository…",
    retry: "Retry",
    missingRepo: "Repository parameter is missing.",
    openGithub: "GitHub",
    star: "Star",
    starred: "Starred",
    copyClone: "Copy clone",
    copied: "Copied clone command",
    sendAgent: "Send to Agent",
    refresh: "Refresh",
    stars: "Stars",
    forks: "Forks",
    watchers: "Watchers",
    openIssues: "Open Issues",
    updated: "Last push",
    tabOverview: "Overview",
    tabPulls: "Pull Requests",
    tabIssues: "Issues",
    tabReleases: "Releases",
    files: "Repository files",
    expandFiles: "Expand",
    collapseFiles: "Collapse",
    readme: "README",
    noReadme: "No README found.",
    about: "About",
    branch: "Default branch",
    license: "License",
    created: "Created",
    homepage: "Homepage",
    archived: "Archived",
    privateRepo: "Private",
    latestReleases: "Recent releases",
    prerelease: "Pre-release",
    noReleases: "No releases yet.",
    noIssues: "No open issues.",
    noPulls: "No open pull requests.",
    comments: (/** @type {number} */ n) => `${n} comments`,
    askAgent: "Send to Agent",
    daysAgo: (/** @type {number} */ n) => `${n}d ago`,
    hoursAgo: (/** @type {number} */ n) => `${n}h ago`,
    justNow: "just now",
  },
}

/** 常见语言颜色（与 GitHub 一致，其余按名称哈希取色）。 */
/** @type {Record<string, string>} */
const LANG_COLORS = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Rust: "#dea584",
  Python: "#3572a5",
  Go: "#00add8",
  Java: "#b07219",
  "C++": "#f34b7d",
  C: "#555555",
  "C#": "#178600",
  Swift: "#f05138",
  Kotlin: "#a97bff",
  Ruby: "#701516",
  PHP: "#4f5d95",
  Shell: "#89e051",
  HTML: "#e34c26",
  CSS: "#563d7c",
  Vue: "#41b883",
  Svelte: "#ff3e00",
  Dart: "#00b4ab",
  Zig: "#ec915c",
  Dockerfile: "#384d54",
  Makefile: "#427819",
  Nix: "#7e7eff",
}

/** @param {string} name */
function langColor(name) {
  if (LANG_COLORS[name]) return LANG_COLORS[name]
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  }
  return `hsl(${hash % 360} 58% 52%)`
}

/** @param {number} n */
function compact(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** @param {number} bytes */
function formatSize(bytes) {
  if (!bytes) return ""
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** @param {string} iso @param {typeof TEXT.en} t */
function relativeTime(iso, t) {
  if (!iso) return "—"
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return iso.slice(0, 10)
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 1) return t.justNow
  if (hours < 24) return t.hoursAgo(hours)
  const days = Math.floor(hours / 24)
  if (days < 30) return t.daysAgo(days)
  return iso.slice(0, 10)
}

/**
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {(Node | string | null | false | undefined)[]} [children]
 */
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value)
    } else if (value === true) {
      el.setAttribute(key, "")
    } else if (value !== false && value != null) {
      el.setAttribute(key, String(value))
    }
  }
  for (const child of children) if (child) el.append(child)
  return el
}

/** @param {string} text */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement("textarea")
    area.value = text
    area.readOnly = true
    area.style.position = "fixed"
    area.style.left = "-9999px"
    document.body.append(area)
    try {
      area.select()
      return document.execCommand("copy")
    } finally {
      area.remove()
    }
  }
}

await berth.ready
const t = berth.ui.locale.startsWith("zh") ? TEXT["zh-CN"] : TEXT.en
const ctx = berth.ui.context
const repoParam = ctx.kind === "view" ? ctx.params.repo || "" : ""

const model = {
  /** @type {any} */ data: null,
  /** @type {string | null} */ error: null,
  loading: true,
  starring: false,
  tab: /** @type {"overview" | "pulls" | "issues" | "releases"} */ ("overview"),
  filesExpanded: false,
}

const app = /** @type {HTMLElement} */ (document.getElementById("app"))

async function load() {
  if (!repoParam) {
    model.loading = false
    model.error = t.missingRepo
    render()
    return
  }
  model.loading = true
  model.error = null
  render()
  try {
    model.data = await berth.scripts.run("private/repo-data.js", {
      repo: repoParam,
    })
  } catch (error) {
    model.error = String(error instanceof Error ? error.message : error)
  } finally {
    model.loading = false
    render()
  }
}

async function toggleStar() {
  const repo = model.data?.repo
  if (!repo || repo.starred === null || model.starring) return
  model.starring = true
  render()
  try {
    const nextStar = !repo.starred
    await berth.scripts.run("views/star.js", {
      repo: {
        full_name: repo.fullName,
        description: repo.description,
        stars: repo.stars,
        forks: repo.forks,
        language: repo.language,
      },
      star: nextStar,
    })
    repo.starred = nextStar
    repo.stars = Math.max(0, repo.stars + (nextStar ? 1 : -1))
  } catch (error) {
    await berth.ui.notify(
      String(error instanceof Error ? error.message : error),
      "error"
    )
  } finally {
    model.starring = false
    render()
  }
}

function renderHero(/** @type {any} */ repo) {
  const actions = [
    h(
      "button",
      {
        class: "primary",
        onclick: () => void berth.ui.openUrl(repo.url),
      },
      [t.openGithub]
    ),
  ]
  if (repo.starred !== null) {
    actions.push(
      h(
        "button",
        {
          class: repo.starred ? "starred" : "",
          disabled: model.starring,
          onclick: () => void toggleStar(),
        },
        [repo.starred ? `★ ${t.starred}` : `☆ ${t.star}`]
      )
    )
  }
  actions.push(
    h(
      "button",
      {
        onclick: async () => {
          if (await copyText(`git clone ${repo.cloneUrl}`)) {
            await berth.ui.notify(t.copied, "info")
          }
        },
      },
      [t.copyClone]
    ),
    h(
      "button",
      {
        onclick: () =>
          void berth.agent.attach({
            label: repo.fullName,
            text: `${repo.fullName} (${repo.url})${repo.description ? ` — ${repo.description}` : ""} `,
          }),
      },
      [t.sendAgent]
    ),
    h("button", { onclick: () => void load() }, [t.refresh])
  )

  return h("header", { class: "hero" }, [
    h("div", { class: "hero-main" }, [
      repo.avatar
        ? h("img", { class: "avatar", src: repo.avatar, alt: repo.owner })
        : null,
      h("div", {}, [
        h("div", { class: "title-row" }, [
          h("h1", { class: "repo-title" }, [
            h("span", { class: "repo-owner" }, [`${repo.owner} / `]),
            repo.name,
          ]),
          repo.isPrivate
            ? h("span", { class: "badge" }, [t.privateRepo])
            : null,
          repo.archived
            ? h("span", { class: "badge warn" }, [t.archived])
            : null,
          repo.license ? h("span", { class: "badge" }, [repo.license]) : null,
        ]),
        repo.description ? h("p", { class: "desc" }, [repo.description]) : null,
        repo.homepage
          ? h("div", { class: "meta-links" }, [
              h(
                "a",
                {
                  href: repo.homepage,
                  onclick: (/** @type {MouseEvent} */ e) => {
                    e.preventDefault()
                    void berth.ui.openUrl(repo.homepage)
                  },
                },
                [repo.homepage]
              ),
            ])
          : null,
        repo.topics?.length
          ? h(
              "div",
              { class: "topics" },
              repo.topics.map((/** @type {string} */ topic) =>
                h("span", { class: "topic" }, [topic])
              )
            )
          : null,
      ]),
    ]),
    h("div", { class: "actions" }, actions),
  ])
}

function renderStats(/** @type {any} */ repo) {
  const items = [
    [compact(repo.stars), t.stars],
    [compact(repo.forks), t.forks],
    [compact(repo.watchers), t.watchers],
    [compact(repo.openIssues), t.openIssues],
    [relativeTime(repo.pushedAt, t), t.updated],
  ]
  return h(
    "section",
    { class: "stats" },
    items.map(([val, label]) =>
      h("div", { class: "stat" }, [
        h("div", { class: "stat-value" }, [val]),
        h("div", { class: "stat-label" }, [label]),
      ])
    )
  )
}

function renderLanguages(/** @type {any[]} */ languages) {
  if (!languages.length) return null
  const top = languages.slice(0, 8)
  return h("section", { class: "lang-block" }, [
    h(
      "div",
      { class: "lang-bar" },
      top.map((lang) =>
        h("span", {
          class: "lang-seg",
          title: `${lang.name} ${lang.percent.toFixed(1)}%`,
          style: `width:${lang.percent.toFixed(2)}%;background:${langColor(lang.name)}`,
        })
      )
    ),
    h(
      "div",
      { class: "lang-legend" },
      top.map((lang) =>
        h("span", { class: "lang-item" }, [
          h("span", {
            class: "lang-dot",
            style: `background:${langColor(lang.name)}`,
          }),
          h("span", {}, [lang.name]),
          h("span", { class: "lang-pct" }, [`${lang.percent.toFixed(1)}%`]),
        ])
      )
    ),
  ])
}

function renderTabs(/** @type {any} */ data) {
  /** @type {Array<["overview" | "pulls" | "issues" | "releases", string, number | null]>} */
  const items = [
    ["overview", t.tabOverview, null],
    ["pulls", t.tabPulls, data.pulls.length],
    ["issues", t.tabIssues, data.issues.length],
    ["releases", t.tabReleases, data.releases.length],
  ]
  return h(
    "nav",
    { class: "tabs" },
    items.map(([id, label, count]) =>
      h(
        "button",
        {
          class: "tab-btn",
          "aria-selected": String(model.tab === id),
          onclick: () => {
            model.tab = id
            render()
          },
        },
        [
          label,
          count != null
            ? h("span", { class: "tab-count" }, [String(count)])
            : null,
        ]
      )
    )
  )
}

function renderReadme(/** @type {string | null} */ html) {
  const container = h("div", { class: "readme" })
  if (!html) {
    container.append(h("p", { class: "muted" }, [t.noReadme]))
    return container
  }
  container.innerHTML = html
  container.addEventListener("click", (event) => {
    const link = /** @type {HTMLElement | null} */ (event.target)?.closest("a")
    if (!link) return
    const href = link.getAttribute("href") || ""
    if (/^https?:\/\//i.test(href)) {
      event.preventDefault()
      void berth.ui.openUrl(href)
    }
  })
  return container
}

function renderOverview(/** @type {any} */ data) {
  const files = data.files || []
  const shownFiles = model.filesExpanded ? files : files.slice(0, 12)
  const mainCol = h("div", {}, [
    files.length
      ? h("section", { class: "panel-section" }, [
          h("div", { class: "section-header" }, [
            h("span", {}, [`${t.files} (${files.length})`]),
            files.length > 12
              ? h(
                  "button",
                  {
                    onclick: () => {
                      model.filesExpanded = !model.filesExpanded
                      render()
                    },
                  },
                  [model.filesExpanded ? t.collapseFiles : t.expandFiles]
                )
              : null,
          ]),
          h(
            "ul",
            { class: "file-list" },
            shownFiles.map((/** @type {any} */ f) =>
              h("li", { class: "file-row" }, [
                h(
                  "a",
                  {
                    class: "file-name",
                    href: f.url,
                    onclick: (/** @type {MouseEvent} */ e) => {
                      e.preventDefault()
                      if (f.url) void berth.ui.openUrl(f.url)
                    },
                  },
                  [f.type === "dir" ? "📁" : "📄", f.name]
                ),
                h("span", { class: "file-size" }, [
                  f.type === "file" ? formatSize(f.size) : "",
                ]),
              ])
            )
          ),
        ])
      : null,
    h("section", { class: "panel-section" }, [
      h("div", { class: "section-header" }, [t.readme]),
      renderReadme(data.readmeHtml),
    ]),
  ])

  const repo = data.repo
  const sideCol = h("aside", {}, [
    h("section", { class: "panel-section" }, [
      h("div", { class: "section-header" }, [t.about]),
      h("dl", { class: "info-dl" }, [
        h("div", { class: "info-row" }, [
          h("dt", {}, [t.branch]),
          h("dd", {}, [repo.defaultBranch]),
        ]),
        repo.license
          ? h("div", { class: "info-row" }, [
              h("dt", {}, [t.license]),
              h("dd", {}, [repo.license]),
            ])
          : null,
        h("div", { class: "info-row" }, [
          h("dt", {}, [t.created]),
          h("dd", {}, [repo.createdAt ? repo.createdAt.slice(0, 10) : "—"]),
        ]),
      ]),
    ]),
    h("section", { class: "panel-section" }, [
      h("div", { class: "section-header" }, [t.latestReleases]),
      data.releases.length
        ? h(
            "ul",
            { class: "item-list" },
            data.releases.slice(0, 4).map((/** @type {any} */ rel) =>
              h("li", { class: "item-row" }, [
                h("div", { class: "item-main" }, [
                  h(
                    "a",
                    {
                      class: "item-title",
                      href: rel.url,
                      onclick: (/** @type {MouseEvent} */ e) => {
                        e.preventDefault()
                        void berth.ui.openUrl(rel.url)
                      },
                    },
                    [rel.tag]
                  ),
                  h("div", { class: "item-meta" }, [
                    relativeTime(rel.publishedAt, t),
                    rel.prerelease
                      ? h("span", { class: "badge warn" }, [t.prerelease])
                      : null,
                  ]),
                ]),
              ])
            )
          )
        : h("div", { class: "item-row muted" }, [t.noReleases]),
    ]),
  ])

  return h("div", { class: "overview-grid" }, [mainCol, sideCol])
}

function renderIssueList(
  /** @type {any[]} */ items,
  /** @type {string} */ emptyText,
  /** @type {string} */ repoFullName
) {
  if (!items.length) return h("p", { class: "state" }, [emptyText])
  return h("section", { class: "panel-section" }, [
    h(
      "ul",
      { class: "item-list" },
      items.map((item) =>
        h("li", { class: "item-row" }, [
          h("div", { class: "item-main" }, [
            h(
              "a",
              {
                class: "item-title",
                href: item.url,
                onclick: (/** @type {MouseEvent} */ e) => {
                  e.preventDefault()
                  void berth.ui.openUrl(item.url)
                },
              },
              [`#${item.number} ${item.title}`]
            ),
            h("div", { class: "item-meta" }, [
              item.author ? `@${item.author}` : null,
              relativeTime(item.updatedAt, t),
              item.comments > 0 ? t.comments(item.comments) : null,
              ...item.labels.slice(0, 4).map((/** @type {any} */ l) =>
                h(
                  "span",
                  {
                    class: "label-pill",
                    style: l.color ? `border-color:#${l.color}` : undefined,
                  },
                  [l.name]
                )
              ),
            ]),
          ]),
          h(
            "button",
            {
              onclick: () =>
                void berth.agent.attach({
                  label: `${repoFullName}#${item.number}`,
                  text: `${repoFullName}#${item.number} (${item.url}) — ${item.title} `,
                }),
            },
            [t.askAgent]
          ),
        ])
      )
    ),
  ])
}

function renderReleases(/** @type {any[]} */ releases) {
  if (!releases.length) return h("p", { class: "state" }, [t.noReleases])
  return h("section", { class: "panel-section" }, [
    h(
      "ul",
      { class: "item-list" },
      releases.map((rel) =>
        h("li", { class: "item-row" }, [
          h("div", { class: "item-main" }, [
            h(
              "a",
              {
                class: "item-title",
                href: rel.url,
                onclick: (/** @type {MouseEvent} */ e) => {
                  e.preventDefault()
                  void berth.ui.openUrl(rel.url)
                },
              },
              [rel.name !== rel.tag ? `${rel.tag} — ${rel.name}` : rel.tag]
            ),
            h("div", { class: "item-meta" }, [
              relativeTime(rel.publishedAt, t),
              rel.prerelease
                ? h("span", { class: "badge warn" }, [t.prerelease])
                : null,
            ]),
            rel.body ? h("p", { class: "release-body" }, [rel.body]) : null,
          ]),
        ])
      )
    ),
  ])
}

function render() {
  if (model.loading) {
    app.replaceChildren(h("p", { class: "state" }, [t.loading]))
    return
  }
  if (model.error || !model.data) {
    app.replaceChildren(
      h("div", { class: "state error" }, [
        h("p", {}, [model.error || t.missingRepo]),
        h("button", { onclick: () => void load() }, [t.retry]),
      ])
    )
    return
  }
  const data = model.data
  const body =
    model.tab === "overview"
      ? renderOverview(data)
      : model.tab === "pulls"
        ? renderIssueList(data.pulls, t.noPulls, data.repo.fullName)
        : model.tab === "issues"
          ? renderIssueList(data.issues, t.noIssues, data.repo.fullName)
          : renderReleases(data.releases)

  app.replaceChildren(
    renderHero(data.repo),
    renderStats(data.repo),
    renderLanguages(data.languages),
    renderTabs(data),
    body
  )
}

void load()
