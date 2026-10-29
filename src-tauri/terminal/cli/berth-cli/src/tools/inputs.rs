//! Agent 启动输入：`--inputs-file`（JSON 对象）为底，`--input name=value` 覆盖。
//! 值一律按字符串收集；取值校验归宿主启动（按 launchbar.json）。

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

use super::tool_error;
use crate::CliError;

/// 冲突（同一键两处都给）与格式错误报用户错误，不静默。
pub(crate) fn collect(
    inputs_file: Option<&Path>,
    pairs: &[String],
    operation: &str,
    json: bool,
) -> Result<BTreeMap<String, Value>, CliError> {
    let mut collected = match inputs_file {
        Some(path) => read_inputs_file(path, operation, json)?,
        None => BTreeMap::new(),
    };
    for pair in pairs {
        let (key, raw) = pair.split_once('=').ok_or_else(|| {
            tool_error(
                operation,
                crate::EXIT_USER_ERROR,
                format!("--input expects name=value, got {pair:?}"),
                json,
            )
        })?;
        if collected.contains_key(key) {
            return Err(tool_error(
                operation,
                crate::EXIT_USER_ERROR,
                format!("input {key:?} given twice (--inputs-file and --input); keep one source"),
                json,
            ));
        }
        collected.insert(key.to_string(), Value::String(raw.to_string()));
    }
    Ok(collected)
}

/// `--inputs-file` 的读取：JSON object → typed inputs map。
fn read_inputs_file(
    path: &Path,
    operation: &str,
    json: bool,
) -> Result<BTreeMap<String, serde_json::Value>, CliError> {
    let bytes = std::fs::read(path).map_err(|error| {
        tool_error(
            operation,
            crate::EXIT_USER_ERROR,
            format!("cannot read --inputs-file {}: {error}", path.display()),
            json,
        )
    })?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
        tool_error(
            operation,
            crate::EXIT_USER_ERROR,
            format!(
                "--inputs-file {} is not valid JSON: {error}",
                path.display()
            ),
            json,
        )
    })?;
    let object = value.as_object().ok_or_else(|| {
        tool_error(
            operation,
            crate::EXIT_USER_ERROR,
            "--inputs-file must contain a JSON object",
            json,
        )
    })?;
    Ok(object
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_are_strings_and_conflicts_are_rejected() {
        let collected = collect(None, &["expert=dev".into(), "n=3".into()], "t", false).unwrap();
        assert_eq!(collected["n"], Value::String("3".into()));
        assert!(collect(None, &["oops".into()], "t", false).is_err());

        let file = std::env::temp_dir().join(format!("berth-inputs-{}.json", std::process::id()));
        std::fs::write(&file, r#"{"expert":"a"}"#).unwrap();
        assert!(collect(Some(&file), &["expert=b".into()], "t", false).is_err());
        let _ = std::fs::remove_file(file);
    }
}
