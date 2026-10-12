// 应用版本与桌面端自动更新。
// - app_version：两端都可用，前端据此比较 GitHub 正式版与显示更新日志。
// - app_update_install：仅桌面端，经官方 updater 插件下载、校验签名并安装；移动端返回 unsupported_platform，
//   由前端改为打开 APK 下载链接。
use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
static UPDATE_INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    expected_version: String,
    // 下载进度：{ stage: "downloading", downloaded, total } → { stage: "installing" }。
    // 用 Channel 而非事件：APP 未配置 capabilities，前端无权调用 event 插件的 listen。
    on_progress: Channel<Value>,
) -> Result<Value, String> {
    use tauri_plugin_updater::UpdaterExt;

    // 全进程只允许一个检查／下载／安装任务；失败或取消时由 guard 自动释放。
    let Ok(_install_guard) = UPDATE_INSTALL_LOCK.try_lock() else {
        return Ok(json!({ "status": "in_progress" }));
    };

    let updater = app
        .updater()
        .map_err(|error| format!("updater_unavailable:{error}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|error| format!("update_check_failed:{error}"))?
    else {
        return Ok(json!({ "status": "up_to_date" }));
    };
    let expected = expected_version.trim().trim_start_matches('v');
    if !expected.is_empty() && update.version != expected {
        // 提示的版本与 updater 端点不一致时不安装，交给前端改为打开发布页
        return Ok(json!({ "status": "version_mismatch", "version": update.version }));
    }
    let mut downloaded: u64 = 0;
    let mut last_reported: Option<u64> = None;
    let progress_channel = on_progress.clone();
    update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded += chunk_length as u64;
                // 按百分比变化（总量未知时每 512KB）才回报，避免每个数据块都跨进程发送
                let step = match content_length {
                    Some(total) if total > 0 => downloaded.saturating_mul(100) / total,
                    _ => downloaded / (512 * 1024),
                };
                if last_reported == Some(step) {
                    return;
                }
                last_reported = Some(step);
                let _ = progress_channel.send(json!({
                    "stage": "downloading",
                    "downloaded": downloaded,
                    "total": content_length,
                }));
            },
            move || {
                let _ = on_progress.send(json!({ "stage": "installing" }));
            },
        )
        .await
        .map_err(|error| format!("update_install_failed:{error}"))?;
    app.restart();
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn app_update_install(
    _app: AppHandle,
    _expected_version: String,
    _on_progress: Channel<Value>,
) -> Result<Value, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    use super::UPDATE_INSTALL_LOCK;

    #[test]
    fn installation_lock_rejects_overlap_and_allows_retry_after_error() {
        let attempt = || -> Result<(), &'static str> {
            let _guard = UPDATE_INSTALL_LOCK.try_lock().expect("first install");
            assert!(UPDATE_INSTALL_LOCK.try_lock().is_err());
            Err("download failed")
        };
        assert!(attempt().is_err());
        assert!(UPDATE_INSTALL_LOCK.try_lock().is_ok());
    }
}
