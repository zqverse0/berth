//! 脚本环境：内嵌 QuickJS 运行包内 ES 模块。插件只能经 `__berth_call` 调宿主（[`Host::call`]）；
//! 模块只能 import 包内文件（不支持 npm 包与裸模块名）。

use std::path::{Path, PathBuf};
use std::rc::Rc;

use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::{Context, Ctx, Function, Module, Runtime, Value as JsValue};
use serde_json::{json, Value};

use crate::rpc::Host;

const PRELUDE: &str = include_str!("prelude.js");
const BOOTSTRAP: &str = "berth:bootstrap";

/// 运行一段引导模块（宿主写的 ES 模块源码），它把结果 JSON 写进 `globalThis.__berth_result`。
/// `globals` 是额外注入的字符串全局（如启动数据）。返回解析后的结果；脚本抛错时返回错误文本。
pub fn run(host: Host, bootstrap: &str, globals: &[(&str, String)]) -> Result<Value, String> {
    let runtime = Runtime::new().map_err(|error| error.to_string())?;
    let root = std::fs::canonicalize(&host.package)
        .map_err(|error| format!("{}: {error}", host.package.display()))?;
    runtime.set_loader(PackageResolver { root: root.clone() }, PackageLoader);
    let context = Context::full(&runtime).map_err(|error| error.to_string())?;
    let statics = json!({
        "pid": std::process::id(),
        "platform": crate::ns::env::platform(),
        "berthVersion": env!("CARGO_PKG_VERSION"),
        "vars": crate::ns::env::vars(),
        "storageDir": host.state_dir.to_string_lossy(),
    })
    .to_string();
    let host = Rc::new(host);
    context.with(|ctx| {
        let result = (|| -> rquickjs::Result<Option<String>> {
            let global = ctx.globals();
            let api = Rc::clone(&host);
            global.set(
                "__berth_call",
                Function::new(ctx.clone(), move |method: String, params: String| -> String {
                    let params = serde_json::from_str(&params).unwrap_or(Value::Null);
                    match api.call(&method, params) {
                        Ok(result) => json!({ "result": result }).to_string(),
                        Err(error) => json!({ "error": { "reason": error.reason.as_str(), "message": error.message } }).to_string(),
                    }
                })?,
            )?;
            global.set(
                "__berth_write",
                Function::new(ctx.clone(), |fd: i32, text: String| {
                    use std::io::Write;
                    let _ = if fd == 2 {
                        std::io::stderr().write_all(text.as_bytes())
                    } else {
                        std::io::stdout().write_all(text.as_bytes()).and_then(|_| std::io::stdout().flush())
                    };
                })?,
            )?;
            global.set("__berth_static", statics.as_str())?;
            for (name, value) in globals {
                global.set(*name, value.as_str())?;
            }
            ctx.eval::<(), _>(PRELUDE)?;
            Module::evaluate(ctx.clone(), BOOTSTRAP, bootstrap)?.finish::<()>()?;
            global.get::<_, Option<String>>("__berth_result")
        })();
        match result {
            Ok(Some(text)) => serde_json::from_str(&text).map_err(|error| error.to_string()),
            Ok(None) => Ok(Value::Null),
            Err(rquickjs::Error::WouldBlock) => Err("script never finished (a Promise was left pending)".to_owned()),
            Err(rquickjs::Error::Exception) => Err(exception(&ctx)),
            Err(error) => Err(error.to_string()),
        }
    })
}

/// 抛出的异常 → 文本：Error 取 message（宿主错误带 reason）+ 栈。
fn exception(ctx: &Ctx<'_>) -> String {
    let value: JsValue = ctx.catch();
    let Some(object) = value.as_object() else {
        return value
            .as_string()
            .and_then(|text| text.to_string().ok())
            .unwrap_or_else(|| "script threw a non-Error value".to_owned());
    };
    let field = |name: &str| {
        object
            .get::<_, Option<String>>(name)
            .ok()
            .flatten()
            .filter(|text| !text.is_empty())
    };
    let mut text = field("message").unwrap_or_else(|| "script error".to_owned());
    if let Some(reason) = field("reason") {
        text = format!("{text} ({reason})");
    }
    if let Some(stack) = field("stack") {
        text = format!("{text}\n{}", stack.trim_end());
    }
    text
}

/// 包内模块名都是规范化后的绝对路径；只能解析到包目录以内。
struct PackageResolver {
    root: PathBuf,
}

impl Resolver for PackageResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        let candidate = if Path::new(name).is_absolute() {
            PathBuf::from(name)
        } else if name.starts_with("./") || name.starts_with("../") {
            if base == BOOTSTRAP {
                return Err(resolve_error(
                    base,
                    name,
                    "relative import from the bootstrap",
                ));
            }
            Path::new(base)
                .parent()
                .unwrap_or(Path::new("/"))
                .join(name)
        } else {
            return Err(resolve_error(
                base,
                name,
                "only package files can be imported (no npm packages)",
            ));
        };
        let resolved = std::fs::canonicalize(&candidate)
            .map_err(|_| resolve_error(base, name, "file not found"))?;
        if !resolved.starts_with(&self.root) {
            return Err(resolve_error(base, name, "outside the plugin package"));
        }
        Ok(resolved.to_string_lossy().into_owned())
    }
}

fn resolve_error(base: &str, name: &str, why: &str) -> rquickjs::Error {
    rquickjs::Error::new_resolving_message(base, name, why)
}

struct PackageLoader;

impl Loader for PackageLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js, rquickjs::module::Declared>> {
        let source = std::fs::read_to_string(name)
            .map_err(|error| rquickjs::Error::new_loading_message(name, error.to_string()))?;
        Module::declare(ctx.clone(), name, source)
    }
}

/// 字符串 → JS 字符串字面量（import 路径拼进引导模块用）。
pub(crate) fn js_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn host(dir: &Path, permissions: &[&str]) -> Host {
        Host {
            plugin_id: "demo".into(),
            package: dir.to_path_buf(),
            permissions: permissions
                .iter()
                .map(|item| (*item).to_owned())
                .collect::<BTreeSet<_>>(),
            state_dir: dir.join("state"),
            project: Box::new(|| Value::Null),
            sessions: Default::default(),
        }
    }

    fn import_default(dir: &Path, file: &str, source: &str) -> String {
        let path = dir.join(file);
        std::fs::write(&path, source).unwrap();
        format!(
            "import f from {};\nglobalThis.__berth_result = JSON.stringify(await f());",
            js_string(&std::fs::canonicalize(path).unwrap().to_string_lossy())
        )
    }

    #[test]
    fn module_calls_host_and_imports_package_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("lib.js"),
            "export const twice = (x) => x * 2;",
        )
        .unwrap();
        let bootstrap = import_default(
            dir.path(),
            "main.js",
            r#"import { twice } from "./lib.js";
               export default async () => {
                 const toml = await berth.data.parseToml("n = 21");
                 return { n: twice(toml.n), platform: typeof berth.env.platform };
               }"#,
        );
        let result = run(host(dir.path(), &[]), &bootstrap, &[]).unwrap();
        assert_eq!(result, json!({"n": 42, "platform": "string"}));
    }

    #[test]
    fn missing_permission_rejects_with_denied() {
        let dir = tempfile::tempdir().unwrap();
        let bootstrap = import_default(
            dir.path(),
            "main.js",
            r#"export default async () => {
                 try { await berth.fs.readText("/etc/hostname"); return "read" }
                 catch (error) { return error.reason }
               }"#,
        );
        assert_eq!(
            run(host(dir.path(), &[]), &bootstrap, &[]).unwrap(),
            json!("denied")
        );
    }

    #[test]
    fn page_namespaces_reject_unsupported_and_npm_imports_fail() {
        let dir = tempfile::tempdir().unwrap();
        let bootstrap = import_default(
            dir.path(),
            "main.js",
            r#"export default () => berth.ui.notify("x").catch((error) => error.reason)"#,
        );
        assert_eq!(
            run(host(dir.path(), &[]), &bootstrap, &[]).unwrap(),
            json!("unsupported")
        );
        let bootstrap = import_default(
            dir.path(),
            "npm.js",
            r#"import x from "lodash"; export default () => x"#,
        );
        assert!(run(host(dir.path(), &[]), &bootstrap, &[])
            .unwrap_err()
            .contains("no npm packages"));
    }

    #[test]
    fn thrown_errors_come_back_as_text() {
        let dir = tempfile::tempdir().unwrap();
        let bootstrap = import_default(
            dir.path(),
            "main.js",
            r#"export default () => { throw new Error("boom") }"#,
        );
        assert!(run(host(dir.path(), &[]), &bootstrap, &[])
            .unwrap_err()
            .starts_with("boom"));
    }
}
