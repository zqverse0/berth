//! data@1（无需权限）：TOML 解析与生成（JSON 用脚本内置的 `JSON`）。

use serde_json::{json, Value};

use crate::rpc::{str_param, ApiError, ApiResult};

pub fn call(name: &str, params: &Value) -> Option<ApiResult> {
    Some(match name {
        "parseToml" => str_param(params, "text").and_then(|text| {
            toml::from_str::<Value>(text)
                .map_err(|error| ApiError::invalid(format!("TOML: {error}")))
        }),
        "stringifyToml" => {
            let value = &params["value"];
            if !value.is_object() {
                return Some(Err(ApiError::invalid("value must be an object")));
            }
            toml::to_string(value)
                .map(|text| json!(text))
                .map_err(|error| ApiError::invalid(format!("TOML: {error}")))
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toml_round_trips_tables() {
        let parsed = call("parseToml", &json!({"text": "a = 1\n[t]\nb = \"x\"\n"}))
            .unwrap()
            .unwrap();
        assert_eq!(parsed, json!({"a": 1, "t": {"b": "x"}}));
        let text = call("stringifyToml", &json!({"value": parsed}))
            .unwrap()
            .unwrap();
        assert_eq!(
            call("parseToml", &json!({"text": text})).unwrap().unwrap(),
            json!({"a": 1, "t": {"b": "x"}})
        );
    }
}
