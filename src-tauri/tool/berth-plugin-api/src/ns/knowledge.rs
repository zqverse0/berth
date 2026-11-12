//! knowledge@1（权限 `knowledge`）：当前项目知识库的「来源」。`findSource(url)` → `{path} | null`，
//! `addSource({url, title, markdown, meta?})` → `{path}`（同 url 已存在为 `conflict`，`data.path` 指向它）。
//! 路径都是绝对路径。
//!
//! 知识库服务在 berth-project-core，由运行脚本的一方注入（[`set_knowledge`]）：berth-cli 的
//! `tools run|call` 与 GUI 的插件视图各注册一次同一组函数。没注入就是 `unsupported`。

use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{json, Map, Value};

use crate::rpc::{str_param, ApiError, ApiResult, Host, Reason};

/// 知识库服务的三个函数（路径相对知识库所在项目根）。
pub struct KnowledgeHost {
    /// 项目根 → 知识库所在的项目根（worktree 归到主项目）。
    pub vault: fn(&Path) -> PathBuf,
    pub find_source: fn(&Path, &str) -> io::Result<Option<String>>,
    /// `Ok(Ok(新路径))`，同 url 已有为 `Ok(Err(已有路径))`。
    #[allow(clippy::type_complexity)]
    pub add_source:
        fn(&Path, &str, &str, &str, Option<&Map<String, Value>>) -> io::Result<Result<String, String>>,
}

static KNOWLEDGE: OnceLock<KnowledgeHost> = OnceLock::new();

/// 注入知识库实现；进程内只生效第一次。
pub fn set_knowledge(host: KnowledgeHost) {
    let _ = KNOWLEDGE.set(host);
}

pub fn call(host: &Host, name: &str, params: &Value) -> Option<ApiResult> {
    if !matches!(name, "findSource" | "addSource") {
        return None;
    }
    Some((|| {
        let url = str_param(params, "url")?;
        let source = if name == "addSource" {
            if !(params["meta"].is_null() || params["meta"].is_object()) {
                return Err(ApiError::invalid("meta must be an object"));
            }
            Some((str_param(params, "title")?, str_param(params, "markdown")?))
        } else {
            None
        };
        let project = (host.project)();
        let root = project["root"]
            .as_str()
            .ok_or_else(|| ApiError::new(Reason::NotFound, "not inside a Berth project"))?;
        let knowledge = KNOWLEDGE
            .get()
            .ok_or_else(|| ApiError::new(Reason::Unsupported, "knowledge is not available here"))?;
        let root = (knowledge.vault)(Path::new(root));
        let path = |relative: String| json!({ "path": root.join(relative) });
        let io = |error| ApiError::io("knowledge", error);
        let Some((title, markdown)) = source else {
            let found = (knowledge.find_source)(&root, url).map_err(io)?;
            return Ok(found.map_or(Value::Null, path));
        };
        match (knowledge.add_source)(&root, url, title, markdown, params["meta"].as_object()).map_err(io)? {
            Ok(added) => Ok(path(added)),
            Err(existing) => Err(ApiError::new(
                Reason::Conflict,
                format!("{existing} already has this url"),
            )
            .with_data(path(existing))),
        }
    })())
}
