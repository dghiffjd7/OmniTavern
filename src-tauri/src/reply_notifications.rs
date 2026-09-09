//! Local Windows reply notifications. The OS receives an opaque navigation token,
//! never a prompt, reply body, or executable command supplied by the renderer.
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, path::PathBuf, sync::Mutex};
use tauri::{ipc::Channel, AppHandle, Manager, WebviewWindow};

const LIMIT: usize = 64;
const RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
static EARLY_ACTIVATION: Mutex<Option<String>> = Mutex::new(None);

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub enabled: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyRoute {
    pub persona_id: String,
    pub scope_id: String,
    pub session_id: String,
    #[serde(default)]
    pub archive_id: String,
    pub message_id: String,
    #[serde(default)]
    pub swipe_index: Option<u32>,
}

#[derive(Clone, Deserialize, Serialize)]
struct SavedRoute {
    token: String,
    created_at: i64,
    route: ReplyRoute,
}

#[derive(Default, Deserialize, Serialize)]
struct DiskState {
    #[serde(default)]
    preferences: Preferences,
    #[serde(default)]
    routes: VecDeque<SavedRoute>,
}

#[derive(Default)]
struct Runtime {
    disk: DiskState,
    seen: VecDeque<String>,
    pending: Option<String>,
    channel: Option<Channel<()>>,
}

pub struct ReplyNotificationState {
    path: PathBuf,
    runtime: Mutex<Runtime>,
}

fn scheme() -> &'static str {
    if cfg!(debug_assertions) {
        "omnitavern-reply-dev"
    } else {
        "omnitavern-reply"
    }
}

fn parse_token(url: &str) -> Option<String> {
    let token = url.strip_prefix(&format!("{}://open/", scheme()))?;
    (token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| token.to_ascii_lowercase())
}

fn prune(disk: &mut DiskState) {
    let oldest = chrono::Utc::now().timestamp_millis() - RETENTION_MS;
    disk.routes.retain(|item| item.created_at >= oldest);
    while disk.routes.len() > LIMIT {
        disk.routes.pop_front();
    }
}

fn persist(state: &ReplyNotificationState, disk: &DiskState) -> Result<(), String> {
    let parent = state
        .path
        .parent()
        .ok_or("Notification settings directory missing")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = state.path.with_extension("tmp");
    std::fs::write(&temp, serde_json::to_vec(disk).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(temp, &state.path).map_err(|e| e.to_string())
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join(if cfg!(debug_assertions) {
            "reply-notifications-dev.json"
        } else {
            "reply-notifications.json"
        });
    let mut disk: DiskState = if path.exists() {
        let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
        if size > 256_000 {
            return Err("Notification settings file exceeds size limit".into());
        }
        serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        DiskState::default()
    };
    prune(&mut disk);
    app.manage(ReplyNotificationState {
        path,
        runtime: Mutex::new(Runtime {
            disk,
            ..Runtime::default()
        }),
    });
    let args: Vec<String> = std::env::args().collect();
    activate(app, &args);
    if let Some(token) = EARLY_ACTIVATION
        .lock()
        .ok()
        .and_then(|mut pending| pending.take())
    {
        activate(
            app,
            &[String::new(), format!("{}://open/{token}", scheme())],
        );
    }
    Ok(())
}

pub fn activate(app: &AppHandle, args: &[String]) {
    let Some(token) = args.iter().skip(1).find_map(|arg| parse_token(arg)) else {
        return;
    };
    let Some(state) = app.try_state::<ReplyNotificationState>() else {
        if let Ok(mut pending) = EARLY_ACTIVATION.lock() {
            *pending = Some(token);
        }
        return;
    };
    let channel = {
        let Ok(mut runtime) = state.runtime.lock() else {
            return;
        };
        prune(&mut runtime.disk);
        // Only routes actually emitted by this installation can navigate.
        if !runtime.disk.routes.iter().any(|item| item.token == token) {
            return;
        }
        runtime.pending = Some(token);
        runtime.channel.clone()
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    if let Some(channel) = channel {
        let _ = channel.send(());
    }
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Reply notifications are only available in the main window".into())
    }
}

#[tauri::command]
pub fn reply_notification_settings(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    require_main(&window)?;
    let Some(state) = app.try_state::<ReplyNotificationState>() else {
        return Ok(serde_json::json!({"supported": false, "enabled": false}));
    };
    let runtime = state.runtime.lock().map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({"supported": cfg!(target_os = "windows"), "enabled": runtime.disk.preferences.enabled}),
    )
}

#[tauri::command]
pub fn reply_notification_configure(
    window: WebviewWindow,
    app: AppHandle,
    preferences: Preferences,
) -> Result<(), String> {
    require_main(&window)?;
    #[cfg(target_os = "windows")]
    if preferences.enabled {
        windows_native::register(&app)?;
    }
    let state = app
        .try_state::<ReplyNotificationState>()
        .ok_or("Reply notifications unavailable")?;
    let mut runtime = state.runtime.lock().map_err(|e| e.to_string())?;
    let previous = std::mem::replace(&mut runtime.disk.preferences, preferences);
    if let Err(error) = persist(&state, &runtime.disk) {
        runtime.disk.preferences = previous;
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn reply_notification_watch(
    window: WebviewWindow,
    app: AppHandle,
    channel: Channel<()>,
) -> Result<(), String> {
    require_main(&window)?;
    let state = app
        .try_state::<ReplyNotificationState>()
        .ok_or("Reply notifications unavailable")?;
    let mut runtime = state.runtime.lock().map_err(|e| e.to_string())?;
    runtime.channel = Some(channel);
    Ok(())
}

#[tauri::command]
pub fn reply_notification_take_activation(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<Option<ReplyRoute>, String> {
    require_main(&window)?;
    let state = app
        .try_state::<ReplyNotificationState>()
        .ok_or("Reply notifications unavailable")?;
    let mut runtime = state.runtime.lock().map_err(|e| e.to_string())?;
    let Some(token) = runtime.pending.take() else {
        return Ok(None);
    };
    prune(&mut runtime.disk);
    Ok(runtime
        .disk
        .routes
        .iter()
        .find(|item| item.token == token)
        .map(|item| item.route.clone()))
}

fn eligible(preferences: &Preferences, minimized: bool, focused: bool) -> bool {
    preferences.enabled && (minimized || !focused)
}

#[tauri::command]
pub async fn reply_notification_complete(
    window: WebviewWindow,
    app: AppHandle,
    run_id: String,
    route: ReplyRoute,
    body: String,
) -> Result<String, String> {
    require_main(&window)?;
    #[cfg(target_os = "windows")]
    return tauri::async_runtime::spawn_blocking(move || {
        complete_windows(&app, &window, run_id, route, body)
    })
    .await
    .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, run_id, route, body);
        Ok("unsupported".into())
    }
}

#[cfg(target_os = "windows")]
fn complete_windows(
    app: &AppHandle,
    window: &WebviewWindow,
    run_id: String,
    route: ReplyRoute,
    body: String,
) -> Result<String, String> {
    if run_id.is_empty()
        || run_id.len() > 200
        || body.chars().count() > 300
        || body.trim().is_empty()
        || [
            &route.persona_id,
            &route.scope_id,
            &route.session_id,
            &route.archive_id,
            &route.message_id,
        ]
        .iter()
        .any(|s| s.len() > 512 || s.contains('\0'))
        || route.session_id.is_empty()
        || route.message_id.is_empty()
    {
        return Err("Invalid reply notification".into());
    }
    // Window queries may dispatch to the main thread; never hold our mutex while
    // doing so, as activation/configuration also arrives on that thread.
    let minimized = window.is_minimized().map_err(|e| e.to_string())?;
    let focused = window.is_focused().map_err(|e| e.to_string())?;
    let state = app
        .try_state::<ReplyNotificationState>()
        .ok_or("Reply notifications unavailable")?;
    let mut runtime = state.runtime.lock().map_err(|e| e.to_string())?;
    if runtime.seen.contains(&run_id) {
        return Ok("duplicate".into());
    }
    runtime.seen.push_back(run_id);
    while runtime.seen.len() > 256 {
        runtime.seen.pop_front();
    }
    if !runtime.disk.preferences.enabled {
        return Ok("disabled".into());
    }
    if !eligible(&runtime.disk.preferences, minimized, focused) {
        return Ok("foreground".into());
    }
    windows_native::register(app)?;
    let token = windows_native::token()?;
    runtime.disk.routes.push_back(SavedRoute {
        token: token.clone(),
        created_at: chrono::Utc::now().timestamp_millis(),
        route,
    });
    prune(&mut runtime.disk);
    persist(&state, &runtime.disk)?;
    windows_native::show(app, &token, &body)
}

#[cfg(target_os = "windows")]
mod windows_native {
    use super::*;
    use windows::{
        core::{HSTRING, PCWSTR},
        Data::Xml::Dom::XmlDocument,
        Win32::System::{
            Com::CoCreateGuid,
            Registry::{
                RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
                REG_OPTION_NON_VOLATILE, REG_SZ,
            },
            WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        },
        UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager},
    };

    fn aumid(app: &AppHandle) -> String {
        format!(
            "{}{}",
            app.config().identifier,
            if cfg!(debug_assertions) {
                ".notifications.dev"
            } else {
                ""
            }
        )
    }

    fn set_string(path: &str, name: &str, value: &str) -> Result<(), String> {
        let path = HSTRING::from(path);
        let name = HSTRING::from(name);
        let bytes: Vec<u8> = value
            .encode_utf16()
            .chain(Some(0))
            .flat_map(u16::to_le_bytes)
            .collect();
        unsafe {
            let mut key = HKEY::default();
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                &path,
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                None,
                &mut key,
                None,
            )
            .ok()
            .map_err(|e| e.to_string())?;
            let result = RegSetValueExW(key, &name, None, REG_SZ, Some(&bytes))
                .ok()
                .map_err(|e| e.to_string());
            let _ = RegCloseKey(key);
            result
        }
    }

    pub fn register(app: &AppHandle) -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = exe.to_string_lossy();
        let root = format!("Software\\Classes\\{}", scheme());
        set_string(&root, "", "URL:OmniTavern reply notification")?;
        set_string(&root, "URL Protocol", "")?;
        set_string(
            &format!("{root}\\shell\\open\\command"),
            "",
            &format!("\"{exe}\" \"%1\""),
        )?;
        let root = format!("Software\\Classes\\AppUserModelId\\{}", aumid(app));
        set_string(&root, "DisplayName", "OmniTavern")?;
        let icon = app
            .path()
            .app_local_data_dir()
            .map_err(|e| e.to_string())?
            .join("reply-notification-icon.png");
        if !icon.exists() {
            std::fs::create_dir_all(icon.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::write(&icon, include_bytes!("../icons/128x128.png"))
                .map_err(|e| e.to_string())?;
        }
        set_string(&root, "IconUri", &icon.to_string_lossy())?;
        // Stub CLSID keeps protocol-activated desktop toasts in Notification Center.
        set_string(
            &root,
            "CustomActivator",
            "{9963370B-624D-4B12-96EC-6587CD03EF90}",
        )
    }

    pub fn token() -> Result<String, String> {
        Ok(format!(
            "{:?}",
            unsafe { CoCreateGuid() }.map_err(|e| e.to_string())?
        )
        .replace(['-', '{', '}'], "")
        .to_ascii_lowercase())
    }

    fn xml_escape(text: &str) -> String {
        text.chars()
            .filter(|c| *c >= ' ' || matches!(c, '\n' | '\t' | '\r'))
            .collect::<String>()
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    pub fn show(app: &AppHandle, token: &str, body: &str) -> Result<String, String> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|e| e.to_string())?;
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe {
                    RoUninitialize();
                }
            }
        }
        let _apartment = Apartment;
        let result = (|| -> Result<String, String> {
            let notifier =
                ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(aumid(app)))
                    .map_err(|e| format!("Create notifier: {e}"))?;
            match notifier.Setting() {
                Ok(NotificationSetting::Enabled) => {}
                Ok(_) => return Ok("system_disabled".into()),
                // Windows creates the settings entry on an unpackaged app's first
                // toast. The Toolkit's ToastNotifierCompat also handles this
                // prerequisite. Let Show perform that first registration; Windows
                // still enforces its own notification/Do Not Disturb settings.
                Err(error) if error.code().0 == 0x80070490u32 as i32 => {}
                Err(error) => return Err(format!("Read notification setting: {error}")),
            }
            let xml = XmlDocument::new().map_err(|e| format!("Create notification XML: {e}"))?;
            xml.LoadXml(&HSTRING::from(format!("<toast activationType=\"protocol\" launch=\"{}://open/{}\"><visual><binding template=\"ToastGeneric\"><text>OmniTavern</text><text>{}</text></binding></visual></toast>", scheme(), token, xml_escape(body)))).map_err(|e| format!("Load notification XML: {e}"))?;
            let toast = ToastNotification::CreateToastNotification(&xml)
                .map_err(|e| format!("Create toast: {e}"))?;
            toast
                .SetTag(&HSTRING::from(&token[..16]))
                .map_err(|e| format!("Set notification tag: {e}"))?;
            toast
                .SetGroup(&HSTRING::from("reply-complete"))
                .map_err(|e| format!("Set notification group: {e}"))?;
            notifier
                .Show(&toast)
                .map_err(|e| format!("Show notification: {e}"))?;
            Ok("sent".into())
        })();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_and_opaque_activation() {
        let mut prefs = Preferences::default();
        assert!(!eligible(&prefs, true, false));
        prefs.enabled = true;
        assert!(!eligible(&prefs, false, true));
        assert!(eligible(&prefs, false, false));
        assert!(eligible(&prefs, true, false));
        // Legacy timing values are ignored without changing the saved switch.
        for timing in ["minimized", "background"] {
            for enabled in [false, true] {
                let legacy: Preferences = serde_json::from_value(
                    serde_json::json!({"enabled": enabled, "timing": timing}),
                )
                .unwrap();
                assert_eq!(eligible(&legacy, false, false), enabled);
                assert_eq!(eligible(&legacy, true, false), enabled);
                assert!(!eligible(&legacy, false, true));
                assert_eq!(
                    serde_json::to_value(&legacy).unwrap(),
                    serde_json::json!({"enabled": enabled}),
                );
            }
        }
        let token = "1234567890abcdef1234567890abcdef";
        assert_eq!(
            parse_token(&format!("{}://open/{token}", scheme())),
            Some(token.into())
        );
        for url in [
            "https://open/x",
            "omnitavern-reply://open/../x",
            "omnitavern-reply://open/x?command=send",
        ] {
            assert_eq!(parse_token(url), None);
        }
        let mut disk = DiskState::default();
        for _ in 0..(LIMIT + 5) {
            disk.routes.push_back(SavedRoute {
                token: token.into(),
                created_at: chrono::Utc::now().timestamp_millis(),
                route: ReplyRoute {
                    persona_id: "p".into(),
                    scope_id: "p".into(),
                    session_id: "s".into(),
                    archive_id: "".into(),
                    message_id: "m".into(),
                    swipe_index: None,
                },
            });
        }
        prune(&mut disk);
        assert_eq!(disk.routes.len(), LIMIT);
    }
}
