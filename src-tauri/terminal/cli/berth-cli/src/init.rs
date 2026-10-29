//! `berth project init` 与 brief 的 `{berth}` 行；实现在 `berth_project_core::berth_dir`，GUI「启用 Berth」共用。

use std::path::PathBuf;

use berth_project_core::berth_dir;

pub(crate) fn run(path: Option<PathBuf>, json: bool) -> Result<(), String> {
    let root = match path {
        Some(path) => path,
        None => std::env::current_dir().map_err(|error| error.to_string())?,
    };
    let root =
        std::fs::canonicalize(&root).map_err(|error| format!("{}: {error}", root.display()))?;
    let created = berth_dir::init(&root).map_err(|error| error.to_string())?;
    if json {
        let value = serde_json::json!({ "root": root.join(".berth"), "created": created });
        println!("{value}");
    } else if created.is_empty() {
        println!("{} 已启用 Berth，无需改动", root.display());
    } else {
        for item in &created {
            println!("created .berth/{item}");
        }
    }
    Ok(())
}

/// `berth guide --brief` 的 `{berth}` 行：按当前项目是否启用告诉 Agent 怎么对待 `.berth/`。
pub(crate) fn brief_line() -> &'static str {
    if std::env::current_dir().is_ok_and(|cwd| berth_dir::enabled_at(&cwd)) {
        "- 本项目已启用 `.berth/`：任务只用 `berth project . task` 写，`.berth/local/` 是运行态不要读写，`.berth/` 下不要新建其他文件；\
         改文件前先 `berth project . knowledge for <路径>` 查设计缘由和踩过的坑\n"
    } else {
        "- 本项目未启用 `.berth/`：需要任务或知识库时请用户在 Berth 里启用（或执行 `berth project init`），不要自己创建\n"
    }
}
