//! 控制面 `knowledge.digest`：项目（含 worktree）在游标之后的 Agent 会话，压成只含用户与助手文本的摘要，
//! 供 Agent 整理知识库。读取复用声明式会话读取器（`DeclarativeSessionParser::recent_details`），不另写解析器。

use berth_control_proto::{
    KnowledgeDigestMessage, KnowledgeDigestParams, KnowledgeDigestResult, KnowledgeDigestSession,
};
use chrono::{DateTime, Utc};

use crate::models::{ContentBlock, MessageTurn, TurnRole};

/// 单条消息保留的字符数。
const MESSAGE_CHARS: usize = 800;
/// 单个会话保留的字符数，超出时按轮丢最旧的。
const SESSION_CHARS: usize = 12_000;
/// 单次响应的文本字节预算：控制面单帧上限 1 MiB，留出 JSON 开销。
const RESPONSE_BYTES: usize = 600 * 1024;

#[cfg(feature = "tauri-runtime")]
pub(crate) async fn digest(
    conn: &sea_orm::DatabaseConnection,
    params: KnowledgeDigestParams,
) -> Result<KnowledgeDigestResult, crate::app_error::AppCommandError> {
    use crate::app_error::AppCommandError;
    use crate::sessions::declarative::DeclarativeSessionParser;

    let since = match params.since.as_deref() {
        Some(value) => DateTime::parse_from_rfc3339(value)
            .map_err(|error| AppCommandError::invalid_input(format!("invalid since: {error}")))?
            .with_timezone(&Utc),
        None => DateTime::<Utc>::UNIX_EPOCH,
    };
    // 项目范围 = 主项目的全部群目录（含已删的 worktree），与 `berth session list`、会话视图同一口径。
    let main = berth_project_core::tasks::main_project(std::path::Path::new(&params.path))
        .map_err(|error| AppCommandError::not_found(error.to_string()))?;
    let links = berth_project_core::tasks::session_links::session_links(&main)
        .map_err(|error| AppCommandError::not_found(error.to_string()))?;
    let projects = links
        .groups
        .iter()
        .map(|(_, dir)| dir.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let agents = crate::db::service::agent_setting_service::enabled_conversation_agent_types(conn)
        .await
        .map_err(AppCommandError::from)?;

    let (sessions, skipped) = tokio::task::spawn_blocking(move || {
        let mut sessions = Vec::new();
        let mut skipped = Vec::new();
        for agent in agents {
            let parser = match DeclarativeSessionParser::for_agent(agent) {
                Ok(Some(parser)) => parser,
                Ok(None) => continue,
                Err(error) => {
                    skipped.push(format!("{}（{error}）", agent_id(agent)));
                    continue;
                }
            };
            match parser.recent_details(&projects, since.into()) {
                Ok(details) => sessions.extend(details.into_iter().filter_map(|detail| {
                    let (messages, latest) = condense(&detail.turns, since);
                    let latest = latest?;
                    Some((
                        latest,
                        KnowledgeDigestSession {
                            agent: agent_id(agent),
                            id: detail.summary.id,
                            title: detail.summary.title,
                            cwd: detail.summary.folder_path.unwrap_or_default(),
                            // 读取器缺首条时间时会退回「现在」，以首条消息为准。
                            started_at: detail
                                .turns
                                .first()
                                .map_or(detail.summary.started_at, |turn| turn.timestamp)
                                .to_rfc3339(),
                            messages,
                        },
                    ))
                })),
                Err(error) => skipped.push(format!("{}（{error}）", agent_id(agent))),
            }
        }
        (sessions, skipped)
    })
    .await
    .map_err(|error| {
        AppCommandError::task_execution_failed("knowledge digest failed")
            .with_detail(error.to_string())
    })?;

    Ok(assemble(sessions, skipped, since))
}

/// 按最新消息时间升序装进响应，超出预算时截断；`next_since` 是已装入的最新消息时间。
fn assemble(
    mut sessions: Vec<(DateTime<Utc>, KnowledgeDigestSession)>,
    skipped: Vec<String>,
    since: DateTime<Utc>,
) -> KnowledgeDigestResult {
    sessions.sort_by_key(|(latest, _)| *latest);
    let mut result = KnowledgeDigestResult {
        sessions: Vec::new(),
        next_since: since.to_rfc3339(),
        truncated: false,
        skipped,
    };
    let mut latest = since;
    let mut bytes = 0;
    for (session_latest, session) in sessions {
        let size = session
            .messages
            .iter()
            .map(|message| message.text.len())
            .sum::<usize>();
        if bytes + size > RESPONSE_BYTES && !result.sessions.is_empty() {
            // ponytail: 按会话截断；未装入的会话里早于新游标的消息下次会被跳过。
            // 预算约 50 个满额会话，真撞上再改成按消息时间窗口切分。
            result.truncated = true;
            break;
        }
        bytes += size;
        latest = latest.max(session_latest);
        result.sessions.push(session);
    }
    result.next_since = latest.to_rfc3339();
    result
}

/// Agent 的线上标识（`snake_case`，与 `projectType` 一致）。
fn agent_id(agent: crate::models::AgentType) -> String {
    serde_json::to_value(agent)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// 一轮：一条用户消息 + 其后的全部助手文本。
pub(crate) struct Round {
    pub(crate) user: String,
    pub(crate) replies: Vec<String>,
    pub(crate) latest: DateTime<Utc>,
}

/// 游标之后的消息按轮归组：助手没回复的轮（中断、空回复）丢弃，同一用户消息重发只留最后一次。
/// 单条消息截到 `message_chars`。会话分类与摘要共用。
pub(crate) fn rounds(
    turns: &[MessageTurn],
    since: DateTime<Utc>,
    message_chars: usize,
) -> Vec<Round> {
    let mut rounds: Vec<Round> = Vec::new();
    for turn in turns {
        if matches!(turn.role, TurnRole::System) || turn.timestamp <= since {
            continue;
        }
        let text = turn
            .blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let text = text.chars().take(message_chars).collect::<String>();
        let is_user = matches!(turn.role, TurnRole::User);
        if !is_user {
            if let Some(round) = rounds.last_mut() {
                round.replies.push(text);
                round.latest = turn.timestamp;
                continue;
            }
        }
        // 上一轮没回复（中断），或被原样重发，只留这一次。
        if rounds
            .last()
            .is_some_and(|round| round.replies.is_empty() || (is_user && round.user == text))
        {
            rounds.pop();
        }
        // 游标落在一轮中间时，开头的助手文本归入用户消息为空的一轮。
        let (user, replies) = if is_user {
            (text, Vec::new())
        } else {
            (String::new(), vec![text])
        };
        rounds.push(Round {
            user,
            replies,
            latest: turn.timestamp,
        });
    }
    if rounds.last().is_some_and(|round| round.replies.is_empty()) {
        rounds.pop();
    }
    rounds
}

/// 超出会话预算时按轮丢最旧的。返回已装入的最新消息时间。
fn condense(
    turns: &[MessageTurn],
    since: DateTime<Utc>,
) -> (Vec<KnowledgeDigestMessage>, Option<DateTime<Utc>>) {
    let rounds = rounds(turns, since, MESSAGE_CHARS);
    let size = |round: &Round| {
        round.user.chars().count()
            + round
                .replies
                .iter()
                .map(|reply| reply.chars().count())
                .sum::<usize>()
    };
    let mut total = rounds.iter().map(size).sum::<usize>();
    let mut skip = 0;
    while total > SESSION_CHARS && skip + 1 < rounds.len() {
        total -= size(&rounds[skip]);
        skip += 1;
    }
    let latest = rounds.iter().map(|round| round.latest).max();
    let mut messages = Vec::new();
    if skip > 0 {
        messages.push(KnowledgeDigestMessage {
            role: "assistant".to_owned(),
            text: format!("…（省略更早的 {skip} 轮）…"),
        });
    }
    for round in rounds.into_iter().skip(skip) {
        if !round.user.is_empty() {
            messages.push(KnowledgeDigestMessage {
                role: "user".to_owned(),
                text: round.user,
            });
        }
        messages.extend(round.replies.into_iter().map(|text| KnowledgeDigestMessage {
            role: "assistant".to_owned(),
            text,
        }));
    }
    (messages, latest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn turn(role: TurnRole, minute: u32, text: &str) -> MessageTurn {
        MessageTurn {
            id: format!("{minute}"),
            role,
            blocks: vec![ContentBlock::Text {
                text: text.to_owned(),
            }],
            fields: Default::default(),
            timestamp: Utc.with_ymd_and_hms(2026, 10, 4, 0, minute, 0).unwrap(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
        }
    }

    #[test]
    fn keeps_user_and_assistant_text_after_the_cursor() {
        let turns = [
            turn(TurnRole::User, 1, "old"),
            turn(TurnRole::System, 2, "<reminder>"),
            turn(TurnRole::User, 3, "  new question "),
            turn(TurnRole::Assistant, 4, &"x".repeat(MESSAGE_CHARS + 10)),
        ];
        let since = Utc.with_ymd_and_hms(2026, 10, 4, 0, 1, 0).unwrap();
        let (messages, latest) = condense(&turns, since);
        assert_eq!(messages.len(), 2);
        assert_eq!(
            (messages[0].role.as_str(), messages[0].text.as_str()),
            ("user", "new question")
        );
        assert_eq!(messages[1].text.chars().count(), MESSAGE_CHARS);
        assert_eq!(latest, Some(turns[3].timestamp));
    }

    #[test]
    fn rounds_drop_unanswered_and_resent_messages() {
        let turns = [
            turn(TurnRole::User, 1, "first try"),
            turn(TurnRole::User, 2, "ask"),
            turn(TurnRole::Assistant, 3, "half"),
            turn(TurnRole::User, 4, "ask"),
            turn(TurnRole::Assistant, 5, "a"),
            turn(TurnRole::Assistant, 6, "b"),
            turn(TurnRole::User, 7, "可以"),
            turn(TurnRole::Assistant, 8, "done"),
            turn(TurnRole::User, 9, "可以"),
            turn(TurnRole::Assistant, 10, "again"),
            turn(TurnRole::User, 11, "pending"),
        ];
        let (messages, latest) = condense(&turns, DateTime::<Utc>::UNIX_EPOCH);
        let texts = messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>();
        // 原样重发只留最后一次：两次 "ask"、两次 "可以" 都只剩后一轮。
        assert_eq!(texts, ["ask", "a", "b", "可以", "again"]);
        assert_eq!(latest, Some(turns[9].timestamp));
    }

    #[test]
    fn long_sessions_drop_oldest_rounds() {
        let turns = (0..40)
            .map(|minute| {
                let role = if minute % 2 == 0 { TurnRole::User } else { TurnRole::Assistant };
                turn(role, minute, &format!("{minute}{}", "y".repeat(MESSAGE_CHARS)))
            })
            .collect::<Vec<_>>();
        let (messages, latest) = condense(&turns, DateTime::<Utc>::UNIX_EPOCH);
        assert!(messages[0].text.contains("省略更早的"));
        assert!(messages.last().unwrap().text.starts_with("39"));
        assert_eq!(latest, Some(turns[39].timestamp));
    }

    #[test]
    fn assemble_orders_by_latest_message_and_truncates_at_the_budget() {
        let at = |minute| Utc.with_ymd_and_hms(2026, 10, 4, 0, minute, 0).unwrap();
        let session = |id: &str, bytes: usize| KnowledgeDigestSession {
            agent: "codex".into(),
            id: id.into(),
            title: None,
            cwd: "/p".into(),
            started_at: at(0).to_rfc3339(),
            messages: vec![KnowledgeDigestMessage {
                role: "user".into(),
                text: "z".repeat(bytes),
            }],
        };
        let result = assemble(
            vec![
                (at(3), session("late", RESPONSE_BYTES)),
                (at(1), session("early", 10)),
            ],
            Vec::new(),
            at(0),
        );
        assert_eq!(result.sessions.len(), 1);
        assert_eq!(result.sessions[0].id, "early");
        assert!(result.truncated);
        assert_eq!(result.next_since, at(1).to_rfc3339());
    }
}
