//! 会话分类：只收下一个 Agent 不知道就会做错、或要你再说一遍的东西——
//! 纠正（你的要求、偏好）、坑（带原因的报错）、决定（你批准的长期规则、设计、选型）。
//! 会话里本来就有的过程（思路、执行）不收。命中的原文由 [`super::journal`] 写进 `记录/<类名>.md`。
//! 配置 `~/.berth/classifier.json`（[`Config`]）。这里只有纯逻辑（切段、出题、按答案分流）；调 Jev 与触发在 GUI 宿主。
//!
//! 按会话页的一问一答（[`super::exchanges`]）出题，一问一次请求。`state`（字段名即题目里引用的名字）：
//! - `prompt`：这一问的提问；
//! - `segments`：要判别的段，`prompt`（去掉复制进来的引用，只留你自己的话）、`error1…`（出错的工具调用）、
//!   `answer1…`（回答按 Markdown 小节切）；过程里的说明文字不判（多是子 Agent 汇报、进度播报）；
//! - `previous_answer`：上一问回答的最后一段（「可以」「确认」批准的通常是它）；
//! - `next_prompt`：下一问的提问，判断方案是否被采纳。

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::ops::Range;
use std::path::Path;

use pulldown_cmark::{Event, Options, Parser, Tag};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::exchanges::Exchange;

pub const CONFIG_FILE: &str = "classifier.json";
/// 配置格式版本：低于它的文件，内置类别的问法换成当前默认（问法引用的字段名变过）。
/// 3：只留纠正、坑、决定三类，决定改由批准题判（只认长期有效的决定）。
const VERSION: u32 = 3;
const SEGMENT_CHARS: usize = 1500;
/// 短于这个字数的段不判（「好的」「继续」）。
const MIN_SEGMENT_CHARS: usize = 15;
const NEXT_PROMPT_CHARS: usize = 400;
const ERROR_INPUT_CHARS: usize = 300;
const ERROR_OUTPUT_CHARS: usize = 600;
/// 批准题在请求与答案里的键。
const APPROVAL: &str = "approval";
const DECISION: &str = "decision";

/// 段来自一问里的哪个字段；类别的 `on` 用这些名字。
pub const PROMPT: &str = "prompt";
pub const ERRORS: &str = "errors";
pub const ANSWER: &str = "answer";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub enabled: bool,
    pub categories: Vec<Category>,
    /// 用户这条消息是否批准了上一问的提议：命中记一条决定。
    #[serde(default)]
    pub approval: Approval,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub question: String,
    #[serde(rename = "true")]
    pub when_true: String,
    #[serde(rename = "false")]
    pub when_false: String,
    pub threshold: f64,
}

impl Default for Approval {
    fn default() -> Self {
        Self {
            question: "用户的提问（`prompt`）是否批准了上一问回答（`previous_answer`）里的一项**长期有效的决定**：产品或设计规则、架构或方案选型、以后都要遵守的约定？".to_owned(),
            when_true: "`previous_answer` 提出了明确的规则、设计或选型，用户表示同意、确认或选定（如「可以」「确认」「按这个来」）。".to_owned(),
            when_false: "被同意的只是执行计划、下一步操作、验证步骤、工作汇报或一次性的任务安排；或者用户在提新需求、纠正、追问。".to_owned(),
            // A5 实测：0.80 留下产品会话 12 条真决定，「同意执行 / 提交」类都在 0.55 以下。
            threshold: 0.80,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    /// 一句话说明这一类记什么，设置页显示。
    #[serde(default)]
    pub description: String,
    /// 关掉的类不出题。
    #[serde(default = "yes")]
    pub enabled: bool,
    pub question: String,
    /// Noul 判定标准：不写清楚时 Jev 输出约 0.5，没有区分度。
    #[serde(rename = "true")]
    pub when_true: String,
    #[serde(rename = "false")]
    pub when_false: String,
    pub threshold: f64,
    /// 判哪些字段的段：`prompt` / `steps` / `errors` / `answer`。
    #[serde(default)]
    pub on: Vec<String>,
    /// 只判会话最后几问（未决问题多半在后面被解决）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turns: Option<usize>,
}

fn yes() -> bool {
    true
}

impl Default for Config {
    /// 阈值来自 A4 / A5 实测（`.berth/tasks/archive/2026-10/10-14-session-candidates/prd.md`）。
    fn default() -> Self {
        let category = |id: &str, name: &str, question: &str, yes: &str, no: &str, threshold, on: &[&str]| Category {
            id: id.to_owned(),
            name: name.to_owned(),
            description: default_description(id).to_owned(),
            enabled: true,
            question: question.to_owned(),
            when_true: yes.to_owned(),
            when_false: no.to_owned(),
            threshold,
            on: on.iter().map(|field| (*field).to_owned()).collect(),
            last_turns: None,
        };
        Self {
            version: VERSION,
            enabled: false,
            categories: vec![
                category(
                    "correction", "纠正",
                    "这一段是否是用户纠正 Agent 的做法，或提出以后都要遵守的要求、偏好？",
                    "用户指出 Agent 做错了、不该这样做，或给出长期规则、偏好。",
                    "一般需求、提问、确认、闲聊。",
                    0.85, &[PROMPT],
                ),
                category(
                    "pitfall", "坑",
                    "这一段是否记录了一个具体的错误或 bug，并给出了原因或修法？",
                    "有具体的报错或异常现象，并写明根因或修复方式。",
                    "一般性描述、需求，或没有具体错误。",
                    0.90, &[ERRORS, ANSWER],
                ),
                // 不按段出题：由批准题（[`Approval`]）判，命中记被批准的上一问回答。
                category(DECISION, "决定", "", "", "", 0.80, &[]),
            ],
            approval: Approval::default(),
        }
    }
}

/// 内置类别的说明；旧配置文件没有说明时也用它补上。
fn default_description(id: &str) -> &'static str {
    match id {
        "correction" => "你纠正 Agent 的做法，或提出以后都要遵守的要求",
        "pitfall" => "带原因或修法的具体报错、bug",
        DECISION => "你批准的长期决定：规则、设计、选型（同意执行、提交不算）",
        _ => "",
    }
}

/// 旧版本的文件：类别换成当前内置的（问法、阈值都变过），只保留各类的开关；补上说明。
fn upgrade(config: &mut Config) {
    if config.version < VERSION {
        let defaults = Config::default();
        let old = std::mem::take(&mut config.categories);
        config.categories = defaults
            .categories
            .into_iter()
            .map(|mut category| {
                if let Some(old) = old.iter().find(|old| old.id == category.id) {
                    category.enabled = old.enabled;
                }
                category
            })
            .collect();
        config.approval = defaults.approval;
        config.version = VERSION;
    }
    for category in config.categories.iter_mut().filter(|category| category.description.is_empty()) {
        category.description = default_description(&category.id).to_owned();
    }
}

/// 读 `<home>/classifier.json`；没有就写出默认配置（关闭状态）供用户改。文件写错返回 `InvalidData`。
pub fn load_config(home: &Path) -> io::Result<Config> {
    let path = home.join(CONFIG_FILE);
    match fs::read(&path) {
        Ok(bytes) => {
            let mut config: Config = serde_json::from_slice(&bytes)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, format!("{}: {error}", path.display())))?;
            upgrade(&mut config);
            Ok(config)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let config = Config::default();
            fs::create_dir_all(home)?;
            fs::write(&path, serde_json::to_vec_pretty(&config)?)?;
            Ok(config)
        }
        Err(error) => Err(error),
    }
}

/// 设置页保存配置：类别 id 非空且不重复、阈值在 0–1 之间，否则 `InvalidInput`。
pub fn save_config(home: &Path, config: &Config) -> io::Result<()> {
    let invalid = |message: String| io::Error::new(io::ErrorKind::InvalidInput, message);
    let mut ids = std::collections::HashSet::new();
    for category in &config.categories {
        if category.id.is_empty() || !ids.insert(category.id.as_str()) {
            return Err(invalid(format!("类别 id 为空或重复：{}", category.id)));
        }
        if !(0.0..=1.0).contains(&category.threshold) {
            return Err(invalid(format!("「{}」的阈值要在 0 到 1 之间", category.name)));
        }
    }
    if !(0.0..=1.0).contains(&config.approval.threshold) {
        return Err(invalid("「批准」的阈值要在 0 到 1 之间".to_owned()));
    }
    let mut bytes = serde_json::to_vec_pretty(config)?;
    bytes.push(b'\n');
    crate::tasks::fsutil::atomic_write(&home.join(CONFIG_FILE), &bytes).map_err(|error| io::Error::other(error.message))
}

/// 一问里交给 Jev 判别的一段。
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    /// `prompt`、`step1`、`error1`、`answer1`…
    pub key: String,
    /// 来自哪个字段（[`PROMPT`] / [`ERRORS`] / [`ANSWER`]）
    pub field: &'static str,
    pub text: String,
}

/// 状态行（钩子输出、`xxx ✓`）：一行、不长、没有句读。
// ponytail: 只认句读；带标点的状态行会漏过，到时按来源（system / hook 块）区分。
fn is_status_line(text: &str) -> bool {
    !text.contains('\n') && text.chars().count() < 40 && !text.contains(['。', '，', '：', '？', '！', '.', ',', ':', '?', '!'])
}

/// 提问里你自己的话：从 Berth 复制进来的引用（`File:` / `Terminal:` / `URL:` 开头，`---` 后是摘录，
/// 见 `src/pointer/serialize.ts`）不算，只留最后一段。
// ponytail: 摘录与正文之间只靠空行区分；你在引用后写了多段时只留最后一段。
pub fn own_words(prompt: &str) -> &str {
    let prompt = prompt.trim();
    let quoted = ["File: ", "Terminal: ", "URL: "].iter().any(|head| prompt.starts_with(head)) && prompt.contains("\n---\n");
    if !quoted {
        return prompt;
    }
    let body = &prompt[prompt.find("\n---\n").map_or(0, |at| at + 5)..];
    body.rsplit_once("\n\n").map_or("", |(_, last)| last.trim())
}

/// 去掉开头的状态行段落（有的 Agent 把钩子输出和回答写在同一个文字块里）。
fn strip_leading_status(mut text: &str) -> &str {
    loop {
        text = text.trim_start();
        match text.split_once("\n\n") {
            Some((first, rest)) if is_status_line(first.trim()) => text = rest,
            _ => return text,
        }
    }
}

fn chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// 顶层块（段落、列表、表格、代码、标题）在原文里的位置；`true` 表示标题。
fn top_blocks(text: &str) -> Vec<(Range<usize>, bool)> {
    let mut blocks = Vec::new();
    let mut depth = 0usize;
    let mut start = (0, false);
    for (event, range) in Parser::new_ext(text, Options::ENABLE_TABLES).into_offset_iter() {
        match event {
            Event::Start(tag) => {
                if depth == 0 {
                    start = (range.start, matches!(tag, Tag::Heading { .. }));
                }
                depth += 1;
            }
            Event::End(_) => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    blocks.push((start.0..range.end, start.1));
                }
            }
            // 分隔线等没有起止的顶层块
            Event::Rule if depth == 0 => blocks.push((range, false)),
            _ => {}
        }
    }
    blocks
}

/// 按 Markdown 结构切：每个标题起一节；一节超过上限时在块边界再切，
/// 以「：」结尾的引导语跟着下一块走；列表、表格、代码块不拆，单块超长时截断。
pub fn split_markdown(text: &str) -> Vec<String> {
    let text = text.trim();
    let mut chunks: Vec<String> = Vec::new();
    let mut current: Option<Range<usize>> = None;
    let flush = |current: &mut Option<Range<usize>>, chunks: &mut Vec<String>| {
        if let Some(range) = current.take() {
            chunks.push(chars(text[range].trim(), SEGMENT_CHARS));
        }
    };
    for (range, heading) in top_blocks(text) {
        if let Some(open) = &current {
            let lead_in = text[open.clone()].trim_end().ends_with(['：', ':']);
            let too_long = text[open.start..range.end].chars().count() > SEGMENT_CHARS;
            if !lead_in && (heading || too_long) {
                flush(&mut current, &mut chunks);
            }
        }
        current = Some(current.map_or(range.clone(), |open| open.start..range.end));
    }
    flush(&mut current, &mut chunks);
    chunks.retain(|chunk| !chunk.is_empty());
    chunks
}

/// 一问拆成要判别的段：提问（你自己的话）一段，回答按 Markdown 小节切，出错的工具调用各一段；
/// 太短的、状态行不判。
pub fn segments(exchange: &Exchange) -> Vec<Segment> {
    let mut segments: Vec<Segment> = Vec::new();
    // 键按字段内的序号（过滤后）：`step1`、`step2`…；提问只有一段，就叫 `prompt`。
    let mut push = |field: &'static str, text: String| {
        let text = text.trim().to_owned();
        if text.chars().count() < MIN_SEGMENT_CHARS || is_status_line(&text) {
            return;
        }
        let prefix = match field {
            PROMPT => "",
            ERRORS => "error",
            _ => ANSWER,
        };
        let key = match prefix {
            "" => PROMPT.to_owned(),
            _ => format!("{prefix}{}", segments.iter().filter(|segment| segment.field == field).count() + 1),
        };
        segments.push(Segment { key, field, text });
    };
    if let Some(prompt) = &exchange.prompt {
        push(PROMPT, chars(own_words(prompt), SEGMENT_CHARS));
    }
    for error in &exchange.errors {
        push(
            ERRORS,
            format!(
                "工具 {} 出错\n输入：{}\n输出：{}",
                error.tool,
                chars(error.input.trim(), ERROR_INPUT_CHARS),
                chars(error.output.trim(), ERROR_OUTPUT_CHARS)
            ),
        );
    }
    for text in exchange.answer.iter().flat_map(|answer| split_markdown(strip_leading_status(answer))) {
        push(ANSWER, text);
    }
    segments
}

/// 上一问回答的最后一段：批准的通常是它。
pub fn last_answer_part(exchange: &Exchange) -> Option<String> {
    exchange.answer.as_deref().and_then(|answer| split_markdown(answer).pop())
}

/// `state.segments`：段的键 → 原文。
pub fn segment_map(segments: &[Segment]) -> Map<String, Value> {
    segments.iter().map(|segment| (segment.key.clone(), json!(segment.text))).collect()
}

/// 一问一次请求：每段 × 适用的类各一道独立 Noul（`<段>.<类>`），有上一问回答时再加一道批准题（`approval`）。
/// `from_end`：这一问距会话末尾第几问（最后一问为 0）。没有题时返回 `None`（Jev 拒绝空题集）。
pub fn request(
    config: &Config,
    prompt: &str,
    previous_answer: Option<&str>,
    segments: &[Segment],
    next_prompt: &str,
    from_end: usize,
) -> Option<(Value, Value)> {
    let mut questions = Map::new();
    let prompt = prompt.trim();
    let deciding = config.categories.iter().any(|category| category.enabled && category.id == DECISION);
    if deciding && previous_answer.is_some() && !prompt.is_empty() {
        let approval = &config.approval;
        questions.insert(
            APPROVAL.to_owned(),
            json!({
                "type": "noul",
                "instructions": approval.question,
                "criteria": {"true": approval.when_true, "false": approval.when_false},
            }),
        );
    }
    for segment in segments {
        for category in &config.categories {
            let recent = category.last_turns.is_none_or(|last| from_end < last);
            if !category.enabled || !recent || !category.on.iter().any(|field| field == segment.field) {
                continue;
            }
            questions.insert(
                format!("{}.{}", segment.key, category.id),
                json!({
                    "type": "noul",
                    "instructions": format!("只看 `segments.{}` 这一段。{}", segment.key, category.question),
                    "criteria": {"true": category.when_true, "false": category.when_false},
                }),
            );
        }
    }
    if questions.is_empty() {
        return None;
    }
    let mut state = json!({
        "prompt": chars(prompt, SEGMENT_CHARS),
        "segments": segment_map(segments),
        "next_prompt": chars(next_prompt, NEXT_PROMPT_CHARS),
    });
    if let Some(previous) = previous_answer {
        state["previous_answer"] = json!(previous);
    }
    Some((state, Value::Object(questions)))
}

/// 一条命中（还没带来源信息）。
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub category: String,
    pub text: String,
    pub score: f64,
}

/// 按 Jev 答案（键 → noul「是」的概率）过阈值的段；批准题命中时记被批准的上一问回答，
/// 用户说了更多（15 字以上）就把原话附在后面。同一段原文只记一类（分数高的）。
pub fn route(
    config: &Config,
    segments: &[Segment],
    scores: &BTreeMap<String, f64>,
    prompt: &str,
    previous_answer: Option<&str>,
) -> Vec<Hit> {
    let mut hits = Vec::new();
    for segment in segments {
        for category in &config.categories {
            let score = scores.get(&format!("{}.{}", segment.key, category.id)).copied();
            if let Some(score) = score.filter(|score| *score >= category.threshold) {
                hits.push(Hit {
                    category: category.id.clone(),
                    text: segment.text.clone(),
                    score,
                });
            }
        }
    }
    let has_decision = config.categories.iter().any(|category| category.enabled && category.id == DECISION);
    let approved = scores.get(APPROVAL).copied().filter(|score| *score >= config.approval.threshold);
    if let (true, Some(score), Some(previous)) = (has_decision, approved, previous_answer) {
        let prompt = own_words(prompt);
        let text = if prompt.chars().count() >= MIN_SEGMENT_CHARS {
            format!("{previous}\n\n用户：{prompt}")
        } else {
            previous.to_owned()
        };
        hits.push(Hit {
            category: DECISION.to_owned(),
            text: chars(&text, SEGMENT_CHARS),
            score,
        });
    }
    hits.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut seen = std::collections::HashSet::new();
    hits.retain(|hit| seen.insert(hit.text.clone()));
    hits
}

#[cfg(test)]
mod tests {
    use super::super::exchanges::ToolError;
    use super::*;
    use chrono::{DateTime, Utc};

    fn seg(key: &str, field: &'static str, text: &str) -> Segment {
        Segment { key: key.into(), field, text: text.into() }
    }

    fn exchange(prompt: &str, steps: &[&str], answer: &str) -> Exchange {
        Exchange {
            index: 1,
            prompt: Some(prompt.into()),
            steps: steps.iter().map(|step| (*step).to_owned()).collect(),
            errors: vec![ToolError { tool: "bash".into(), input: "cat missing.txt".into(), output: "No such file or directory".into() }],
            answer: Some(answer.into()),
            latest: DateTime::<Utc>::UNIX_EPOCH,
        }
    }

    #[test]
    fn save_config_rejects_bad_thresholds_and_round_trips() {
        let home = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.categories[0].threshold = 1.5;
        assert!(save_config(home.path(), &config).is_err());
        config.categories[0].threshold = 0.7;
        config.enabled = true;
        save_config(home.path(), &config).unwrap();
        assert_eq!(load_config(home.path()).unwrap(), config);
    }

    #[test]
    fn old_files_get_the_current_categories_but_keep_switches() {
        let home = tempfile::tempdir().unwrap();
        let old = json!({"enabled": true, "categories": [
            {"id": "pitfall", "name": "坑", "question": "旧问法", "true": "t", "false": "f", "threshold": 0.7, "source": "assistant", "enabled": false},
            {"id": "progress", "name": "执行", "question": "q", "true": "t", "false": "f", "threshold": 0.9, "kind": "handoff"}
        ], "affirm": ["可以"]});
        fs::write(home.path().join(CONFIG_FILE), old.to_string()).unwrap();
        let config = load_config(home.path()).unwrap();
        let ids: Vec<&str> = config.categories.iter().map(|category| category.id.as_str()).collect();
        assert_eq!(ids, ["correction", "pitfall", DECISION]);
        let pitfall = &config.categories[1];
        assert_eq!((pitfall.enabled, pitfall.threshold, config.enabled), (false, 0.90, true));
        assert_eq!(pitfall.on, [ERRORS, ANSWER]);
        assert!(config.approval.question.contains("长期有效"));
        assert_eq!(config.version, VERSION);
    }

    #[test]
    fn markdown_splits_on_headings_keeps_lead_ins_and_blocks_whole() {
        let long = "这是一段说明。".repeat(250);
        let text = format!("## 结论\n\n第一节正文。\n\n## 原因\n\n原因如下：\n\n- 一\n- 二\n\n```\na\n\nb\n```\n\n{long}");
        let chunks = split_markdown(&text);
        assert_eq!(chunks[0], "## 结论\n\n第一节正文。");
        // 引导语跟着列表；代码块里的空行不拆；超长的正文另起一段。
        assert_eq!(chunks[1], "## 原因\n\n原因如下：\n\n- 一\n- 二\n\n```\na\n\nb\n```");
        assert_eq!(chunks[2].chars().count(), SEGMENT_CHARS);
        assert_eq!(chunks.len(), 3);
        assert_eq!(split_markdown("一句话。"), ["一句话。"]);
    }

    #[test]
    fn own_words_drop_pasted_references() {
        let pasted = "File: `/a/07.pptx`\nElements: `/slide[9]/shape[@id=5]` (preview element paths)\n---\n摘录第一段\n\n摘录第二段\n\n\n做的 ppt 是给评委看的，不是给我看的！";
        assert_eq!(own_words(pasted), "做的 ppt 是给评委看的，不是给我看的！");
        assert_eq!(own_words("File: `/a`\n---\n只有摘录"), "");
        assert_eq!(own_words("  以后只用 bash  "), "以后只用 bash");
    }

    #[test]
    fn segments_are_the_prompt_tool_errors_and_answer_sections() {
        let got = segments(&exchange(
            "为什么 cat missing.txt 报错，怎么修？",
            &["Message Type: FINAL_ANSWER\nPayload:\n子 Agent 汇报了很多进度内容。"],
            "Trellis SessionStart ✓\n\n原因是路径不对，改用绝对路径即可。",
        ));
        let keys: Vec<(&str, &str)> = got.iter().map(|segment| (segment.key.as_str(), segment.field)).collect();
        // 过程说明不判；开头的状态行去掉。
        assert_eq!(keys, [("prompt", PROMPT), ("error1", ERRORS), ("answer1", ANSWER)]);
        assert_eq!(got[1].text, "工具 bash 出错\n输入：cat missing.txt\n输出：No such file or directory");
        assert_eq!(got[2].text, "原因是路径不对，改用绝对路径即可。");
    }

    #[test]
    fn request_asks_each_segment_only_the_categories_that_apply() {
        let config = Config::default();
        let prompt = "不要固定 4096 tokens，以后都按模型上限来";
        let segs = [
            seg("prompt", PROMPT, prompt),
            seg("error1", ERRORS, "工具 bash 出错\n输入：x\n输出：y"),
            seg("answer1", ANSWER, "已改为按模型上限设置输出长度。"),
        ];
        let (state, questions) = request(&config, prompt, None, &segs, "可以", 5).unwrap();
        let mut keys: Vec<&String> = questions.as_object().unwrap().keys().collect();
        keys.sort();
        // 纠正只判提问，坑判回答与出错的工具调用；决定不按段出题；没有上一问不问批准。
        assert_eq!(keys, ["answer1.pitfall", "error1.pitfall", "prompt.correction"]);
        assert_eq!(state["prompt"], prompt);
        assert!(questions["answer1.pitfall"]["instructions"].as_str().unwrap().starts_with("只看 `segments.answer1`"));
        assert!(request(&config, "", None, &[], "", 0).is_none());

        // 「确认」太短不成段，但仍问它是否批准了上一问的决定。
        let (state, questions) = request(&config, "确认", Some("任务只有三个状态。"), &[], "", 0).unwrap();
        assert_eq!(questions.as_object().unwrap().keys().collect::<Vec<_>>(), ["approval"]);
        assert_eq!(state["previous_answer"], "任务只有三个状态。");

        // 关掉的类不出题；关掉「决定」也就不问批准。
        let mut off = Config::default();
        off.categories.iter_mut().for_each(|category| category.enabled = category.id == "pitfall");
        let (_, questions) = request(&off, prompt, Some("x"), &segs, "", 5).unwrap();
        assert!(questions.get("prompt.correction").is_none() && questions.get("approval").is_none());
        assert!(questions.get("answer1.pitfall").is_some());
    }

    #[test]
    fn route_keeps_hits_over_threshold_records_approvals_and_dedupes() {
        let config = Config::default();
        let scores = |pairs: &[(&str, f64)]| pairs.iter().map(|(key, score)| (key.to_string(), *score)).collect::<BTreeMap<_, _>>();
        let segs = [seg("answer1", ANSWER, "报错 E0369：TurnRole 没有 PartialEq，改用 matches!。")];
        let hits = route(&config, &segs, &scores(&[("answer1.pitfall", 0.93)]), "", None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].category, "pitfall");
        assert!(route(&config, &segs, &scores(&[("answer1.pitfall", 0.89)]), "", None).is_empty());

        // 批准：记上一问的决定；用户说得多就附上原话；低于阈值、没有上一问都不记。
        let approved = scores(&[("approval", 0.95)]);
        let short = route(&config, &[], &approved, "确认", Some("任务只有三个状态。"));
        assert_eq!((short[0].category.as_str(), short[0].text.as_str(), short[0].score), (DECISION, "任务只有三个状态。", 0.95));
        let long = "可以，那收敛一下，只做买方普通协商和卖方隐瞒两个场景";
        assert_eq!(route(&config, &[], &approved, long, Some("x"))[0].text, format!("x\n\n用户：{long}"));
        assert!(route(&config, &[], &scores(&[("approval", 0.7)]), "可以", Some("x")).is_empty());
        assert!(route(&config, &[], &approved, "可以", None).is_empty());

        // 同一段原文命中两类只记分数高的。
        let text = "原因是缓存只留一个文档。";
        let both = [seg("prompt", PROMPT, text), seg("answer1", ANSWER, text)];
        let hits = route(&config, &both, &scores(&[("prompt.correction", 0.9), ("answer1.pitfall", 0.97)]), "", None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].category, "pitfall");
    }
}
