use super::*;

async fn set_command_alias(handler: &RequestHandler, alias: &str) {
    assert!(matches!(
        handler
            .handle(Request::SetOption(SetOptionRequest {
                scope: ScopeSelector::Global,
                option: OptionName::CommandAlias,
                value: alias.to_owned(),
                mode: SetOptionMode::Replace,
            }))
            .await,
        Response::SetOption(_)
    ));
}

#[tokio::test]
async fn runtime_command_alias_option_drives_command_string_parser() {
    let handler = RequestHandler::new();
    set_command_alias(&handler, "say=display-message -p --").await;

    let parsed = handler
        .parse_command_string_one_group("say hello")
        .await
        .expect("runtime alias should parse");
    let output = handler
        .execute_parsed_commands_for_test(std::process::id(), parsed)
        .await
        .expect("runtime alias should execute");

    assert_eq!(output.stdout(), b"hello\n");
}
