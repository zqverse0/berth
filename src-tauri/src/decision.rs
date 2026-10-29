//! Berth 的决策模型（Jev 这类 System One 模型）：任何功能都经这里调用，自己只管出题、阈值和命中后做什么。
//!
//! 调用方式：`resolve` 选好档案与模型 → 填一个 [`Request`]（谁在调、为谁调、`state`、题目）→ `decide`
//! 拿到 [`Response`]。每次调用（成功或失败）都记一条 [`Call`]，「记忆 → Jev」与 `decision.calls` 从这里读。
//!
//! 题型与答案（协议见 `model_provider::systemone`）：
//! - `choice`：`criteria` 为「选项 → 什么时候选它」，2 个以上；答案 `choice` + 各选项概率。
//! - `score`：`criteria` 为 2–10 个从低到高的等级；答案 `score`（等级序号，可落在两级之间）+ 各级概率。
//! - `noul`：`criteria` 为 `true` / `false` 各自的条件；答案 `noul` 为「是」的概率。条件不写清楚时约 0.5，没有区分度。
//!
//! `state` 是任意 JSON，题目的 `instructions` 按字段名引用它（如「只看 segments.s0」）。
//! 全局设置在 `~/.berth/decision.json`（档案名 + 模型，留空自动）。

use std::collections::BTreeMap;
use std::io::{self, Write as _};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::model_provider::systemone;

const SETTINGS_FILE: &str = "decision.json";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const ATTEMPTS: usize = 3;
const CALLS_FILE: &str = "calls.jsonl";
const CALLS_OLD_FILE: &str = "calls.1.jsonl";
/// 调用记录超过这么大就换一个文件，只留上一份。
// ponytail: 按大小轮换两份；要按项目长期保留再分文件。
const CALLS_MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    /// 服务商档案名；留空用第一个声明了决策端点的档案。Key 从档案凭据读，不写在这里。
    #[serde(default)]
    pub provider: String,
    /// 留空用该档案发现到的第一个模型。
    #[serde(default)]
    pub model: String,
}

fn settings_path() -> PathBuf {
    berth_tool_core::paths::berth_home_dir().join(SETTINGS_FILE)
}

/// 没有文件即「全部自动」；文件写错报错，不静默改用别的档案。
pub fn load_settings() -> Result<Settings, String> {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| format!("{SETTINGS_FILE} 无效：{error}")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn save_settings(settings: &Settings) -> Result<(), String> {
    let path = settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let mut bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    std::fs::write(path, bytes).map_err(|error| error.to_string())
}

/// 一道题。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Question {
    Choice { instructions: String, criteria: BTreeMap<String, String> },
    Score { instructions: String, criteria: Vec<String> },
    Noul { instructions: String, criteria: NoulCriteria },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoulCriteria {
    #[serde(rename = "true")]
    pub yes: String,
    #[serde(rename = "false")]
    pub no: String,
}

impl Question {
    pub fn noul(instructions: impl Into<String>, yes: impl Into<String>, no: impl Into<String>) -> Self {
        Self::Noul {
            instructions: instructions.into(),
            criteria: NoulCriteria { yes: yes.into(), no: no.into() },
        }
    }

    /// 发出前检查，Jev 对这些情况只回 HTTP 400。
    fn check(&self) -> Result<(), String> {
        let (instructions, problem) = match self {
            Self::Choice { instructions, criteria } => (instructions, criteria.len() < 2),
            Self::Score { instructions, criteria } => (instructions, !(2..=10).contains(&criteria.len())),
            Self::Noul { instructions, criteria } => (instructions, criteria.yes.trim().is_empty() || criteria.no.trim().is_empty()),
        };
        if instructions.trim().is_empty() {
            return Err("instructions 为空".to_owned());
        }
        if problem {
            return Err("criteria 不合要求（choice 至少 2 个选项，score 2–10 级，noul 要写清 true / false）".to_owned());
        }
        Ok(())
    }
}

/// 一道题的答案。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Answer {
    Choice {
        choice: String,
        confidence: f64,
        probabilities: BTreeMap<String, f64>,
    },
    Score {
        score: f64,
        confidence: f64,
        /// 等级序号 → 等级文字
        #[serde(default)]
        legend: BTreeMap<String, String>,
        probabilities: BTreeMap<String, f64>,
    },
    Noul {
        noul: f64,
    },
}

impl Answer {
    /// noul 题「是」的概率；别的题型为 `None`。
    pub fn noul(&self) -> Option<f64> {
        match self {
            Self::Noul { noul } => Some(*noul),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Response {
    /// 实际作答的模型版本（如 `jev-1.13.0`）
    pub model: String,
    pub answers: BTreeMap<String, Answer>,
    #[serde(default)]
    pub usage: Usage,
}

/// 为谁调：哪个项目（主项目路径）、哪个会话、第几轮。不相关的留空。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// 第几轮，从 0 起
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    /// 调用方，如 `knowledge.classify`；记录里按它筛选。
    pub caller: String,
    #[serde(default)]
    pub subject: Subject,
    pub state: Value,
    pub questions: BTreeMap<String, Question>,
}

/// 一次调用的记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Call {
    pub id: String,
    pub at: String,
    pub caller: String,
    #[serde(default)]
    pub subject: Subject,
    pub profile: String,
    pub model: String,
    pub state: Value,
    pub questions: BTreeMap<String, Question>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<BTreeMap<String, Answer>>,
    #[serde(default)]
    pub usage: Usage,
    pub ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 声明了决策端点的服务商档案。
#[derive(Debug, Clone, Serialize)]
pub struct Profile {
    #[serde(skip)]
    pub id: i32,
    pub name: String,
    pub models: Vec<String>,
}

pub async fn profiles(conn: &DatabaseConnection) -> Result<Vec<Profile>, String> {
    Ok(crate::db::service::model_provider_service::list_all(conn)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter_map(|provider| {
            let discovery = serde_json::from_str::<Value>(provider.discovery_json.as_deref()?).ok()?;
            discovery["endpoints"][systemone::PROTOCOL].as_object()?;
            let models = discovery["keyGroups"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|group| group["models"].as_array().into_iter().flatten())
                .filter_map(|model| model["id"].as_str().map(str::to_owned))
                .collect();
            Some(Profile { id: provider.id, name: provider.name, models })
        })
        .collect())
}

/// 按全局设置选好的档案与模型；一批请求先 `resolve` 一次，再逐个 `decide`。
#[derive(Debug, Clone)]
pub struct Decider {
    provider: i32,
    /// 档案名，报错和界面里显示
    pub name: String,
    pub model: String,
}

pub async fn resolve(conn: &DatabaseConnection) -> Result<Decider, String> {
    let settings = load_settings()?;
    let profile = profiles(conn)
        .await?
        .into_iter()
        .find(|profile| settings.provider.is_empty() || profile.name == settings.provider)
        .ok_or_else(|| match settings.provider.as_str() {
            "" => "没有声明决策端点的服务商档案".to_owned(),
            name => format!("服务商档案「{name}」不存在或没有决策端点"),
        })?;
    let model = Some(settings.model)
        .filter(|model| !model.is_empty())
        .or_else(|| profile.models.into_iter().next())
        .ok_or_else(|| format!("决策档案「{}」没有模型", profile.name))?;
    Ok(Decider { provider: profile.id, name: profile.name, model })
}

impl Decider {
    /// 判别一次，超时或断连重试（服务端偶尔断开，A0 实测约 1%）；结果与出错都记进调用记录。
    pub async fn decide(&self, conn: &DatabaseConnection, request: &Request) -> Result<Response, String> {
        let started = Instant::now();
        let outcome = self.send(conn, request).await;
        let (model, answers, usage, error) = match &outcome {
            Ok(response) => (response.model.clone(), Some(response.answers.clone()), response.usage.clone(), None),
            Err(error) => (self.model.clone(), None, Usage::default(), Some(error.clone())),
        };
        let call = Call {
            id: uuid::Uuid::new_v4().simple().to_string()[..12].to_owned(),
            at: chrono::Utc::now().to_rfc3339(),
            caller: request.caller.clone(),
            subject: request.subject.clone(),
            profile: self.name.clone(),
            model,
            state: request.state.clone(),
            questions: request.questions.clone(),
            answers,
            usage,
            ms: started.elapsed().as_millis() as u64,
            error,
        };
        if let Err(error) = record(&call) {
            tracing::warn!("[decision] 调用记录写入失败：{error}");
        }
        outcome
    }

    async fn send(&self, conn: &DatabaseConnection, request: &Request) -> Result<Response, String> {
        if request.questions.is_empty() {
            return Err("没有题目".to_owned());
        }
        for (key, question) in &request.questions {
            question.check().map_err(|error| format!("题目 {key}：{error}"))?;
        }
        let questions = serde_json::to_value(&request.questions).map_err(|error| error.to_string())?;
        let mut error = String::new();
        for attempt in 0..ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            match systemone::evaluate(conn, self.provider, &self.model, request.state.clone(), questions.clone(), REQUEST_TIMEOUT)
                .await
            {
                Ok(value) => {
                    return serde_json::from_value(value).map_err(|error| format!("决策档案「{}」：响应格式不对：{error}", self.name))
                }
                Err(failure) => error = failure.to_string(),
            }
        }
        Err(format!("决策档案「{}」：{error}", self.name))
    }
}

static CALLS_LOCK: Mutex<()> = Mutex::new(());

fn record(call: &Call) -> io::Result<()> {
    let _guard = CALLS_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = crate::platform::paths::berth_decisions_root();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(CALLS_FILE);
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > CALLS_MAX_BYTES) {
        std::fs::rename(&path, dir.join(CALLS_OLD_FILE))?;
    }
    let mut line = serde_json::to_vec(call)?;
    line.push(b'\n');
    std::fs::OpenOptions::new().create(true).append(true).open(path)?.write_all(&line)
}

/// 最近的调用，新的在前；`project` 只留这个项目的（主项目路径）。坏行跳过。
pub fn calls(project: Option<&str>, limit: usize) -> Vec<Call> {
    let dir = crate::platform::paths::berth_decisions_root();
    let project = project.map(|project| project.trim_end_matches('/'));
    let mut calls: Vec<Call> = [CALLS_OLD_FILE, CALLS_FILE]
        .iter()
        .filter_map(|name| std::fs::read_to_string(dir.join(name)).ok())
        .flat_map(|text| text.lines().filter_map(|line| serde_json::from_str::<Call>(line).ok()).collect::<Vec<_>>())
        .filter(|call| project.is_none_or(|project| call.subject.project.as_deref().map(|own| own.trim_end_matches('/')) == Some(project)))
        .collect();
    calls.reverse();
    calls.truncate(limit);
    calls
}

/// runtime bridge `decision.*`：
/// - `settings`（设置 + 可选档案）、`setSettings`；
/// - `evaluate`：按全局设置判别一次，参数即 [`Request`]（`caller` 缺省为 `manual`）；
/// - `calls`：调用记录，`{project?, limit?}`。
pub async fn dispatch(conn: &DatabaseConnection, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "decision.settings" => {
            let (settings, error) = match load_settings() {
                Ok(settings) => (Some(settings), None),
                Err(error) => (None, Some(error)),
            };
            Ok(json!({ "settings": settings, "error": error, "profiles": profiles(conn).await? }))
        }
        "decision.setSettings" => {
            let settings: Settings =
                serde_json::from_value(params["settings"].clone()).map_err(|error| format!("设置无效：{error}"))?;
            save_settings(&settings)?;
            Ok(json!(settings))
        }
        "decision.evaluate" => {
            let mut params = params.clone();
            if params.get("caller").is_none() {
                params["caller"] = json!("manual");
            }
            let request: Request = serde_json::from_value(params).map_err(|error| format!("请求无效：{error}"))?;
            let decider = resolve(conn).await?;
            let result = decider.decide(conn, &request).await?;
            Ok(json!({ "profile": decider.name, "model": decider.model, "result": result }))
        }
        "decision.calls" => {
            let project = params.get("project").and_then(Value::as_str).map(str::to_owned);
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
            let calls = tokio::task::spawn_blocking(move || calls(project.as_deref(), limit))
                .await
                .map_err(|error| error.to_string())?;
            Ok(json!(calls))
        }
        _ => Err(format!("unsupported decision operation: {method}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn questions_and_answers_match_the_wire_format() {
        let question: Question =
            serde_json::from_value(json!({"type": "noul", "instructions": "同意吗", "criteria": {"true": "是", "false": "否"}}))
                .unwrap();
        assert_eq!(question, Question::noul("同意吗", "是", "否"));
        assert!(Question::noul("x", "是", " ").check().is_err());
        assert!(serde_json::from_value::<Question>(json!({"type": "score", "instructions": "x", "criteria": ["低"]}))
            .unwrap()
            .check()
            .is_err());

        // 实测响应（jev-1.13.0）。
        let response: Response = serde_json::from_value(json!({
            "model": "jev-1.13.0",
            "answers": {
                "a": {"type": "noul", "noul": 0.98},
                "b": {"type": "score", "score": 2, "confidence": 1, "legend": {"0": "反对", "2": "同意"}, "probabilities": {"0": 0, "2": 1}},
                "c": {"type": "choice", "choice": "approve", "confidence": 1, "probabilities": {"approve": 1, "reject": 0}}
            },
            "usage": {"input_tokens": 392, "output_tokens": 60}
        }))
        .unwrap();
        assert_eq!(response.answers["a"].noul(), Some(0.98));
        assert_eq!(response.answers["b"].noul(), None);
        assert_eq!(response.usage.input_tokens, 392);
    }
}
