use crate::models::AgentType;
use crate::sessions::{
    AgentParser, NativeConversationPage, NativeConversationPageRequest, ParseError,
};

/// Construct the only supported session reader for one explicitly selected
/// Agent.  Missing declarations are an explicit empty capability; no legacy
/// parser or built-in path is consulted.
pub(crate) fn build_agent_parser(agent_type: AgentType) -> Box<dyn AgentParser> {
    match crate::sessions::declarative::DeclarativeSessionParser::for_agent(agent_type) {
        Ok(Some(parser)) => return Box::new(parser),
        Ok(None) => return Box::new(UnsupportedSessionParser::missing(agent_type)),
        Err(error) => {
            tracing::warn!(%agent_type, %error, "invalid declarative session spec");
            return Box::new(UnsupportedSessionParser::invalid(agent_type, error));
        }
    }
}

struct UnsupportedSessionParser {
    reason: String,
}

impl UnsupportedSessionParser {
    fn missing(agent_type: AgentType) -> Self {
        Self {
            reason: format!("{agent_type} has no sessions.json declaration"),
        }
    }

    fn invalid(agent_type: AgentType, error: ParseError) -> Self {
        Self {
            reason: format!("{agent_type} sessions.json is invalid: {error}"),
        }
    }
}

impl AgentParser for UnsupportedSessionParser {
    fn list_conversations(&self) -> Result<Vec<crate::models::ConversationSummary>, ParseError> {
        Err(ParseError::InvalidData(self.reason.clone()))
    }

    fn list_conversation_page(
        &self,
        _request: &NativeConversationPageRequest,
    ) -> Result<NativeConversationPage, ParseError> {
        Err(ParseError::InvalidData(self.reason.clone()))
    }

    fn get_conversation(
        &self,
        _conversation_id: &str,
    ) -> Result<crate::models::ConversationDetail, ParseError> {
        Err(ParseError::InvalidData(self.reason.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undeclared_agent_has_no_legacy_session_reader() {
        let parser = build_agent_parser(AgentType::new("cursor"));
        let error = parser
            .list_conversations()
            .expect_err("Cursor must not use the removed parser");
        assert!(error.to_string().contains("sessions.json"));
    }
}
