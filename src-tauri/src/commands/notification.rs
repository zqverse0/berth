#[cfg(feature = "tauri-runtime")]
use crate::app_error::AppCommandError;

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn send_notification<R: tauri::Runtime>(
    #[allow(unused_variables)] app: tauri::AppHandle<R>,
    title: String,
    body: String,
) -> Result<(), AppCommandError> {
    #[cfg(target_os = "macos")]
    {
        let app_id = if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            "app.berth"
        };
        let _ = mac_notification_sys::set_application(app_id);

        let _ = mac_notification_sys::Notification::default()
            .title(&title)
            .message(&body)
            .send();
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(title).body(body).show();
    }

    Ok(())
}
