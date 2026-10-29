use std::collections::{hash_map::DefaultHasher, BTreeMap, HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::Path;

use chrono::Utc;

use super::model::*;
use super::parser::{parse_markdown, split_frontmatter};

pub(super) const VAULT_DIR: &str = ".berth/knowledge";
const MAX_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_DOCUMENTS: usize = 5_000;
/// 根目录下没写 type 的笔记的类型。
const UNSORTED: &str = "未分类";
const STATUSES: [&str; 3] = ["草稿", "已确认", "已取代"];
const TYPES: [&str; 6] = ["地图", "概念", "模块", "决策", "经验", "来源"];
const SOURCE_KINDS: [&str; 5] = ["repo", "article", "paper", "video", "other"];
const HOME_NOTE: &str = "地图/首页.md";
/// 正文超过这么多行算「太长」，只提醒。
const LONG_NOTE_LINES: usize = 60;
/// 只提醒、不算错误的诊断。
const WARNING_KINDS: [&str; 2] = ["size_limit", "too_long"];

/// 扫描结果：对外的笔记 + 去掉 frontmatter 的正文。
struct Vault {
    documents: Vec<KnowledgeDocument>,
    bodies: Vec<String>,
    edges: Vec<KnowledgeEdge>,
    diagnostics: Vec<KnowledgeDiagnostic>,
}

// ponytail: 每次调用都重扫 vault（无缓存）；500 篇超过 300ms 时再加按 mtime 的缓存
pub fn snapshot(project_root: &Path) -> io::Result<KnowledgeSnapshot> {
    let vault = scan(project_root)?;
    let mut hasher = DefaultHasher::new();
    for document in &vault.documents {
        document.path.hash(&mut hasher);
        document.modified_at.hash(&mut hasher);
    }
    Ok(KnowledgeSnapshot {
        root: project_root.display().to_string(),
        revision: format!("{}:{:016x}", vault.documents.len(), hasher.finish()),
        generated_at: Utc::now().to_rfc3339(),
        documents: vault.documents,
        edges: vault.edges,
        diagnostics: vault.diagnostics,
    })
}

/// 标题、别名、标签、正文全文；空格分词，全部命中。
pub fn search(project_root: &Path, request: SearchRequest) -> io::Result<SearchResult> {
    let words = query_words(&request.query)?;
    let vault = scan(project_root)?;
    let documents = vault
        .documents
        .into_iter()
        .zip(vault.bodies)
        .filter(|(document, body)| matches(document, &body.to_lowercase(), &words))
        .map(|(document, _)| document)
        .take(request.limit.clamp(1, 200))
        .collect();
    Ok(SearchResult {
        query: words.join(" "),
        documents,
    })
}

/// Agent 检索（`berth knowledge search`）：命中规则同 `search`，标题 / 别名命中的排前面；
/// `note_type` 只看这一类。
pub fn find(
    project_root: &Path,
    query: &str,
    note_type: Option<&str>,
    limit: usize,
) -> io::Result<Vec<SearchHit>> {
    let words = query_words(query)?;
    let vault = scan(project_root)?;
    let mut hits = vault
        .documents
        .into_iter()
        .zip(vault.bodies)
        .filter(|(document, _)| note_type.is_none_or(|kind| document.note_type == kind))
        .filter_map(|(document, body)| {
            if !matches(&document, &body.to_lowercase(), &words) {
                return None;
            }
            let names = names(&document);
            let named = words.iter().any(|word| names.contains(word.as_str()));
            Some((
                !named,
                SearchHit {
                    snippet: snippet(&body, &words),
                    title: document.title,
                    note_type: document.note_type,
                    status: document.status,
                    excerpt: document.excerpt,
                },
            ))
        })
        .collect::<Vec<_>>();
    hits.sort_by_key(|(rank, _)| *rank);
    Ok(hits
        .into_iter()
        .map(|(_, hit)| hit)
        .take(limit.max(1))
        .collect())
}

/// 与仓库相对路径 `path` 相关的笔记（`berth knowledge for`）：`code` 覆盖它（同前端 `codeMentions`），
/// 或 `path` 是目录且 `code` 在它里面；不含已取代的。模块排前面。
pub fn covering(project_root: &Path, path: &str) -> io::Result<Vec<SearchHit>> {
    let path = path.trim().trim_start_matches("./").trim_end_matches('/');
    if path.is_empty() {
        return Err(invalid("path is required"));
    }
    let inside =
        |child: &str, parent: &str| child == parent || child.starts_with(&format!("{parent}/"));
    let mut hits = scan(project_root)?
        .documents
        .into_iter()
        // 已取代的笔记对改代码没有参考价值。
        .filter(|document| document.status != "已取代")
        .filter(|document| {
            document.code.iter().any(|code| {
                let code = code.trim_start_matches("./").trim_end_matches('/');
                inside(path, code) || inside(code, path)
            })
        })
        .map(|document| SearchHit {
            title: document.title,
            note_type: document.note_type,
            status: document.status,
            excerpt: document.excerpt,
            snippet: None,
        })
        .collect::<Vec<_>>();
    hits.sort_by_key(|hit| hit.note_type != "模块");
    Ok(hits)
}

/// 按标题（或别名）取一篇笔记；找不到为 `None`。
pub fn show(project_root: &Path, name: &str) -> io::Result<Option<NoteView>> {
    let vault = scan(project_root)?;
    let wanted = name.trim().to_lowercase();
    let index = vault
        .documents
        .iter()
        .position(|document| document.title.to_lowercase() == wanted)
        .or_else(|| {
            vault.documents.iter().position(|document| {
                document
                    .aliases
                    .iter()
                    .any(|alias| alias.to_lowercase() == wanted)
            })
        });
    let Some(index) = index else {
        return Ok(None);
    };
    let document = &vault.documents[index];
    let title_of = |id: &str| {
        vault
            .documents
            .iter()
            .find(|document| document.id == id)
            .map(|document| document.title.clone())
    };
    let mut view = NoteView {
        title: document.title.clone(),
        path: document.path.clone(),
        note_type: document.note_type.clone(),
        status: document.status.clone(),
        code: document.code.clone(),
        verified_at: document.verified_at.clone(),
        body: vault.bodies[index].clone(),
        outgoing: Vec::new(),
        backlinks: Vec::new(),
        broken: Vec::new(),
    };
    for edge in &vault.edges {
        if edge.source == document.id {
            match (edge.unresolved, title_of(&edge.target)) {
                (false, Some(title)) => view.outgoing.push(title),
                _ => view
                    .broken
                    .push(edge.target.trim_start_matches("unresolved:").to_owned()),
            }
        } else if edge.target == document.id {
            view.backlinks.extend(title_of(&edge.source));
        }
    }
    for list in [&mut view.outgoing, &mut view.backlinks, &mut view.broken] {
        let mut seen = HashSet::new();
        list.retain(|title| seen.insert(title.clone()));
    }
    Ok(Some(view))
}

fn query_words(query: &str) -> io::Result<Vec<String>> {
    let words = query
        .to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if words.is_empty() {
        return Err(invalid("query is required"));
    }
    Ok(words)
}

/// 小写的标题、别名。
fn names(document: &KnowledgeDocument) -> String {
    format!("{} {}", document.title, document.aliases.join(" ")).to_lowercase()
}

fn matches(document: &KnowledgeDocument, lower_body: &str, words: &[String]) -> bool {
    let head = format!(
        "{} {}",
        names(document),
        document.tags.join(" ").to_lowercase()
    );
    words
        .iter()
        .all(|word| head.contains(word.as_str()) || lower_body.contains(word.as_str()))
}

/// 正文里第一处命中所在行（跳过标题行），截成命中词附近的一小段。
fn snippet(body: &str, words: &[String]) -> Option<String> {
    const BEFORE: usize = 12;
    const WIDTH: usize = 48;
    body.lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .find_map(|line| {
            let lower = line.to_lowercase();
            let at = words
                .iter()
                .filter_map(|word| lower.find(word.as_str()))
                .min()?;
            let chars = line.chars().collect::<Vec<_>>();
            let start = lower[..at]
                .chars()
                .count()
                .saturating_sub(BEFORE)
                .min(chars.len());
            let end = (start + WIDTH).min(chars.len());
            let text = chars[start..end].iter().collect::<String>();
            Some(format!(
                "{}{}{}",
                if start > 0 { "…" } else { "" },
                text.trim(),
                if end < chars.len() { "…" } else { "" }
            ))
        })
}

/// `code` 下文件在 `verified_at` 之后有提交的笔记；sha 不在历史中也算。
/// 按 sha 分组，每组一次 `git log`。非 git 仓库返回空。
pub fn stale(project_root: &Path) -> io::Result<StaleResult> {
    let mut groups = BTreeMap::<String, Vec<(String, Vec<String>)>>::new();
    for document in scan(project_root)?.documents {
        let code = document
            .code
            .into_iter()
            .filter(|path| !path.starts_with('~'))
            .collect::<Vec<_>>();
        if let (Some(sha), false) = (document.verified_at, code.is_empty()) {
            groups.entry(sha).or_default().push((document.path, code));
        }
    }
    let mut paths = Vec::new();
    for (sha, notes) in groups {
        let known = git(
            project_root,
            &["cat-file", "-e", &format!("{sha}^{{commit}}")],
        );
        if known.is_none() {
            if git(project_root, &["rev-parse", "--git-dir"]).is_none() {
                return Ok(StaleResult { paths: Vec::new() });
            }
            paths.extend(notes.into_iter().map(|(path, _)| path));
            continue;
        }
        let pathspecs = notes
            .iter()
            .flat_map(|(_, code)| code.iter().map(String::as_str))
            .collect::<HashSet<_>>();
        let range = format!("{sha}..HEAD");
        let mut args = vec![
            "log",
            "--relative",
            "--name-only",
            "--format=",
            &range,
            "--",
        ];
        args.extend(pathspecs);
        let changed = git(project_root, &args).unwrap_or_default();
        let changed = changed
            .lines()
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();
        for (path, code) in notes {
            if code.iter().any(|prefix| {
                let prefix = prefix.trim_end_matches('/');
                changed
                    .iter()
                    .any(|file| *file == prefix || file.starts_with(&format!("{prefix}/")))
            }) {
                paths.push(path);
            }
        }
    }
    paths.sort();
    Ok(StaleResult { paths })
}

/// 只替换 frontmatter 中的 `status:` 一行，其余字节原样保留。
pub fn set_status(project_root: &Path, request: SetStatusRequest) -> io::Result<SetStatusResult> {
    if !STATUSES.contains(&request.status.as_str()) {
        return Err(invalid("Unsupported note status"));
    }
    let vault = project_root.join(VAULT_DIR).canonicalize()?;
    let file = project_root.join(&request.path).canonicalize()?;
    if !file.starts_with(&vault) || !is_markdown(&file) {
        return Err(invalid("Path is not a knowledge note"));
    }
    let content = fs::read_to_string(&file)?;
    fs::write(&file, replace_status(&content, &request.status))?;
    Ok(SetStatusResult {
        path: request.path,
        status: request.status,
    })
}

pub(crate) fn replace_status(content: &str, status: &str) -> String {
    let line = format!("status: {status}");
    let Some(frontmatter) = split_frontmatter(content).0 else {
        return format!("---\n{line}\n---\n{content}");
    };
    // frontmatter 紧跟在开头的 `---\n` 之后。
    let start = 4;
    let end = start + frontmatter.len();
    let mut offset = start;
    for row in frontmatter.split_inclusive('\n') {
        if row.starts_with("status:") {
            let row_end = offset + row.trim_end_matches(['\n', '\r']).len();
            return format!("{}{line}{}", &content[..offset], &content[row_end..]);
        }
        offset += row.len();
    }
    format!("{}\n{line}{}", &content[..end], &content[end..])
}

fn scan(project_root: &Path) -> io::Result<Vault> {
    let mut vault = Vault {
        documents: Vec::new(),
        bodies: Vec::new(),
        edges: Vec::new(),
        diagnostics: Vec::new(),
    };
    let root = project_root.canonicalize()?;
    let Ok(vault_root) = root.join(VAULT_DIR).canonicalize() else {
        return Ok(vault);
    };
    if !vault_root.starts_with(&root) {
        return Ok(vault);
    }
    let mut files = walkdir::WalkDir::new(&vault_root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .map(|entry| entry.into_path())
        .filter(|path| is_note(path, &vault_root))
        // 软链指向 vault 外的文件不收录。
        .filter(|path| {
            path.canonicalize()
                .is_ok_and(|real| real.starts_with(&vault_root))
        })
        .collect::<Vec<_>>();
    files.sort();
    let mut pending = Vec::new();
    for path in files.into_iter().take(MAX_DOCUMENTS) {
        let Some(relative) = relative(&root, &path) else {
            continue;
        };
        let metadata = fs::metadata(&path)?;
        if metadata.len() > MAX_DOCUMENT_BYTES {
            vault.diagnostics.push(KnowledgeDiagnostic {
                kind: "size_limit".into(),
                message: "Markdown file exceeds 2 MiB and was skipped".into(),
                path: Some(relative),
            });
            continue;
        }
        let content = fs::read_to_string(&path)?;
        let parsed = parse_markdown(&content);
        let folder = path
            .parent()
            .and_then(|parent| parent.strip_prefix(&vault_root).ok())
            .and_then(|parent| parent.components().next())
            .and_then(|part| part.as_os_str().to_str())
            .unwrap_or_default()
            .to_string();
        vault.diagnostics.extend(
            format_problems(&root, &parsed, &folder, split_frontmatter(&content).1)
                .into_iter()
                .map(|(kind, message)| KnowledgeDiagnostic {
                    kind: kind.into(),
                    message,
                    path: Some(relative.clone()),
                }),
        );
        let id = format!("document:{relative}");
        pending.extend(
            parsed
                .links
                .into_iter()
                .map(|t| (id.clone(), t, "wikilink")),
        );
        pending.extend(
            parsed
                .supersedes
                .into_iter()
                .map(|t| (id.clone(), t, "supersedes")),
        );
        vault.bodies.push(split_frontmatter(&content).1.to_owned());
        vault.documents.push(KnowledgeDocument {
            id,
            path: relative,
            title: path
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("Untitled")
                .to_string(),
            excerpt: parsed.excerpt,
            // 根目录下没写 type 的笔记归「未分类」，面板照常显示，lint 提示归位。
            note_type: parsed.note_type.unwrap_or_else(|| {
                if folder.is_empty() {
                    UNSORTED.into()
                } else {
                    folder
                }
            }),
            status: parsed.status.unwrap_or_else(|| "已确认".into()),
            tags: parsed.tags,
            aliases: parsed.aliases,
            code: parsed.code,
            sources: parsed.sources,
            verified_at: parsed.verified_at,
            url: parsed.url,
            digested: parsed.digested,
            headings: parsed.headings,
            modified_at: modified_secs(&metadata),
        });
    }
    vault.edges = resolve_edges(&vault.documents, pending);
    Ok(vault)
}

/// 体检报告：`errors` 必须修，`warnings` 逐条判断；路径相对 vault。
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintReport {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub notes: usize,
    pub drafts: usize,
}

/// 知识库体检：格式、重名、断链、孤立、首页、过期。只读。
pub fn lint(project_root: &Path) -> io::Result<LintReport> {
    let vault = scan(project_root)?;
    let note = |path: &str| {
        path.trim_start_matches(VAULT_DIR)
            .trim_start_matches('/')
            .to_owned()
    };
    let mut report = LintReport {
        notes: vault.documents.len(),
        drafts: vault
            .documents
            .iter()
            .filter(|d| d.status == "草稿")
            .count(),
        ..LintReport::default()
    };
    for diagnostic in &vault.diagnostics {
        let line = format!(
            "{}: {}",
            note(diagnostic.path.as_deref().unwrap_or_default()),
            diagnostic.message
        );
        if WARNING_KINDS.contains(&diagnostic.kind.as_str()) {
            report.warnings.push(line);
        } else {
            report.errors.push(line);
        }
    }
    let mut titles = HashMap::new();
    for document in &vault.documents {
        if let Some(previous) = titles.insert(document.title.to_lowercase(), &document.path) {
            report.errors.push(format!(
                "{}: 标题与 {} 重复",
                note(&document.path),
                note(previous)
            ));
        }
    }
    let mut urls = HashMap::new();
    for document in &vault.documents {
        let Some(url) = &document.url else { continue };
        if let Some(previous) = urls.insert(url.trim_end_matches('/'), &document.path) {
            report.errors.push(format!(
                "{}: 来源 url 与 {} 重复",
                note(&document.path),
                note(previous)
            ));
        }
    }
    let mut linked = HashSet::new();
    for edge in &vault.edges {
        if edge.unresolved {
            report.errors.push(format!(
                "{}: 断链 [[{}]]",
                note(edge.source.trim_start_matches("document:")),
                edge.target.trim_start_matches("unresolved:")
            ));
        } else {
            linked.insert(edge.source.as_str());
            linked.insert(edge.target.as_str());
        }
    }
    for document in &vault.documents {
        if !linked.contains(document.id.as_str()) {
            report.errors.push(format!(
                "{}: 孤立笔记（无出链也无入链）",
                note(&document.path)
            ));
        }
    }
    // 空库（刚 `berth project init`）不算缺首页：首页随首批笔记一起写。
    if report.notes > 0 && !project_root.join(VAULT_DIR).join(HOME_NOTE).is_file() {
        report.errors.push(format!("缺少 {HOME_NOTE}（面板首页）"));
    }
    for idea in super::ideas::list(project_root)? {
        if !super::ideas::IDEA_STATUSES.contains(&idea.status.as_str()) {
            report.errors.push(format!(
                "{}: status `{}` 不在约定取值内",
                note(&idea.path),
                idea.status
            ));
        }
    }
    for path in stale(project_root)?.paths {
        report.warnings.push(format!(
            "{}: 可能过期（code 在 verified_at 之后有提交）",
            note(&path)
        ));
    }
    Ok(report)
}

/// `checkout` 是主项目以外的 worktree 时，它从主项目 HEAD 分叉以来改过的 vault 文件
/// （含未提交与未跟踪），路径相对 checkout 根。知识只写主项目，这些改动应改写过去。
pub fn worktree_changes(checkout: &Path, main: &Path) -> Vec<String> {
    let same = |a: &Path, b: &Path| a.canonicalize().ok() == b.canonicalize().ok();
    if same(checkout, main) {
        return Vec::new();
    }
    let Some(head) = git(main, &["rev-parse", "HEAD"]) else {
        return Vec::new();
    };
    let Some(base) = git(checkout, &["merge-base", "HEAD", head.trim()]) else {
        return Vec::new();
    };
    let quiet = ["-c", "core.quotePath=false"];
    let changed = [
        vec!["diff", "--name-only", base.trim(), "--", VAULT_DIR],
        vec![
            "ls-files",
            "--others",
            "--exclude-standard",
            "--",
            VAULT_DIR,
        ],
    ]
    .iter()
    .filter_map(|args| git(checkout, &[&quiet[..], args].concat()))
    .collect::<String>();
    changed
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// 单篇笔记的格式问题：`(kind, message)`。规则即 `berth guide knowledge` 的约定。
fn format_problems(
    root: &Path,
    parsed: &super::parser::ParsedMarkdown,
    folder: &str,
    body: &str,
) -> Vec<(&'static str, String)> {
    let mut problems = Vec::new();
    // 来源笔记记的是外部资料，没有 verified_at，改为必须有 url 与 kind；status 缺省为已确认。
    let source = parsed.note_type.as_deref() == Some("来源");
    for (key, missing) in [
        ("type", parsed.note_type.is_none()),
        ("verified_at", !source && parsed.verified_at.is_none()),
        ("url", source && parsed.url.is_none()),
        ("kind", source && parsed.kind.is_none()),
    ] {
        if missing {
            problems.push(("frontmatter", format!("缺少 frontmatter `{key}`")));
        }
    }
    if let Some(note_type) = &parsed.note_type {
        if !TYPES.contains(&note_type.as_str()) {
            problems.push(("frontmatter", format!("type `{note_type}` 不在约定取值内")));
        } else if folder.is_empty() {
            problems.push((
                "frontmatter",
                format!("笔记应放在类型目录 `{note_type}/` 下"),
            ));
        } else if note_type != folder {
            problems.push((
                "frontmatter",
                format!("type `{note_type}` 与所在目录 `{folder}` 不一致"),
            ));
        }
        if let Some(kind) = parsed.kind.as_deref().filter(|_| source) {
            if !SOURCE_KINDS.contains(&kind) {
                problems.push(("frontmatter", format!("kind `{kind}` 不在约定取值内")));
            }
        }
        if matches!(note_type.as_str(), "模块" | "经验") && parsed.code.is_empty() {
            problems.push(("frontmatter", "模块 / 经验必须有 `code`".to_owned()));
        }
    }
    if let Some(status) = &parsed.status {
        if !STATUSES.contains(&status.as_str()) {
            problems.push(("frontmatter", format!("status `{status}` 不在约定取值内")));
        }
    }
    for code in &parsed.code {
        if !code.starts_with('~') && !root.join(code).exists() {
            problems.push(("code_path", format!("code 路径不存在 `{code}`")));
        }
    }
    let lines = body.trim().lines().count();
    if lines > LONG_NOTE_LINES {
        problems.push(("too_long", format!("正文 {lines} 行，考虑拆分")));
    }
    problems
}

/// vault 里的 `.md` 都是笔记，除了根目录的 `README.md`（给人看的指针）、`想法/`（见 [`super::ideas`]）
/// 与 Jev 写的 `记录/`、`交接/`（见 [`super::journal`]）、专家规矩 `专家/`（见 [`super::rules`]）。
fn is_note(path: &Path, vault_root: &Path) -> bool {
    is_markdown(path)
        && !path.starts_with(vault_root.join(super::ideas::IDEAS_DIR))
        && !super::journal::is_journal(vault_root, path)
        && !path.starts_with(vault_root.join(super::rules::RULES_DIR))
        && !(path.parent() == Some(vault_root)
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("README.md")))
}

fn resolve_edges(
    documents: &[KnowledgeDocument],
    links: Vec<(String, String, &'static str)>,
) -> Vec<KnowledgeEdge> {
    let mut lookup = HashMap::new();
    for document in documents {
        lookup.insert(document.title.to_lowercase(), document.id.clone());
    }
    for document in documents {
        for alias in &document.aliases {
            lookup
                .entry(alias.to_lowercase())
                .or_insert_with(|| document.id.clone());
        }
    }
    links
        .into_iter()
        .enumerate()
        .map(|(index, (source, raw, kind))| {
            let target = lookup.get(&raw.to_lowercase()).cloned();
            KnowledgeEdge {
                id: format!("{kind}:{index}:{source}"),
                source,
                unresolved: target.is_none(),
                target: target.unwrap_or_else(|| format!("unresolved:{raw}")),
                kind: kind.into(),
            }
        })
        .collect()
}

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let mut command = std::process::Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.args(args).current_dir(root).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

pub(super) fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

pub(super) fn is_markdown(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}
fn relative(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
}
pub(super) fn modified_secs(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(root: &Path, relative: &str, content: &str) {
        let path = root.join(VAULT_DIR).join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn scans_only_vault_notes_and_resolves_links() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("README.md"), "# outside").unwrap();
        note(root.path(), "README.md", "# 约定 [[A]]");
        note(
            root.path(),
            "模块/A.md",
            "---\ntype: 模块\naliases: [alpha]\n---\n# A\n[[B]] [[missing]]",
        );
        note(
            root.path(),
            "决策/B.md",
            "---\nstatus: 草稿\nsupersedes: [\"[[Alpha]]\"]\n---\n# B",
        );
        let result = snapshot(root.path()).unwrap();
        let titles = result
            .documents
            .iter()
            .map(|d| d.title.as_str())
            .collect::<Vec<_>>();
        assert_eq!(titles, ["B", "A"]);
        let b = &result.documents[0];
        assert_eq!((b.note_type.as_str(), b.status.as_str()), ("决策", "草稿"));
        assert_eq!(result.documents[1].status, "已确认");
        let edges = result
            .edges
            .iter()
            .map(|e| (e.kind.as_str(), e.target.as_str(), e.unresolved))
            .collect::<Vec<_>>();
        assert!(edges.contains(&("wikilink", "document:.berth/knowledge/决策/B.md", false)));
        assert!(edges.contains(&("wikilink", "unresolved:missing", true)));
        assert!(edges.contains(&("supersedes", "document:.berth/knowledge/模块/A.md", false)));
    }

    #[test]
    fn covering_finds_notes_by_code_path_in_both_directions() {
        let root = tempfile::tempdir().unwrap();
        note(
            root.path(),
            "经验/坑.md",
            "---\ntype: 经验\ncode: [src/term/pty.rs]\n---\n# 坑",
        );
        note(
            root.path(),
            "模块/终端.md",
            "---\ntype: 模块\ncode: [src/term/]\n---\n# 终端",
        );
        note(
            root.path(),
            "模块/别的.md",
            "---\ntype: 模块\ncode: [src/termx/]\n---\n# 别的",
        );
        note(
            root.path(),
            "模块/旧终端.md",
            "---\ntype: 模块\nstatus: 已取代\ncode: [src/term/]\n---\n# 旧终端",
        );
        let titles = |path: &str| {
            covering(root.path(), path)
                .unwrap()
                .into_iter()
                .map(|hit| hit.title)
                .collect::<Vec<_>>()
        };
        // 文件：覆盖它的目录与文件本身，模块排前面。
        assert_eq!(titles("./src/term/pty.rs"), ["终端", "坑"]);
        // 目录：code 在它里面的也算；`src/termx/` 不是 `src/term` 的子目录。
        assert_eq!(titles("src/term/"), ["终端", "坑"]);
        assert!(titles("docs/a.md").is_empty());
        assert!(covering(root.path(), " / ").is_err());
    }

    #[test]
    fn root_notes_are_listed_as_unsorted_and_linted() {
        let root = tempfile::tempdir().unwrap();
        note(root.path(), "README.md", "# 约定");
        note(root.path(), "z.md", "# z\n随手记");
        note(root.path(), "typed.md", "---\ntype: 概念\n---\n# typed");
        let result = snapshot(root.path()).unwrap();
        let notes = result
            .documents
            .iter()
            .map(|d| (d.title.as_str(), d.note_type.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(notes, [("typed", "概念"), ("z", "未分类")]);
        let errors = lint(root.path()).unwrap().errors;
        assert!(errors
            .iter()
            .any(|e| e == "typed.md: 笔记应放在类型目录 `概念/` 下"));
        assert!(errors.iter().any(|e| e == "z.md: 缺少 frontmatter `type`"));
    }

    #[test]
    fn search_matches_body_text() {
        let root = tempfile::tempdir().unwrap();
        note(
            root.path(),
            "概念/termd.md",
            "# termd\n\n终端守护进程很长的正文",
        );
        note(root.path(), "概念/其他.md", "# 其他");
        let hits = search(
            root.path(),
            SearchRequest {
                query: "守护进程".into(),
                limit: 10,
            },
        )
        .unwrap();
        assert_eq!(hits.documents.len(), 1);
    }

    #[test]
    fn find_ranks_named_notes_first_and_filters_by_type() {
        let root = tempfile::tempdir().unwrap();
        note(
            root.path(),
            "模块/终端.md",
            "---\ntype: 模块\n---\n# 终端\n\n很长的开头文字，用来把命中词推到后面去：termd 守护进程负责会话。",
        );
        note(
            root.path(),
            "概念/termd.md",
            "---\ntype: 概念\naliases: [守护]\n---\n# termd\n\n终端守护进程",
        );
        let hits = find(root.path(), "TermD", None, 10).unwrap();
        let titles = hits
            .iter()
            .map(|hit| hit.title.as_str())
            .collect::<Vec<_>>();
        assert_eq!(titles, ["termd", "终端"]);
        assert_eq!(
            hits[1].snippet.as_deref(),
            Some("…用来把命中词推到后面去：termd 守护进程负责会话。")
        );
        let only = find(root.path(), "termd", Some("模块"), 10).unwrap();
        assert_eq!(only.len(), 1);
        assert!(find(root.path(), "  ", None, 10).is_err());
    }

    #[test]
    fn show_finds_by_alias_and_lists_links_by_title() {
        let root = tempfile::tempdir().unwrap();
        note(
            root.path(),
            "概念/A.md",
            "---\ntype: 概念\naliases: [alpha]\n---\n# A\n[[B]] [[B]] [[缺]]",
        );
        note(
            root.path(),
            "概念/B.md",
            "---\ntype: 概念\n---\n# B\n[[alpha]]",
        );
        let view = show(root.path(), "ALPHA").unwrap().unwrap();
        assert_eq!(view.title, "A");
        assert_eq!(view.outgoing, ["B"]);
        assert_eq!(view.backlinks, ["B"]);
        assert_eq!(view.broken, ["缺"]);
        assert!(view.body.starts_with("# A"));
        assert!(show(root.path(), "无").unwrap().is_none());
    }

    #[test]
    fn symlink_outside_vault_is_not_indexed() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("x.md"), "# X").unwrap();
        fs::create_dir_all(root.path().join(VAULT_DIR)).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), root.path().join(VAULT_DIR).join("概念"))
            .unwrap();
        assert!(snapshot(root.path()).unwrap().documents.is_empty());
    }

    #[test]
    fn set_status_rewrites_only_status_line() {
        let root = tempfile::tempdir().unwrap();
        let original =
            "---\ntype: 决策\nstatus: 草稿     # 注释\nunknown: [x, y]\n---\n\n# T\nstatus: body\n";
        note(root.path(), "决策/T.md", original);
        set_status(
            root.path(),
            SetStatusRequest {
                path: ".berth/knowledge/决策/T.md".into(),
                status: "已确认".into(),
            },
        )
        .unwrap();
        let updated = fs::read_to_string(root.path().join(VAULT_DIR).join("决策/T.md")).unwrap();
        assert_eq!(
            updated,
            original.replace("status: 草稿     # 注释", "status: 已确认")
        );

        assert_eq!(
            replace_status("---\ntype: 决策\n---\nbody", "已取代"),
            "---\ntype: 决策\nstatus: 已取代\n---\nbody"
        );
        assert_eq!(
            replace_status("body", "已取代"),
            "---\nstatus: 已取代\n---\nbody"
        );
    }

    #[test]
    fn set_status_rejects_paths_outside_vault_and_bad_status() {
        let root = tempfile::tempdir().unwrap();
        note(root.path(), "决策/T.md", "# T");
        fs::write(root.path().join("x.md"), "# X").unwrap();
        let request = |path: &str, status: &str| SetStatusRequest {
            path: path.into(),
            status: status.into(),
        };
        assert!(set_status(root.path(), request("x.md", "已确认")).is_err());
        assert!(set_status(
            root.path(),
            request(".berth/knowledge/../../x.md", "已确认")
        )
        .is_err());
        assert!(set_status(root.path(), request(".berth/knowledge/决策/T.md", "done")).is_err());
    }

    #[test]
    fn stale_flags_changed_code_and_unknown_sha() {
        let root = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| assert!(git(root.path(), args).is_some(), "git {args:?}");
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        fs::create_dir_all(root.path().join("src/a")).unwrap();
        fs::write(root.path().join("src/a/x.rs"), "1").unwrap();
        fs::write(root.path().join("src/b.rs"), "1").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "base"]);
        let base = git(root.path(), &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        fs::write(root.path().join("src/a/x.rs"), "2").unwrap();
        run(&["commit", "-qam", "change"]);
        let fm =
            |code: &str, sha: &str| format!("---\ncode: [{code}]\nverified_at: {sha}\n---\n# n");
        note(root.path(), "模块/changed.md", &fm("src/a/", &base));
        note(root.path(), "模块/fresh.md", &fm("src/b.rs", &base));
        note(root.path(), "模块/unknown.md", &fm("src/b.rs", "deadbeef"));
        let result = stale(root.path()).unwrap();
        assert_eq!(
            result.paths,
            [
                ".berth/knowledge/模块/changed.md",
                ".berth/knowledge/模块/unknown.md"
            ]
        );
    }

    #[test]
    fn lint_reports_format_links_orphans_and_missing_home() {
        let root = tempfile::tempdir().unwrap();
        let fm = |kind: &str| format!("---\ntype: {kind}\nverified_at: abc\n---\n");
        note(
            root.path(),
            "概念/A.md",
            &format!("{}# A\n[[B]] [[missing]]", fm("概念")),
        );
        note(root.path(), "概念/B.md", &format!("{}# B", fm("模块")));
        note(root.path(), "概念/C.md", &format!("{}# C", fm("概念")));
        note(
            root.path(),
            "思想/D.md",
            &format!("{}# D [[A]]", fm("思想")),
        );
        let report = lint(root.path()).unwrap();
        let has = |needle: &str| report.errors.iter().any(|line| line.contains(needle));
        assert!(has("概念/A.md: 断链 [[missing]]"), "{:?}", report.errors);
        assert!(has("概念/B.md: type `模块` 与所在目录 `概念` 不一致"));
        assert!(has("概念/B.md: 模块 / 经验必须有 `code`"));
        assert!(has("概念/C.md: 孤立笔记"));
        assert!(has("缺少 地图/首页.md"));
        assert!(!has("概念/A.md: 孤立"));
        assert!(has("思想/D.md: type `思想` 不在约定取值内"));
        // 必填只有 type 与 verified_at（模块 / 经验另要 code）。
        assert!(!has("缺少 frontmatter"), "{:?}", report.errors);
        assert_eq!(report.notes, 4);

        let empty = tempfile::tempdir().unwrap();
        assert!(lint(empty.path()).unwrap().errors.is_empty());
    }
    #[test]
    fn lint_checks_source_notes_by_url_and_kind() {
        let root = tempfile::tempdir().unwrap();
        let source = |url: &str, kind: &str| {
            format!("---\ntype: 来源\nkind: {kind}\nurl: {url}\n---\n# S\n[[T]]")
        };
        note(root.path(), "来源/T.md", &source("https://a.dev/x", "repo"));
        note(
            root.path(),
            "来源/U.md",
            &source("https://a.dev/x/", "blog"),
        );
        let report = lint(root.path()).unwrap();
        let has = |needle: &str| report.errors.iter().any(|line| line.contains(needle));
        assert!(
            has("来源/U.md: kind `blog` 不在约定取值内"),
            "{:?}",
            report.errors
        );
        assert!(has("来源/U.md: 来源 url 与 来源/T.md 重复"));
        // 来源不要求 status / sources / verified_at。
        assert!(!has("来源/T.md: 缺少"));
    }

    #[test]
    fn worktree_changes_lists_vault_edits_since_the_fork() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main");
        let sh = |dir: &Path, args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@t"])
                .args(args)
                .current_dir(dir)
                .status()
                .unwrap()
                .success();
            assert!(ok, "{args:?}");
        };
        fs::create_dir(&main).unwrap();
        sh(&main, &["init", "-q", "-b", "dev"]);
        note(&main, "概念/旧.md", "# 旧");
        sh(&main, &["add", "-A"]);
        sh(&main, &["commit", "-qm", "init"]);
        let wt = tmp.path().join("wt");
        sh(
            &main,
            &["worktree", "add", "-q", "-b", "w", wt.to_str().unwrap()],
        );
        assert!(worktree_changes(&wt, &main).is_empty());
        note(&wt, "概念/新.md", "# 新");
        note(&wt, "概念/旧.md", "# 改");
        fs::write(wt.join("code.rs"), "").unwrap();
        assert_eq!(
            worktree_changes(&wt, &main),
            [".berth/knowledge/概念/新.md", ".berth/knowledge/概念/旧.md"]
        );
        assert!(worktree_changes(&main, &main).is_empty());
    }
}
