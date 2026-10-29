//! storage@1（无需权限）：插件自己的键值数据，存 `<state>/storage.json`。

use serde_json::{json, Map, Value};

use crate::rpc::{str_param, ApiError, ApiResult, Host};

const FILE: &str = "storage.json";

pub fn call(host: &Host, name: &str, params: &Value) -> Option<ApiResult> {
    Some(match name {
        "get" => str_param(params, "key")
            .and_then(|key| Ok(read(host)?.remove(key).unwrap_or(Value::Null))),
        "set" => str_param(params, "key").and_then(|key| {
            let mut data = read(host)?;
            data.insert(key.to_owned(), params["value"].clone());
            write(host, data)
        }),
        "remove" => str_param(params, "key").and_then(|key| {
            let mut data = read(host)?;
            data.remove(key);
            write(host, data)
        }),
        _ => return None,
    })
}

fn read(host: &Host) -> Result<Map<String, Value>, ApiError> {
    let path = host.state_dir.join(FILE);
    match std::fs::read(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(error) => Err(ApiError::io("storage", error)),
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            ApiError::new(
                crate::rpc::Reason::Internal,
                format!("storage.json: {error}"),
            )
        }),
    }
}

fn write(host: &Host, data: Map<String, Value>) -> ApiResult {
    // ponytail: 整份读改写，并发写同一插件的 storage 会互相覆盖；需要时换成按键分文件。
    let text = serde_json::to_string_pretty(&Value::Object(data)).unwrap_or_default();
    crate::ns::fs::call(
        "writeText",
        &json!({"path": host.state_dir.join(FILE).to_string_lossy(), "text": text, "mode": 0o600}),
    )
    .unwrap_or(Ok(Value::Null))
}
