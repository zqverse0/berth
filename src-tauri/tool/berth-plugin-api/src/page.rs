//! 页面环境的包内资源（docs/plugin-architecture.md §2.4）：宿主按 `<插件>/<包内路径>` 取文件。
//! html 在最前面注入桥脚本（`page.js`，即页面里的 `window.berth`），并带上页面 CSP：
//! 只许加载包内资源与 data / blob，不许联网、不许再嵌 frame。
//! 桌面经 `berth-plugin` 协议、远程浏览器经 `/__berth/plugin/` 调这里，两处同一份规则。

use std::path::Path;

use serde_json::Value;

use crate::rpc::{ApiError, ProjectLookup, Reason};

const BRIDGE: &str = include_str!("page.js");

/// 一个包内资源的响应。
#[derive(Debug)]
pub struct Asset {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
    /// 仅 html：页面 CSP（响应头 `Content-Security-Policy`）。
    pub csp: Option<String>,
}

/// 读包内 `path`（`/` 分隔、相对包根）；只给 `pages`（tool.json 声明的页面）所在顶层目录里的文件，
/// 包里其余内容（脚本、Agent 包的 `private/` 等）不经页面通道外露。`origin` 是页面自己的源，
/// 写进 CSP：桌面传 `'self'`；远程浏览器里页面是不透明源，`'self'` 不可靠，传服务地址。
pub fn asset(package: &Path, pages: &[String], path: &str, origin: &str) -> Result<Asset, String> {
    let root = std::fs::canonicalize(package).map_err(|error| error.to_string())?;
    let file = std::fs::canonicalize(root.join(path.trim_start_matches('/')))
        .map_err(|error| format!("{path}: {error}"))?;
    // 页面所在的顶层目录整个放行（与 `tools check` 的包边界一致）；包根下的页面只放行它自己
    let allowed = pages.iter().any(|page| {
        let page = page.trim_start_matches('/');
        let scope = match page.split_once('/') {
            Some((top, _)) => root.join(top),
            None => root.join(page),
        };
        std::fs::canonicalize(scope).is_ok_and(|scope| file.starts_with(scope))
    });
    if !allowed || !file.is_file() {
        return Err(format!("{path} is not a file in the plugin's page directories"));
    }
    let bytes = std::fs::read(&file).map_err(|error| format!("{path}: {error}"))?;
    let mime = mime_of(&file);
    if mime != HTML {
        return Ok(Asset {
            mime,
            bytes,
            csp: None,
        });
    }
    Ok(Asset {
        mime,
        bytes: inject_bridge(&String::from_utf8_lossy(&bytes)).into_bytes(),
        csp: Some(csp(origin)),
    })
}

/// 页面里经宿主后端执行的命名空间（§3 中页面可用、且不需要宿主界面的）；`ui` / `files` / `env` /
/// `agent` 由宿主前端实现，`process` / `fs` / `http` 页面不可用。
const BACKEND_NAMESPACES: &[&str] = &["storage", "data"];

/// 页面的一次后端调用：与脚本同一套权限与实现（[`crate::Host::call`]）。
pub fn call(
    package: &Path,
    method: &str,
    params: Value,
    project: ProjectLookup,
) -> Result<Value, ApiError> {
    let namespace = method.split_once('.').map(|(namespace, _)| namespace);
    if !namespace.is_some_and(|namespace| BACKEND_NAMESPACES.contains(&namespace)) {
        return Err(ApiError::new(
            Reason::Unsupported,
            format!("{method} is not available in pages"),
        ));
    }
    crate::host_for(package, project)
        .map_err(|message| ApiError::new(Reason::Internal, message))?
        .call(method, params)
}

const HTML: &str = "text/html; charset=utf-8";

fn mime_of(file: &Path) -> &'static str {
    let ext = file
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => HTML,
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn csp(origin: &str) -> String {
    let own = format!("{origin} data: blob:");
    format!(
        "default-src {own}; script-src {origin} 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src {origin} 'unsafe-inline'; \
         img-src {own}; font-src {own}; media-src {own}; connect-src {own}; worker-src {origin} blob:; \
         frame-src 'none'; object-src 'none'; form-action 'none'; base-uri {origin}"
    )
}

/// 桥脚本放进 `<head>` 开头（没有 `<head>` 就放在最前），保证先于页面自己的脚本运行。
fn inject_bridge(html: &str) -> String {
    let script = format!("<script>{BRIDGE}</script>");
    let at = html
        .to_ascii_lowercase()
        .find("<head")
        .and_then(|start| html[start..].find('>').map(|end| start + end + 1))
        .unwrap_or(0);
    format!("{}{script}{}", &html[..at], &html[at..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("page/fonts")).unwrap();
        std::fs::write(
            dir.path().join("page/index.html"),
            "<!doctype html><html><HEAD lang=\"x\"><title>t</title></HEAD><body></body></html>",
        )
        .unwrap();
        std::fs::write(dir.path().join("page/fonts/a.woff2"), [1u8, 2, 3]).unwrap();
        std::fs::write(dir.path().join("secret.txt"), "x").unwrap();
        dir
    }

    fn pages() -> Vec<String> {
        vec!["page/index.html".to_owned()]
    }

    #[test]
    fn page_html_gets_the_bridge_first_and_a_csp() {
        let dir = package();
        let page = asset(dir.path(), &pages(), "page/index.html", "'self'").unwrap();
        let html = String::from_utf8(page.bytes).unwrap();
        let bridge = html.find("window.berth").unwrap();
        assert!(html.find("<HEAD lang=\"x\">").unwrap() < bridge);
        assert!(bridge < html.find("<title>").unwrap());
        let csp = page.csp.unwrap();
        assert!(csp.contains("connect-src 'self' data: blob:"));
        assert!(csp.contains("frame-src 'none'"));
        assert_eq!(page.mime, HTML);
    }

    #[test]
    fn assets_keep_their_bytes_and_mime() {
        let dir = package();
        let font = asset(dir.path(), &pages(), "/page/fonts/a.woff2", "'self'").unwrap();
        assert_eq!(font.bytes, [1, 2, 3]);
        assert_eq!(font.mime, "font/woff2");
        assert!(font.csp.is_none());
    }

    #[test]
    fn pages_reach_storage_but_not_process() {
        let dir = package();
        std::fs::write(dir.path().join("tool.json"), r#"{"id":"demo-page"}"#).unwrap();
        let project = || -> ProjectLookup { Box::new(|| Value::Null) };
        let denied = call(dir.path(), "process.run", serde_json::json!({}), project()).unwrap_err();
        assert_eq!(denied.reason, Reason::Unsupported);
        let unknown =
            call(dir.path(), "storage.nope", serde_json::json!({}), project()).unwrap_err();
        assert_eq!(unknown.reason, Reason::Unsupported);
    }

    #[test]
    fn paths_outside_the_package_or_missing_are_rejected() {
        let dir = package();
        assert!(asset(dir.path(), &pages(), "page/../secret.txt", "'self'").is_err());
        // 包里页面目录以外的文件不给
        assert!(asset(dir.path(), &pages(), "secret.txt", "'self'").is_err());
        assert!(asset(dir.path(), &[], "page/index.html", "'self'").is_err());
        // 包根下的页面只放行它自己
        std::fs::write(dir.path().join("index.html"), "<html></html>").unwrap();
        let root_page = ["index.html".to_owned()];
        assert!(asset(dir.path(), &root_page, "index.html", "'self'").is_ok());
        assert!(asset(dir.path(), &root_page, "secret.txt", "'self'").is_err());
        // 深一层的页面：同一顶层目录里的资源都给
        let nested = ["page/fonts/index.html".to_owned()];
        assert!(asset(dir.path(), &nested, "page/index.html", "'self'").is_ok());
        assert!(asset(dir.path(), &pages(), "page/missing.js", "'self'").is_err());
        assert!(asset(dir.path(), &pages(), "page", "'self'").is_err());
    }
}
