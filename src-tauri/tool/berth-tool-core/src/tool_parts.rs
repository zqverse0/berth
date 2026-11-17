//! 会话里的一段可直接显示的内容（[`Part`]）：工具调用按 `sessions.json` 的 `tools` 声明，用完整参数
//! 算出种类、标题、命令、路径、增删行数与计划条目；文字在文字层面截断并写明截掉多少。
//! 这里只有「按声明取字段」与通用格式解析（行差异、补丁），不认任何工具名或 Agent 名。

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sessions::{select_relative, value_bool, value_text, Selector};

/// 单块文字最多显示的字数，超出的写进 `cut`。
pub const PART_TEXT_CHARS: usize = 8000;
/// 标题最多字数（一行）。
const TITLE_CHARS: usize = 120;
/// 与前端 `LINE_DIFF_LCS_BUDGET` 相同：改动窗口行数之积超过它就整窗算改动，不做精确 LCS。
const LINE_DIFF_BUDGET: usize = 1_000_000;

/// `sessions.json` 的 `tools.<原始工具名>`：工具参数里各项在哪（JSON pointer，可给 fallback 列表）。
/// 声明了 `items` 时，其余字段逐项先在条目里找、找不到再回参数根上找。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ToolSpec {
    /// 原样交给界面的种类，如 `command`、`read`、`edit`、`search`、`plan`、`question`、`delegate`。
    /// 只有 `plan` 影响这里的算法：条目进 `plan` 而不是正文。
    pub kind: String,
    #[serde(default)]
    pub title: Option<Selector>,
    #[serde(default)]
    pub text: Option<Selector>,
    #[serde(default)]
    pub command: Option<Selector>,
    #[serde(default)]
    pub path: Option<Selector>,
    #[serde(default)]
    pub old: Option<Selector>,
    #[serde(default)]
    pub new: Option<Selector>,
    /// 补丁文本（`*** Begin Patch` 格式或统一 diff），从中取路径与增删行数。
    #[serde(default)]
    pub patch: Option<Selector>,
    #[serde(default)]
    pub items: Option<Selector>,
    #[serde(default)]
    pub status: Option<Selector>,
    /// 为真表示放到后台跑的调用。
    #[serde(default)]
    pub background: Option<Selector>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PlanItem {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// 一段可直接显示的内容。`kind` 除工具声明的种类外还有 `text`、`thinking`、`image`、
/// `result`、`error`（工具结果）与 `tool`（没有声明的工具）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Part {
    pub role: String,
    pub kind: String,
    /// 原始工具名（工具调用）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// 工具调用 id，结果按它配回调用。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// `text` 截掉的字数。
    #[serde(skip_serializing_if = "is_zero")]
    pub cut: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub plan: Vec<PlanItem>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub background: bool,
    /// 这次调用加载的技能（宿主按 `skills` 声明标注，筛选用）。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}

/// 文字截到 [`PART_TEXT_CHARS`]，返回（显示的文字，截掉的字数）。
pub fn cut_text(text: &str) -> (String, usize) {
    match text.char_indices().nth(PART_TEXT_CHARS) {
        Some((end, _)) => (text[..end].to_owned(), text[end..].chars().count()),
        None => (text.to_owned(), 0),
    }
}

/// 文字类内容（正文、思考、工具结果）。空文字返回 `None`。
pub fn text_part(role: &str, kind: &str, call: Option<String>, text: &str) -> Option<Part> {
    if text.trim().is_empty() && call.is_none() {
        return None;
    }
    let (shown, cut) = cut_text(text);
    Some(Part {
        role: role.to_owned(),
        kind: kind.to_owned(),
        call,
        text: (!shown.is_empty()).then_some(shown),
        cut,
        ..Part::default()
    })
}

/// 一次工具调用。`input` 是完整参数；是 JSON 字符串时先解开。没有声明的工具给工具名和截断后的参数原文。
pub fn tool_part(
    tools: &BTreeMap<String, ToolSpec>,
    role: &str,
    name: &str,
    call: Option<String>,
    input: Option<&Value>,
) -> Part {
    let parsed = input.and_then(|value| {
        value
            .as_str()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .filter(|value| value.is_object() || value.is_array())
    });
    let root = parsed.as_ref().or(input).unwrap_or(&Value::Null);
    let mut part = Part {
        role: role.to_owned(),
        tool: Some(name.to_owned()),
        call,
        ..Part::default()
    };
    let Some(spec) = tools.get(name) else {
        part.kind = "tool".to_owned();
        part.title = Some(name.to_owned());
        if let Some(text) = input.and_then(value_text) {
            (part.text, part.cut) = shown(&text);
        }
        return part;
    };
    part.kind = spec.kind.clone();
    let items = items_of(root, spec.items.as_ref());
    let mut commands = Vec::new();
    let mut texts = Vec::new();
    let mut patches = Vec::new();
    let mut changes: Option<(u32, u32)> = None;
    for item in items {
        let field = |selector: Option<&Selector>| select_relative(Some(item), root, selector);
        for path in field(spec.path.as_ref()).iter().flat_map(strings) {
            push_unique(&mut part.paths, path);
        }
        let old = field(spec.old.as_ref()).and_then(|value| value_text(&value));
        let new = field(spec.new.as_ref()).and_then(|value| value_text(&value));
        if old.is_some() || new.is_some() {
            let (added, removed) =
                line_changes(old.as_deref().unwrap_or(""), new.as_deref().unwrap_or(""));
            let total = changes.get_or_insert((0, 0));
            total.0 += added;
            total.1 += removed;
        }
        if let Some(patch) = field(spec.patch.as_ref()).and_then(|value| value_text(&value)) {
            let parsed = parse_patch(&patch);
            for path in parsed.paths {
                push_unique(&mut part.paths, path);
            }
            let total = changes.get_or_insert((0, 0));
            total.0 += parsed.added;
            total.1 += parsed.removed;
            patches.push(patch);
        }
        if let Some(command) = field(spec.command.as_ref()).map(|value| strings(&value).join(" ")) {
            if !command.trim().is_empty() {
                commands.push(command);
            }
        }
        if let Some(text) = field(spec.text.as_ref()).and_then(|value| value_text(&value)) {
            if spec.kind == "plan" {
                part.plan.push(PlanItem {
                    text,
                    status: field(spec.status.as_ref()).and_then(|value| value_text(&value)),
                });
            } else if !text.trim().is_empty() {
                texts.push(text);
            }
        }
    }
    if let Some((added, removed)) = changes {
        part.added = Some(added);
        part.removed = Some(removed);
    }
    part.background = select_relative(None, root, spec.background.as_ref())
        .is_some_and(|value| value_bool(&value));
    part.title = select_relative(None, root, spec.title.as_ref())
        .and_then(|value| value_text(&value))
        .as_deref()
        .and_then(first_line)
        .or_else(|| commands.first().and_then(|command| first_line(command)))
        .or_else(|| (part.paths.len() == 1).then(|| clip(&part.paths[0])))
        .or_else(|| texts.first().and_then(|text| first_line(text)));
    let body = if !commands.is_empty() {
        commands.join("\n")
    } else if !texts.is_empty() {
        texts.join("\n")
    } else {
        patches.join("\n")
    };
    if !body.is_empty() {
        (part.text, part.cut) = shown(&body);
    }
    part
}

/// `items` 指向的数组逐项借用；没声明或不是数组时整份参数就是唯一一项。
fn items_of<'a>(root: &'a Value, selector: Option<&Selector>) -> Vec<&'a Value> {
    selector
        .into_iter()
        .flat_map(Selector::entries)
        .find_map(|pointer| {
            let found = if pointer.is_empty() {
                Some(root)
            } else if pointer.starts_with('/') {
                root.pointer(pointer)
            } else {
                root.get(pointer)
            };
            found
                .and_then(Value::as_array)
                .filter(|items| !items.is_empty())
        })
        .map(|items| items.iter().collect())
        .unwrap_or_else(|| vec![root])
}

fn shown(text: &str) -> (Option<String>, usize) {
    let (text, cut) = cut_text(text);
    ((!text.is_empty()).then_some(text), cut)
}

fn strings(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        other => value_text(other).into_iter().collect(),
    }
}

fn push_unique(values: &mut Vec<String>, value: String) {
    let value = value.trim().to_owned();
    if !value.is_empty() && !values.contains(&value) {
        values.push(value);
    }
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(clip)
}

fn clip(text: &str) -> String {
    match text.char_indices().nth(TITLE_CHARS) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_owned(),
    }
}

/// 旧 / 新文本的增删行数：去掉首尾相同的行后按行求 LCS（与前端 `estimateChangedLineStats` 同算法）。
pub fn line_changes(old: &str, new: &str) -> (u32, u32) {
    let lines = |text: &str| -> Vec<String> {
        if text.is_empty() {
            return Vec::new();
        }
        let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
        if lines.last().is_some_and(String::is_empty) {
            lines.pop();
        }
        lines
    };
    let (old, new) = (lines(old), lines(new));
    let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let old = &old[prefix..old.len() - suffix];
    let new = &new[prefix..new.len() - suffix];
    if old.is_empty() || new.is_empty() || old.len() * new.len() > LINE_DIFF_BUDGET {
        return (new.len() as u32, old.len() as u32);
    }
    // LCS 化为 LIS：旧文本逐行，按新文本里同内容行的位置倒序放进递增序列。
    let mut positions: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, line) in new.iter().enumerate() {
        positions.entry(line.as_str()).or_default().push(index);
    }
    let mut lis: Vec<usize> = Vec::new();
    for line in old {
        for &position in positions.get(line.as_str()).into_iter().flatten().rev() {
            let at = lis.partition_point(|&value| value < position);
            if at == lis.len() {
                lis.push(position);
            } else {
                lis[at] = position;
            }
        }
    }
    let common = lis.len();
    ((new.len() - common) as u32, (old.len() - common) as u32)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PatchStats {
    pub paths: Vec<String>,
    pub added: u32,
    pub removed: u32,
}

/// `*** Begin Patch` 格式与统一 diff 的文件路径、增删行数。
pub fn parse_patch(text: &str) -> PatchStats {
    let mut stats = PatchStats::default();
    for line in text.lines() {
        let path = [
            "*** Add File: ",
            "*** Update File: ",
            "*** Delete File: ",
            "+++ b/",
        ]
        .iter()
        .find_map(|prefix| line.strip_prefix(prefix));
        if let Some(path) = path {
            push_unique(&mut stats.paths, path.to_owned());
        } else if let Some(to) = line.strip_prefix("*** Move to: ") {
            // 改名：路径记新名字。
            stats.paths.pop();
            push_unique(&mut stats.paths, to.to_owned());
        } else if line.starts_with("+++") || line.starts_with("---") {
        } else if line.starts_with('+') {
            stats.added += 1;
        } else if line.starts_with('-') {
            stats.removed += 1;
        }
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tools(value: Value) -> BTreeMap<String, ToolSpec> {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn command_title_prefers_declared_description_and_keeps_full_command() {
        let tools = tools(json!({
            "Bash": {"kind": "command", "command": "/command", "title": "/description", "background": "/run_in_background"}
        }));
        let input = json!({"command": "cargo test\n--lib", "description": "跑测试", "run_in_background": true});
        let part = tool_part(&tools, "assistant", "Bash", Some("c1".into()), Some(&input));
        assert_eq!(part.kind, "command");
        assert_eq!(part.title.as_deref(), Some("跑测试"));
        assert_eq!(part.text.as_deref(), Some("cargo test\n--lib"));
        assert!(part.background);
        assert_eq!(part.call.as_deref(), Some("c1"));
    }

    #[test]
    fn json_string_arguments_are_parsed_and_command_arrays_joined() {
        let tools = tools(json!({
            "exec_command": {"kind": "command", "command": ["/cmd", "/command"]},
            "run_commands": {"kind": "command", "items": "/commands", "command": ""}
        }));
        let input = Value::String(r#"{"cmd":"rg foo","workdir":"/x"}"#.into());
        let part = tool_part(&tools, "assistant", "exec_command", None, Some(&input));
        assert_eq!(part.title.as_deref(), Some("rg foo"));
        let input = json!({"commands": ["ls", "pwd"]});
        let part = tool_part(&tools, "assistant", "run_commands", None, Some(&input));
        assert_eq!(part.text.as_deref(), Some("ls\npwd"));
        assert_eq!(part.title.as_deref(), Some("ls"));
    }

    #[test]
    fn edits_count_lines_from_full_old_and_new_text_per_item() {
        let tools = tools(json!({
            "Edit": {"kind": "edit", "path": "/file_path", "old": "/old_string", "new": "/new_string"},
            "edit": {"kind": "edit", "items": "/edits", "path": "/path", "old": "/oldText", "new": "/newText"},
            "Write": {"kind": "edit", "path": "/file_path", "new": "/content"}
        }));
        let old = "a\nb\nc\n".repeat(2000);
        let new = old.replacen("b\n", "B\nB2\n", 1);
        let input = json!({"file_path": "/r/x.rs", "old_string": old, "new_string": new});
        let part = tool_part(&tools, "assistant", "Edit", None, Some(&input));
        assert_eq!((part.added, part.removed), (Some(2), Some(1)));
        assert_eq!(part.paths, vec!["/r/x.rs"]);
        assert_eq!(part.title.as_deref(), Some("/r/x.rs"));
        assert_eq!(part.text, None);

        let input = json!({"path": "p.ts", "edits": [
            {"oldText": "x", "newText": "y"}, {"oldText": "1\n2", "newText": "1\n2\n3"}
        ]});
        let part = tool_part(&tools, "assistant", "edit", None, Some(&input));
        assert_eq!((part.added, part.removed), (Some(2), Some(1)));
        assert_eq!(part.paths, vec!["p.ts"]);

        let input = json!({"file_path": "n.md", "content": "a\nb\n"});
        let part = tool_part(&tools, "assistant", "Write", None, Some(&input));
        assert_eq!((part.added, part.removed), (Some(2), Some(0)));
    }

    #[test]
    fn patch_gives_paths_and_counts_including_moves() {
        let tools = tools(json!({"apply_patch": {"kind": "edit", "patch": ""}}));
        let patch = "*** Begin Patch\n*** Update File: a.rs\n@@\n-old\n+new\n+more\n*** Add File: b.rs\n+x\n*** Update File: c.rs\n*** Move to: d.rs\n*** End Patch\n";
        let part = tool_part(
            &tools,
            "assistant",
            "apply_patch",
            None,
            Some(&Value::String(patch.into())),
        );
        assert_eq!(part.paths, vec!["a.rs", "b.rs", "d.rs"]);
        assert_eq!((part.added, part.removed), (Some(3), Some(1)));
        assert_eq!(part.title, None);
        assert_eq!(part.text.as_deref(), Some(patch));
    }

    #[test]
    fn plan_items_and_questions_come_from_declared_items() {
        let tools = tools(json!({
            "TodoWrite": {"kind": "plan", "items": "/todos", "text": "/content", "status": "/status"},
            "update_plan": {"kind": "plan", "items": "/plan", "text": "/step", "status": "/status"},
            "AskUserQuestion": {"kind": "question", "items": "/questions", "text": "/question"}
        }));
        let input = json!({"todos": [
            {"content": "读代码", "status": "completed"}, {"content": "写测试", "status": "in_progress"}
        ]});
        let part = tool_part(&tools, "assistant", "TodoWrite", None, Some(&input));
        assert_eq!(
            part.plan,
            vec![
                PlanItem {
                    text: "读代码".into(),
                    status: Some("completed".into())
                },
                PlanItem {
                    text: "写测试".into(),
                    status: Some("in_progress".into())
                },
            ]
        );
        assert_eq!(part.text, None);
        let input = Value::String(r#"{"plan":[{"step":"s1","status":"pending"}]}"#.into());
        let part = tool_part(&tools, "assistant", "update_plan", None, Some(&input));
        assert_eq!(part.plan.len(), 1);
        let input = json!({"questions": [{"question": "选哪个？"}, {"question": "第二问"}]});
        let part = tool_part(&tools, "assistant", "AskUserQuestion", None, Some(&input));
        assert_eq!(part.title.as_deref(), Some("选哪个？"));
        assert_eq!(part.text.as_deref(), Some("选哪个？\n第二问"));
    }

    #[test]
    fn undeclared_tool_degrades_to_name_and_cut_text() {
        let input = json!({"q": "x".repeat(9000)});
        let part = tool_part(&BTreeMap::new(), "assistant", "mystery", None, Some(&input));
        assert_eq!(part.kind, "tool");
        assert_eq!(part.title.as_deref(), Some("mystery"));
        let total = serde_json::to_string(&input).unwrap().chars().count();
        assert_eq!(part.text.as_ref().unwrap().chars().count(), PART_TEXT_CHARS);
        assert_eq!(part.cut, total - PART_TEXT_CHARS);
    }

    #[test]
    fn text_is_cut_on_char_boundaries_and_reports_the_rest() {
        let text = "汉".repeat(PART_TEXT_CHARS + 5);
        let part = text_part("assistant", "text", None, &text).unwrap();
        assert_eq!(part.cut, 5);
        assert!(text_part("user", "text", None, "  ").is_none());
    }

    #[test]
    fn line_changes_match_frontend_estimates() {
        assert_eq!(line_changes("", "a\nb"), (2, 0));
        assert_eq!(line_changes("a\nb\n", ""), (0, 2));
        assert_eq!(line_changes("a\nb\nc", "a\nx\nc"), (1, 1));
        assert_eq!(line_changes("a\nb\nc\nd", "b\na\nd\nc"), (2, 2));
    }

    /// 会话读取任务 S2 的对照数据：本机真实会话里每个工具调用的原始参数、整份 detail 会给前端的
    /// 4000 字预览，以及按声明算出的 Part。`PARTS_DUMP_IN` 是 `[{agent, spec, files}]`，
    /// 结果逐行写进 `PARTS_DUMP_OUT`，由前端 `parts-compare.test.ts` 比对。S5 删前端推断时一起删。
    #[test]
    #[ignore]
    fn dump_parts_for_comparison() {
        use std::io::Write;
        let (Ok(input), Ok(output)) = (
            std::env::var("PARTS_DUMP_IN"),
            std::env::var("PARTS_DUMP_OUT"),
        ) else {
            return;
        };
        let preview = |text: &str| match text.char_indices().nth(4000) {
            Some((end, _)) => format!("{}...", &text[..end]),
            None => text.to_owned(),
        };
        let jobs: Vec<Value> =
            serde_json::from_str(&std::fs::read_to_string(input).unwrap()).unwrap();
        let mut out = std::io::BufWriter::new(std::fs::File::create(output).unwrap());
        for job in jobs {
            let spec: crate::sessions::SessionSpec = serde_json::from_str(
                &std::fs::read_to_string(job["spec"].as_str().unwrap()).unwrap(),
            )
            .unwrap();
            for file in job["files"].as_array().unwrap() {
                let path = std::path::Path::new(file.as_str().unwrap());
                let messages = crate::session_files::messages(&spec, path);
                let outputs: HashMap<String, String> = messages
                    .iter()
                    .filter(|message| message["role"] == "tool")
                    .filter_map(|message| {
                        Some((
                            message["tool_call_id"].as_str()?.to_owned(),
                            message["content"].as_str().unwrap_or("").to_owned(),
                        ))
                    })
                    .collect();
                for call in messages
                    .iter()
                    .filter_map(|message| message["tool_calls"].as_array())
                    .flatten()
                {
                    let name = call["function"]["name"].as_str().unwrap_or("");
                    let arguments = call["function"]["arguments"].as_str().unwrap_or("");
                    let id = call["id"].as_str().map(str::to_owned);
                    let result = id.as_ref().and_then(|id| outputs.get(id));
                    let part = tool_part(
                        &spec.tools,
                        "assistant",
                        name,
                        id,
                        Some(&Value::String(arguments.to_owned())),
                    );
                    let row = serde_json::json!({
                        "agent": job["agent"], "file": file, "name": name,
                        "input": preview(arguments),
                        "output": result.map(|text| preview(text)),
                        "part": part,
                    });
                    writeln!(out, "{row}").unwrap();
                }
            }
        }
    }
}
