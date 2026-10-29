use pulldown_cmark::{Event, HeadingLevel, LinkType, Options, Parser, Tag, TagEnd};

use super::model::KnowledgeHeading;

#[derive(Default)]
pub struct ParsedMarkdown {
    pub note_type: Option<String>,
    pub status: Option<String>,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub code: Vec<String>,
    pub sources: Vec<String>,
    pub verified_at: Option<String>,
    /// 来源笔记：`url` 与 `kind`。
    pub url: Option<String>,
    pub kind: Option<String>,
    /// 来源笔记是否已被专家读过；没写为 `None`。
    pub digested: Option<bool>,
    /// `supersedes` 中的双链目标。
    pub supersedes: Vec<String>,
    pub headings: Vec<KnowledgeHeading>,
    /// 正文中的双链目标（不含代码块 / 行内代码）。
    pub links: Vec<String>,
    pub excerpt: String,
}

pub fn parse_markdown(content: &str) -> ParsedMarkdown {
    let (frontmatter, body) = split_frontmatter(content);
    let mut parsed = ParsedMarkdown::default();
    if let Some(frontmatter) = frontmatter {
        if let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(frontmatter) {
            parsed.note_type = scalar(&value, "type");
            parsed.status = scalar(&value, "status");
            parsed.verified_at = scalar(&value, "verified_at");
            parsed.url = scalar(&value, "url");
            parsed.kind = scalar(&value, "kind");
            parsed.digested = value.get("digested").and_then(serde_yaml::Value::as_bool);
            parsed.tags = strings(&value, "tags");
            parsed.aliases = strings(&value, "aliases");
            parsed.code = strings(&value, "code");
            parsed.sources = strings(&value, "sources");
            parsed.supersedes = strings(&value, "supersedes")
                .iter()
                .filter_map(|raw| link_target(raw.trim().trim_start_matches("[[")))
                .collect();
        }
    }

    let mut heading_level = None;
    let mut code_block_depth = 0usize;
    let mut heading_text = String::new();
    let mut plain = String::new();
    for event in Parser::new_ext(body, Options::all()) {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                heading_level = Some(level);
                heading_text.clear();
            }
            Event::Start(Tag::CodeBlock(_)) => code_block_depth += 1,
            Event::End(TagEnd::CodeBlock) => code_block_depth = code_block_depth.saturating_sub(1),
            Event::End(TagEnd::Heading(_)) => {
                if let Some(level) = heading_level.take() {
                    parsed.headings.push(KnowledgeHeading {
                        level: heading_number(level),
                        text: heading_text.trim().to_string(),
                    });
                }
            }
            Event::Start(Tag::Link {
                link_type: LinkType::WikiLink { .. },
                dest_url,
                ..
            }) => parsed.links.extend(link_target(&dest_url)),
            Event::Text(text) => {
                if heading_level.is_some() {
                    heading_text.push_str(&text);
                }
                if code_block_depth == 0 {
                    scan_wikilinks(&text, &mut parsed.links);
                }
                if plain.len() < 600 && heading_level.is_none() && code_block_depth == 0 {
                    plain.push_str(&text);
                    plain.push(' ');
                }
            }
            _ => {}
        }
    }
    parsed.excerpt = plain
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect();
    parsed
}

/// 返回 `(frontmatter, body)`；要求文件以 `---\n` 开头。
pub fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    let Some(rest) = content.strip_prefix("---\n") else {
        return (None, content);
    };
    let Some(end) = rest.find("\n---") else {
        return (None, content);
    };
    let body = &rest[end + 4..];
    (Some(&rest[..end]), body.strip_prefix('\n').unwrap_or(body))
}

/// `标题#小节|显示` → `标题`。
fn link_target(raw: &str) -> Option<String> {
    let target = raw
        .trim_end_matches("]]")
        .split(['|', '#'])
        .next()
        .unwrap_or_default()
        .trim();
    (!target.is_empty() && !target.contains('\0')).then(|| target.to_string())
}

fn scalar(value: &serde_yaml::Value, key: &str) -> Option<String> {
    // ponytail: 纯数字 sha 会被 YAML 解析成数字，这里转回字符串；`1e5` 形式的 sha 仍会失真
    match value.get(key)? {
        serde_yaml::Value::String(text) => Some(text.trim().to_string()),
        serde_yaml::Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
    .filter(|text| !text.is_empty())
}

/// 列表字段；未加引号的 `[[X]]` 在 YAML 里是嵌套序列，一并展开。
fn strings(value: &serde_yaml::Value, key: &str) -> Vec<String> {
    fn collect(value: &serde_yaml::Value, output: &mut Vec<String>) {
        match value {
            serde_yaml::Value::Sequence(values) => {
                values.iter().for_each(|value| collect(value, output))
            }
            serde_yaml::Value::String(text) => output.extend(
                text.split(',')
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(str::to_string),
            ),
            _ => {}
        }
    }
    let mut output = Vec::new();
    if let Some(value) = value.get(key) {
        collect(value, &mut output);
    }
    output
}

fn scan_wikilinks(text: &str, output: &mut Vec<String>) {
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else { break };
        output.extend(link_target(&rest[..end]));
        rest = &rest[end + 2..];
    }
}

fn heading_number(level: HeadingLevel) -> u32 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vault_frontmatter_and_links() {
        let parsed = parse_markdown(
            "---\ntype: 模块\nstatus: 草稿\ntags: [主线/跑]\naliases: [D]\ncode: [src/a/, src/b.rs]\nsupersedes: [[旧笔记]]\nverified_at: 1234567\n---\n# Heading\n[[Other|label]] [[Sec#part]] [Doc](docs/a.md) `[[Code]]`\n```text\n[[Fence]]\n```\n",
        );
        assert_eq!(parsed.note_type.as_deref(), Some("模块"));
        assert_eq!(parsed.status.as_deref(), Some("草稿"));
        assert_eq!(parsed.verified_at.as_deref(), Some("1234567"));
        assert_eq!(parsed.code, ["src/a/", "src/b.rs"]);
        assert_eq!(parsed.supersedes, ["旧笔记"]);
        assert_eq!(parsed.links, ["Other", "Sec"]);
        assert_eq!(parsed.headings[0].text, "Heading");
    }

    #[test]
    fn quoted_supersedes_resolves_target() {
        let parsed = parse_markdown("---\nsupersedes: [\"[[旧 笔记|x]]\"]\n---\nbody");
        assert_eq!(parsed.supersedes, ["旧 笔记"]);
    }
}
