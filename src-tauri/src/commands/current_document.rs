//! Transport adapter for the conversation-scoped current-document registry.

use crate::app_error::AppCommandError;
use crate::workspace_state::current_document::{
    CurrentDocumentContextStore, DocumentContextScope, SetCurrentDocumentContextRequest,
};

pub async fn set_current_document_context_core(
    store: &CurrentDocumentContextStore,
    request: SetCurrentDocumentContextRequest,
) -> Result<(), AppCommandError> {
    if request.scope == DocumentContextScope::Workspace {
        if request.conversation_id != 0 {
            return Err(AppCommandError::invalid_input(
                "workspace scope cannot specify a conversation id",
            ));
        }
        if request.clear {
            store.clear_workspace();
            return Ok(());
        }
        if request.kind != "text" || request.url.is_some() {
            return Err(AppCommandError::invalid_input(
                "workspace scope requires a text editor buffer",
            ));
        }
        let path = request
            .path
            .filter(|path| {
                path.len() <= 4096
                    && !path.contains('\0')
                    && std::path::Path::new(path).is_absolute()
            })
            .ok_or_else(|| {
                AppCommandError::invalid_input("workspace source path must be absolute and bounded")
            })?;
        let content = request.content.ok_or_else(|| {
            AppCommandError::invalid_input("workspace scope requires an editor buffer snapshot")
        })?;
        store.set_workspace(path, content).await;
        return Ok(());
    }
    if request.conversation_id <= 0 {
        return Err(AppCommandError::invalid_input(
            "conversation_id must be a positive conversation id",
        ));
    }
    if request.clear {
        store.clear(request.conversation_id).await;
        return Ok(());
    }
    if request.kind.trim().is_empty() {
        return Err(AppCommandError::invalid_input(
            "current document kind must not be empty",
        ));
    }
    let has_snapshot = request
        .content
        .as_deref()
        .is_some_and(|content| !content.trim().is_empty());
    if request.path.is_none() && request.url.is_none() && !has_snapshot {
        return Err(AppCommandError::invalid_input(
            "current document needs a source path, URL, or text snapshot",
        ));
    }
    store.set(request).await;
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn set_current_document_context(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, std::sync::Arc<CurrentDocumentContextStore>>,
    request: SetCurrentDocumentContextRequest,
) -> Result<(), AppCommandError> {
    let workspace = request.scope == DocumentContextScope::Workspace;
    if workspace {
        if window.label() != "main" {
            return Err(AppCommandError::permission_denied(
                "only the main window may set the current workspace document",
            ));
        }
        if !window.is_visible().unwrap_or(false) {
            store.clear_workspace();
            return Ok(());
        }
    }
    let result = set_current_document_context_core(store.inner(), request).await;
    if workspace && !window.is_visible().unwrap_or(false) {
        store.clear_workspace();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_error::AppErrorCode;
    use crate::workspace_state::current_document::WorkspaceDocumentReadError;
    use berth_control_proto::WorkspaceDocumentParams;

    fn request(value: serde_json::Value) -> SetCurrentDocumentContextRequest {
        serde_json::from_value(value).expect("synthetic document request")
    }

    #[tokio::test]
    async fn workspace_requires_a_bounded_editor_buffer_and_does_not_change_conversations() {
        let store = CurrentDocumentContextStore::new();
        let conversation = request(serde_json::json!({
            "conversationId": 7, "kind": "text", "path": "/synthetic/conversation.txt", "content": "conversation"
        }));
        set_current_document_context_core(&store, conversation)
            .await
            .unwrap();

        let editor = request(serde_json::json!({
            "scope": "workspace", "kind": "text", "path": "/synthetic/empty.txt", "content": ""
        }));
        for invalid in [
            SetCurrentDocumentContextRequest {
                conversation_id: 7,
                ..editor.clone()
            },
            SetCurrentDocumentContextRequest {
                path: Some("relative.txt".into()),
                ..editor.clone()
            },
            SetCurrentDocumentContextRequest {
                path: Some(format!("/{}", "a".repeat(4096))),
                ..editor.clone()
            },
            SetCurrentDocumentContextRequest {
                content: None,
                ..editor.clone()
            },
            SetCurrentDocumentContextRequest {
                kind: "pdf".into(),
                ..editor.clone()
            },
            SetCurrentDocumentContextRequest {
                url: Some("https://example.invalid".into()),
                ..editor.clone()
            },
        ] {
            let error = set_current_document_context_core(&store, invalid)
                .await
                .unwrap_err();
            assert_eq!(error.code, AppErrorCode::InvalidInput);
        }
        assert!(matches!(
            store
                .get_workspace(WorkspaceDocumentParams::default())
                .await,
            Err(WorkspaceDocumentReadError::NotFound)
        ));

        set_current_document_context_core(&store, editor.clone())
            .await
            .unwrap();
        assert_eq!(
            store
                .get_workspace(WorkspaceDocumentParams::default())
                .await
                .unwrap()
                .content,
            ""
        );
        set_current_document_context_core(
            &store,
            SetCurrentDocumentContextRequest {
                clear: true,
                ..editor
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            store
                .get_workspace(WorkspaceDocumentParams::default())
                .await,
            Err(WorkspaceDocumentReadError::NotFound)
        ));
        assert_eq!(store.get(7).await.content.as_deref(), Some("conversation"));
    }
}
