use crate::memory_db::{
    MemoryCreateInput, MemoryDb, MemoryQuery, MemoryRecord, MemoryUpdateInput, TemplateInput,
    TemplateQuery, TemplateRecord,
};
use crate::storage::{simple_decrypt, simple_encrypt, ChatMessage};
use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine;
use gif::{Encoder as GifEncoder, Frame as GifFrame, Repeat as GifRepeat};
use image::imageops::overlay;
use image::RgbaImage;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::fs::OpenOptions;
use std::io::Cursor;
use std::io::{Read, Seek, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State, Window};
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

#[cfg(target_os = "android")]
use jni::objects::{JObject, JString, JValue};
#[cfg(target_os = "android")]
use jni::{JNIEnv, JavaVM};
#[cfg(target_os = "android")]
use ndk_context::android_context;
#[cfg(target_os = "android")]
use std::os::unix::io::{AsRawFd, FromRawFd};

/// 获取数据目录
fn get_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn restart_app(app: AppHandle) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        app.restart();
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        Err("restart_not_supported_on_mobile".to_string())
    }
}

fn is_kv_debug_enabled() -> bool {
    std::env::var("CHATAPP_DEBUG_KV")
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(false)
}

fn sanitize_segment(input: &str) -> String {
    let raw = input.trim();
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    let mut cleaned = if trimmed.is_empty() {
        "default".to_string()
    } else {
        out
    };
    const MAX_LEN: usize = 80;
    if cleaned.len() > MAX_LEN {
        cleaned.truncate(MAX_LEN);
    }
    cleaned
}

fn stable_session_asset_hash(input: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn sanitize_session_asset_segment(input: &str) -> String {
    let raw = input.trim();
    let legacy = sanitize_segment(raw);
    if raw.is_empty() || raw == legacy {
        return legacy;
    }

    const HASH_SEPARATOR: &str = "--";
    const HASH_LEN: usize = 16;
    const MAX_LEN: usize = 80;
    let digest = format!("{:016x}", stable_session_asset_hash(raw));
    let mut prefix = legacy.trim_matches('_').to_string();
    if prefix.is_empty() || prefix == "default" {
        prefix = "session".to_string();
    }
    let max_prefix_len = MAX_LEN - HASH_SEPARATOR.len() - HASH_LEN;
    if prefix.len() > max_prefix_len {
        prefix.truncate(max_prefix_len);
    }
    format!("{prefix}{HASH_SEPARATOR}{digest}")
}

fn session_asset_segments(session_id: &str) -> Vec<String> {
    let current = sanitize_session_asset_segment(session_id);
    let legacy = sanitize_segment(session_id);
    if current == legacy {
        vec![current]
    } else {
        vec![current, legacy]
    }
}

fn session_asset_roots(data_dir: &Path, base: &str, session_id: &str) -> Vec<PathBuf> {
    session_asset_segments(session_id)
        .into_iter()
        .map(|segment| data_dir.join(base).join(segment))
        .collect()
}

fn path_is_within_roots(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

fn sanitize_zip_entry_name(input: &str) -> String {
    let normalized = input.replace('\\', "/");
    let mut parts: Vec<String> = Vec::new();
    for raw_part in normalized.split('/') {
        let part = raw_part.trim();
        if part.is_empty() || part == "." || part == ".." {
            continue;
        }
        let mut cleaned = String::with_capacity(part.len());
        for ch in part.chars() {
            if matches!(
                ch,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0'
            ) || ch.is_control()
            {
                cleaned.push('_');
            } else {
                cleaned.push(ch);
            }
        }
        let trimmed = cleaned
            .trim_matches(|ch: char| ch.is_whitespace() || ch == '.')
            .trim_matches('_')
            .to_string();
        parts.push(if trimmed.is_empty() {
            "entry".to_string()
        } else {
            trimmed
        });
    }
    if parts.is_empty() {
        "entry".to_string()
    } else {
        parts.join("/")
    }
}

fn sanitize_download_name(input: &str) -> String {
    let raw = input.trim();
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if matches!(
            ch,
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0'
        ) {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim_matches('_');
    let mut cleaned = if trimmed.is_empty() {
        "download".to_string()
    } else {
        out
    };
    const MAX_LEN: usize = 80;
    if cleaned.len() > MAX_LEN {
        cleaned = cleaned.chars().take(MAX_LEN).collect();
    }
    cleaned
}

fn normalize_scope_id(input: &str) -> String {
    let raw = input.trim();
    if raw.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    const MAX_LEN: usize = 64;
    if out.len() > MAX_LEN {
        out.truncate(MAX_LEN);
    }
    out
}

fn validate_safe_key(raw: &str, label: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} empty"));
    }
    const MAX_LEN: usize = 120;
    if trimmed.len() > MAX_LEN {
        return Err(format!("{label} too long"));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("{label} contains invalid characters"));
    }
    Ok(trimmed.to_string())
}

fn chat_store_v2_base(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = get_data_dir(app)?;
    Ok(data_dir.join("chat_store_v2"))
}

fn chat_store_v2_scope_dir(app: &AppHandle, scope: &str) -> Result<PathBuf, String> {
    let scope_key = if scope.trim().is_empty() {
        "default".to_string()
    } else {
        validate_safe_key(scope, "scope")?
    };
    let base = chat_store_v2_base(app)?;
    Ok(base.join(format!("scope_{scope_key}")))
}

fn chat_store_v2_thread_dir(
    app: &AppHandle,
    scope: &str,
    session_dir: &str,
    thread_dir: &str,
) -> Result<PathBuf, String> {
    let scope_dir = chat_store_v2_scope_dir(app, scope)?;
    let session_key = validate_safe_key(session_dir, "session_dir")?;
    let thread_key = validate_safe_key(thread_dir, "thread_dir")?;
    Ok(scope_dir
        .join(format!("session_{session_key}"))
        .join(format!("thread_{thread_key}")))
}

fn chat_store_v2_field_path(
    app: &AppHandle,
    scope: &str,
    session_dir: &str,
    thread_dir: &str,
    field_id: &str,
) -> Result<PathBuf, String> {
    let dir = chat_store_v2_thread_dir(app, scope, session_dir, thread_dir)?;
    let field_key = validate_safe_key(field_id, "field_id")?;
    Ok(dir.join("fields").join(format!("{field_key}.txt")))
}

fn write_json_file(path: &Path, data: &Value) -> Result<(), String> {
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, json).map_err(|e| e.to_string())?;
    #[cfg(target_os = "android")]
    {
        if let Ok(f) = fs::File::open(path) {
            unsafe {
                libc::fsync(f.as_raw_fd());
            }
        }
    }
    Ok(())
}

fn write_bytes_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, bytes).map_err(|e| e.to_string())?;
    #[cfg(target_os = "android")]
    {
        if let Ok(f) = fs::File::open(path) {
            unsafe {
                libc::fsync(f.as_raw_fd());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn write_text_file(path: String, text: String) -> Result<(), String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("path empty".to_string());
    }
    let file = PathBuf::from(raw);
    write_bytes_file(&file, text.as_bytes())
}

fn decode_data_url(data_url: &str) -> Result<(Vec<u8>, Option<String>), String> {
    let raw = data_url.trim();
    if !raw.starts_with("data:") {
        return Err("invalid data url".to_string());
    }
    let mut parts = raw.splitn(2, ',');
    let meta = parts.next().unwrap_or("");
    let payload = parts.next().unwrap_or("");
    if payload.is_empty() {
        return Err("empty data payload".to_string());
    }
    let mime = meta.strip_prefix("data:").unwrap_or("");
    let mut mime_parts = mime.split(';');
    let mime_type = mime_parts.next().unwrap_or("");
    let ext = match mime_type {
        "image/png" => Some("png".to_string()),
        "image/jpeg" => Some("jpg".to_string()),
        "image/jpg" => Some("jpg".to_string()),
        "image/webp" => Some("webp".to_string()),
        "image/gif" => Some("gif".to_string()),
        _ => None,
    };
    let bytes = BASE64_ENGINE.decode(payload).map_err(|e| e.to_string())?;
    Ok((bytes, ext))
}

fn extension_from_name(name: &str) -> Option<String> {
    let raw = name.trim();
    if raw.is_empty() {
        return None;
    }
    let ext = Path::new(raw).extension()?.to_string_lossy().to_string();
    if ext.is_empty() {
        None
    } else {
        Some(ext)
    }
}

fn mime_from_extension(ext: &str) -> Option<String> {
    match ext.to_lowercase().as_str() {
        "png" => Some("image/png".to_string()),
        "jpg" | "jpeg" => Some("image/jpeg".to_string()),
        "webp" => Some("image/webp".to_string()),
        "gif" => Some("image/gif".to_string()),
        "zip" => Some("application/zip".to_string()),
        "bmp" => Some("image/bmp".to_string()),
        "svg" => Some("image/svg+xml".to_string()),
        _ => None,
    }
}

fn is_image_mime(mime: &str) -> bool {
    mime.starts_with("image/")
}

fn mime_from_data_url(data_url: &str) -> Option<String> {
    let raw = data_url.trim();
    if !raw.starts_with("data:") {
        return None;
    }
    let mut parts = raw.splitn(2, ',');
    let meta = parts.next().unwrap_or("");
    let mime = meta
        .strip_prefix("data:")
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("");
    if mime.is_empty() {
        None
    } else {
        Some(mime.to_string())
    }
}

fn ensure_extension(name: &str, ext: Option<&str>) -> String {
    if extension_from_name(name).is_some() {
        name.to_string()
    } else if let Some(ext) = ext {
        format!("{name}.{ext}")
    } else {
        name.to_string()
    }
}

fn raw_reply_path(app: &AppHandle, session_id: &str, message_id: &str) -> Result<PathBuf, String> {
    let data_dir = get_data_dir(app)?;
    let sid = sanitize_session_asset_segment(session_id);
    let mid = sanitize_segment(message_id);
    Ok(data_dir
        .join("raw_replies")
        .join(sid)
        .join(format!("{mid}.txt")))
}

fn raw_reply_paths(
    app: &AppHandle,
    session_id: &str,
    message_id: &str,
) -> Result<Vec<PathBuf>, String> {
    let data_dir = get_data_dir(app)?;
    let mid = sanitize_segment(message_id);
    Ok(session_asset_roots(&data_dir, "raw_replies", session_id)
        .into_iter()
        .map(|root| root.join(format!("{mid}.txt")))
        .collect())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Err(format!("source directory missing: {}", src.display()));
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &target)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(&path, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct MediaBundleInfo {
    pub ready: bool,
    pub copied: bool,
    pub base_dir: String,
    pub manifest: Option<Value>,
    pub warning: Option<String>,
}

#[derive(serde::Serialize)]
pub struct WallpaperSaveResult {
    pub path: String,
    pub bytes: usize,
}

#[derive(serde::Serialize)]
pub struct AttachmentSaveResult {
    pub path: String,
    pub bytes: usize,
}

#[derive(serde::Serialize)]
pub struct AttachmentDataUrlResult {
    #[serde(rename = "dataUrl")]
    pub data_url: String,
    pub bytes: usize,
    pub mime: String,
}

#[derive(serde::Deserialize)]
pub struct StickerZipEntry {
    pub name: String,
    #[serde(rename = "path")]
    pub path: Option<String>,
    #[serde(rename = "dataUrl", alias = "data_url")]
    pub data_url: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct SaveDialogFilter {
    pub name: String,
    #[serde(default)]
    pub extensions: Vec<String>,
}

#[derive(Default)]
pub struct WallpaperStreamState {
    inner: Mutex<HashMap<String, WallpaperStreamEntry>>,
}

struct WallpaperStreamEntry {
    path: PathBuf,
    previous_path: Option<String>,
}

#[derive(Default)]
pub struct AttachmentStreamState {
    inner: Mutex<HashMap<String, AttachmentStreamEntry>>,
}

struct AttachmentStreamEntry {
    path: PathBuf,
}

#[derive(Default)]
pub struct HttpAbortState {
    inner: Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>,
}

#[derive(Default)]
pub struct HttpStreamState {
    inner: Arc<Mutex<HashMap<String, HttpStreamEntry>>>,
}

#[derive(Default)]
struct HttpStreamEntry {
    status: Option<u16>,
    ok: Option<bool>,
    headers: Option<HashMap<String, String>>,
    chunks: VecDeque<String>,
    done: bool,
    error: Option<String>,
}

#[derive(serde::Serialize)]
pub struct WallpaperStreamStartResult {
    pub upload_id: String,
    pub path: String,
}

#[derive(serde::Serialize)]
pub struct AttachmentStreamStartResult {
    pub upload_id: String,
    pub path: String,
}

#[derive(serde::Serialize)]
pub struct WallpaperCleanupResult {
    pub removed: usize,
    pub kept: usize,
}

#[derive(serde::Serialize)]
pub struct DataBundleResult {
    pub path: String,
    pub bytes: u64,
    pub files: usize,
}

#[derive(serde::Serialize)]
pub struct HttpStreamReadResult {
    pub status: Option<u16>,
    pub ok: Option<bool>,
    pub headers: Option<HashMap<String, String>>,
    pub chunks: Vec<String>,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(serde::Serialize)]
pub struct DataBundleImportResult {
    pub files: usize,
    pub skipped: usize,
}

fn decode_base64_payload(payload: &str) -> Result<Vec<u8>, String> {
    let raw = payload.trim();
    if raw.is_empty() {
        return Err("empty base64 payload".to_string());
    }
    let data = if raw.starts_with("data:") {
        let mut parts = raw.splitn(2, ',');
        let _meta = parts.next().unwrap_or("");
        parts.next().unwrap_or("")
    } else {
        raw
    };
    if data.is_empty() {
        return Err("empty base64 payload".to_string());
    }
    BASE64_ENGINE.decode(data).map_err(|e| e.to_string())
}

#[cfg(target_os = "android")]
fn resolve_export_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = get_data_dir(app).ok();
    let is_private = |dir: &PathBuf| {
        if let Some(base) = &app_data {
            if dir.starts_with(base) {
                return true;
            }
        }
        let raw = dir.to_string_lossy().to_lowercase();
        raw.contains("/android/data/") || raw.contains("/android/obb/")
    };
    if let Ok(dir) = app.path().download_dir() {
        if !is_private(&dir) {
            return Ok(dir);
        }
    }
    let mut candidates = Vec::new();
    if let Ok(base) = std::env::var("EXTERNAL_STORAGE") {
        candidates.push(PathBuf::from(base).join("Download"));
    }
    candidates.push(PathBuf::from("/storage/emulated/0/Download"));
    candidates.push(PathBuf::from("/sdcard/Download"));
    for dir in candidates {
        if fs::create_dir_all(&dir).is_ok() {
            return Ok(dir);
        }
    }
    Err("无法定位可写的下载目录，请检查系统权限".to_string())
}

#[cfg(not(target_os = "android"))]
fn resolve_export_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = app.path().download_dir() {
        return Ok(dir);
    }
    if let Ok(dir) = app.path().document_dir() {
        return Ok(dir);
    }
    get_data_dir(app)
}

#[cfg(target_os = "android")]
fn android_sdk_int(env: &mut JNIEnv) -> Result<i32, String> {
    let class = env
        .find_class("android/os/Build$VERSION")
        .map_err(|e| e.to_string())?;
    env.get_static_field(class, "SDK_INT", "I")
        .and_then(|value| value.i())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "android")]
fn android_scan_file(env: &mut JNIEnv, context: &JObject, path: &Path) -> Result<(), String> {
    let scan_class = env
        .find_class("android/media/MediaScannerConnection")
        .map_err(|e| e.to_string())?;
    let path_str = path.to_string_lossy();
    let path_java = env
        .new_string(path_str.as_ref())
        .map_err(|e| e.to_string())?;
    let array = env
        .new_object_array(1, "java/lang/String", JObject::from(path_java))
        .map_err(|e| e.to_string())?;
    let null_obj = JObject::null();
    env.call_static_method(
        scan_class,
        "scanFile",
        "(Landroid/content/Context;[Ljava/lang/String;[Ljava/lang/String;Landroid/media/MediaScannerConnection$OnScanCompletedListener;)V",
        &[
            JValue::Object(context),
            JValue::Object(&array),
            JValue::Object(&null_obj),
            JValue::Object(&null_obj),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "android")]
fn android_public_download_dir(env: &mut JNIEnv) -> Result<PathBuf, String> {
    let env_class = env
        .find_class("android/os/Environment")
        .map_err(|e| e.to_string())?;
    let dir_key = env
        .get_static_field(&env_class, "DIRECTORY_DOWNLOADS", "Ljava/lang/String;")
        .and_then(|value| value.l())
        .map_err(|e| e.to_string())?;
    let dir_file = env
        .call_static_method(
            env_class,
            "getExternalStoragePublicDirectory",
            "(Ljava/lang/String;)Ljava/io/File;",
            &[JValue::Object(&dir_key)],
        )
        .and_then(|value| value.l())
        .map_err(|e| e.to_string())?;
    let dir_path = env
        .call_method(dir_file, "getAbsolutePath", "()Ljava/lang/String;", &[])
        .and_then(|value| value.l())
        .map_err(|e| e.to_string())?;
    let dir_str: String = env
        .get_string(&JString::from(dir_path))
        .map_err(|e| e.to_string())?
        .into();
    Ok(PathBuf::from(dir_str))
}

#[cfg(target_os = "android")]
fn publish_bundle_legacy(
    app: &AppHandle,
    source_path: &Path,
    file_name: &str,
) -> Result<String, String> {
    let export_dir = resolve_export_dir(app)?;
    let target = export_dir.join(file_name);
    if source_path != target {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(source_path, &target).map_err(|e| e.to_string())?;
    }
    let ctx = android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let _ = android_scan_file(&mut env, &context, &target);
    Ok(target.to_string_lossy().to_string())
}

#[cfg(target_os = "android")]
fn publish_bundle_mediastore(
    env: &mut JNIEnv,
    context: JObject,
    source_path: &Path,
    file_name: &str,
) -> Result<String, String> {
    let resolver = env
        .call_method(
            &context,
            "getContentResolver",
            "()Landroid/content/ContentResolver;",
            &[],
        )
        .and_then(|value| value.l())
        .map_err(|e| e.to_string())?;
    let values = env
        .new_object("android/content/ContentValues", "()V", &[])
        .map_err(|e| e.to_string())?;
    let media_columns = env
        .find_class("android/provider/MediaStore$MediaColumns")
        .map_err(|e| e.to_string())?;
    let display_key = env
        .get_static_field(&media_columns, "DISPLAY_NAME", "Ljava/lang/String;")
        .and_then(|value| value.l())
        .map_err(|e| e.to_string())?;
    let mime_key = env
        .get_static_field(&media_columns, "MIME_TYPE", "Ljava/lang/String;")
        .and_then(|value| value.l())
        .map_err(|e| e.to_string())?;
    let display_value = env.new_string(file_name).map_err(|e| e.to_string())?;
    let display_value_obj = JObject::from(display_value);
    env.call_method(
        &values,
        "put",
        "(Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&display_key),
            JValue::Object(&display_value_obj),
        ],
    )
    .map_err(|e| e.to_string())?;
    let mime_guess = extension_from_name(file_name)
        .and_then(|ext| mime_from_extension(&ext))
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let mime_value = env.new_string(mime_guess).map_err(|e| e.to_string())?;
    let mime_value_obj = JObject::from(mime_value);
    env.call_method(
        &values,
        "put",
        "(Ljava/lang/String;Ljava/lang/String;)V",
        &[JValue::Object(&mime_key), JValue::Object(&mime_value_obj)],
    )
    .map_err(|e| e.to_string())?;
    if let Ok(relative_key) = env
        .get_static_field(&media_columns, "RELATIVE_PATH", "Ljava/lang/String;")
        .and_then(|value| value.l())
    {
        if let Ok(relative_value) = env.new_string("Download/") {
            let relative_value_obj = JObject::from(relative_value);
            let _ = env.call_method(
                &values,
                "put",
                "(Ljava/lang/String;Ljava/lang/String;)V",
                &[
                    JValue::Object(&relative_key),
                    JValue::Object(&relative_value_obj),
                ],
            );
        }
    }
    if let Ok(pending_key) = env
        .get_static_field(&media_columns, "IS_PENDING", "Ljava/lang/String;")
        .and_then(|value| value.l())
    {
        if let Ok(int_class) = env.find_class("java/lang/Integer") {
            if let Ok(pending_value) = env
                .call_static_method(
                    int_class,
                    "valueOf",
                    "(I)Ljava/lang/Integer;",
                    &[JValue::from(1)],
                )
                .and_then(|value| value.l())
            {
                let _ = env.call_method(
                    &values,
                    "put",
                    "(Ljava/lang/String;Ljava/lang/Integer;)V",
                    &[JValue::Object(&pending_key), JValue::Object(&pending_value)],
                );
            }
        }
    }
    let downloads_class = env
        .find_class("android/provider/MediaStore$Downloads")
        .map_err(|e| e.to_string())?;
    let base_uri = env
        .get_static_field(downloads_class, "EXTERNAL_CONTENT_URI", "Landroid/net/Uri;")
        .and_then(|value| value.l())
        .map_err(|e| e.to_string())?;
    let inserted = env
        .call_method(
            &resolver,
            "insert",
            "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;",
            &[JValue::Object(&base_uri), JValue::Object(&values)],
        )
        .and_then(|value| value.l())
        .map_err(|e| e.to_string())?;
    if inserted.is_null() {
        return Err("无法写入下载目录".to_string());
    }
    let mode = env.new_string("w").map_err(|e| e.to_string())?;
    let mode_obj = JObject::from(mode);
    let pfd = env
        .call_method(
            &resolver,
            "openFileDescriptor",
            "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;",
            &[JValue::Object(&inserted), JValue::Object(&mode_obj)],
        )
        .and_then(|value| value.l())
        .map_err(|e| e.to_string())?;
    if pfd.is_null() {
        return Err("无法打开下载文件".to_string());
    }
    let fd = env
        .call_method(&pfd, "detachFd", "()I", &[])
        .and_then(|value| value.i())
        .map_err(|e| e.to_string())?;
    if fd < 0 {
        return Err("无法创建下载文件".to_string());
    }
    {
        let mut input = fs::File::open(source_path).map_err(|e| e.to_string())?;
        let mut output = unsafe { fs::File::from_raw_fd(fd) };
        std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
    }
    let _ = env.call_method(&pfd, "close", "()V", &[]);
    if let Ok(pending_key) = env
        .get_static_field(&media_columns, "IS_PENDING", "Ljava/lang/String;")
        .and_then(|value| value.l())
    {
        if let Ok(values) = env.new_object("android/content/ContentValues", "()V", &[]) {
            if let Ok(int_class) = env.find_class("java/lang/Integer") {
                if let Ok(pending_value) = env
                    .call_static_method(
                        int_class,
                        "valueOf",
                        "(I)Ljava/lang/Integer;",
                        &[JValue::from(0)],
                    )
                    .and_then(|value| value.l())
                {
                    let _ = env.call_method(
                        &values,
                        "put",
                        "(Ljava/lang/String;Ljava/lang/Integer;)V",
                        &[JValue::Object(&pending_key), JValue::Object(&pending_value)],
                    );
                    let null_obj = JObject::null();
                    let _ = env.call_method(
                        &resolver,
                        "update",
                        "(Landroid/net/Uri;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I",
                        &[
                            JValue::Object(&inserted),
                            JValue::Object(&values),
                            JValue::Object(&null_obj),
                            JValue::Object(&null_obj),
                        ],
                    );
                }
            }
        }
    }
    let download_path = android_public_download_dir(env)
        .map(|dir| dir.join(file_name))
        .unwrap_or_else(|_| PathBuf::from("Download").join(file_name));
    let _ = android_scan_file(env, &context, &download_path);
    Ok(download_path.to_string_lossy().to_string())
}

#[cfg(target_os = "android")]
fn publish_bundle_to_downloads(
    app: &AppHandle,
    source_path: &Path,
    file_name: &str,
) -> Result<String, String> {
    let ctx = android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let sdk_int = android_sdk_int(&mut env).unwrap_or(29);
    if sdk_int < 29 {
        return publish_bundle_legacy(app, source_path, file_name);
    }
    publish_bundle_mediastore(&mut env, context, source_path, file_name)
        .or_else(|_| publish_bundle_legacy(app, source_path, file_name))
}

#[cfg(not(target_os = "android"))]
fn publish_bundle_to_downloads(
    app: &AppHandle,
    source_path: &Path,
    file_name: &str,
) -> Result<String, String> {
    let export_dir = resolve_export_dir(app)?;
    let target = export_dir.join(file_name);
    if source_path != target {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(source_path, &target).map_err(|e| e.to_string())?;
    }
    Ok(target.to_string_lossy().to_string())
}

#[cfg(target_os = "android")]
fn publish_image_to_gallery_bytes(
    bytes: &[u8],
    file_name: &str,
    mime_type: &str,
) -> Result<String, String> {
    let ctx = android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let resolver = env
        .call_method(
            &context,
            "getContentResolver",
            "()Landroid/content/ContentResolver;",
            &[],
        )
        .and_then(|value| value.l())
        .map_err(|e| e.to_string())?;
    let values = env
        .new_object("android/content/ContentValues", "()V", &[])
        .map_err(|e| e.to_string())?;
    let media_columns = env
        .find_class("android/provider/MediaStore$MediaColumns")
        .map_err(|e| e.to_string())?;
    let display_key = env
        .get_static_field(&media_columns, "DISPLAY_NAME", "Ljava/lang/String;")
        .and_then(|value| value.l())
        .map_err(|e| e.to_string())?;
    let mime_key = env
        .get_static_field(&media_columns, "MIME_TYPE", "Ljava/lang/String;")
        .and_then(|value| value.l())
        .map_err(|e| e.to_string())?;
    let display_value = env.new_string(file_name).map_err(|e| e.to_string())?;
    let display_value_obj = JObject::from(display_value);
    env.call_method(
        &values,
        "put",
        "(Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&display_key),
            JValue::Object(&display_value_obj),
        ],
    )
    .map_err(|e| e.to_string())?;
    let mime_value = env.new_string(mime_type).map_err(|e| e.to_string())?;
    let mime_value_obj = JObject::from(mime_value);
    env.call_method(
        &values,
        "put",
        "(Ljava/lang/String;Ljava/lang/String;)V",
        &[JValue::Object(&mime_key), JValue::Object(&mime_value_obj)],
    )
    .map_err(|e| e.to_string())?;
    if let Ok(relative_key) = env
        .get_static_field(&media_columns, "RELATIVE_PATH", "Ljava/lang/String;")
        .and_then(|value| value.l())
    {
        if let Ok(relative_value) = env.new_string("Pictures/") {
            let relative_value_obj = JObject::from(relative_value);
            let _ = env.call_method(
                &values,
                "put",
                "(Ljava/lang/String;Ljava/lang/String;)V",
                &[
                    JValue::Object(&relative_key),
                    JValue::Object(&relative_value_obj),
                ],
            );
        }
    }
    if let Ok(pending_key) = env
        .get_static_field(&media_columns, "IS_PENDING", "Ljava/lang/String;")
        .and_then(|value| value.l())
    {
        if let Ok(int_class) = env.find_class("java/lang/Integer") {
            if let Ok(pending_value) = env
                .call_static_method(
                    int_class,
                    "valueOf",
                    "(I)Ljava/lang/Integer;",
                    &[JValue::from(1)],
                )
                .and_then(|value| value.l())
            {
                let _ = env.call_method(
                    &values,
                    "put",
                    "(Ljava/lang/String;Ljava/lang/Integer;)V",
                    &[JValue::Object(&pending_key), JValue::Object(&pending_value)],
                );
            }
        }
    }
    let images_class = env
        .find_class("android/provider/MediaStore$Images$Media")
        .map_err(|e| e.to_string())?;
    let base_uri = env
        .get_static_field(images_class, "EXTERNAL_CONTENT_URI", "Landroid/net/Uri;")
        .and_then(|value| value.l())
        .map_err(|e| e.to_string())?;
    let inserted = env
        .call_method(
            &resolver,
            "insert",
            "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;",
            &[JValue::Object(&base_uri), JValue::Object(&values)],
        )
        .and_then(|value| value.l())
        .map_err(|e| e.to_string())?;
    if inserted.is_null() {
        return Err("无法写入相簿".to_string());
    }
    let mode = env.new_string("w").map_err(|e| e.to_string())?;
    let mode_obj = JObject::from(mode);
    let pfd = env
        .call_method(
            &resolver,
            "openFileDescriptor",
            "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;",
            &[JValue::Object(&inserted), JValue::Object(&mode_obj)],
        )
        .and_then(|value| value.l())
        .map_err(|e| e.to_string())?;
    if pfd.is_null() {
        return Err("无法打开相簿文件".to_string());
    }
    let fd = env
        .call_method(&pfd, "detachFd", "()I", &[])
        .and_then(|value| value.i())
        .map_err(|e| e.to_string())?;
    if fd < 0 {
        return Err("无法创建相簿文件".to_string());
    }
    {
        let mut output = unsafe { fs::File::from_raw_fd(fd) };
        output.write_all(bytes).map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
    }
    let _ = env.call_method(&pfd, "close", "()V", &[]);
    if let Ok(pending_key) = env
        .get_static_field(&media_columns, "IS_PENDING", "Ljava/lang/String;")
        .and_then(|value| value.l())
    {
        if let Ok(values) = env.new_object("android/content/ContentValues", "()V", &[]) {
            if let Ok(int_class) = env.find_class("java/lang/Integer") {
                if let Ok(pending_value) = env
                    .call_static_method(
                        int_class,
                        "valueOf",
                        "(I)Ljava/lang/Integer;",
                        &[JValue::from(0)],
                    )
                    .and_then(|value| value.l())
                {
                    let _ = env.call_method(
                        &values,
                        "put",
                        "(Ljava/lang/String;Ljava/lang/Integer;)V",
                        &[JValue::Object(&pending_key), JValue::Object(&pending_value)],
                    );
                    let _ = env.call_method(
                        &resolver,
                        "update",
                        "(Landroid/net/Uri;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I",
                        &[
                            JValue::Object(&inserted),
                            JValue::Object(&values),
                            JValue::Object(&JObject::null()),
                            JValue::Object(&JObject::null()),
                        ],
                    );
                }
            }
        }
    }
    Ok(format!("Pictures/{}", file_name))
}

fn clear_data_dir(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn is_sensitive_bundle_path(path: &Path) -> bool {
    let name = match path.file_name().and_then(|s| s.to_str()) {
        Some(value) => value,
        None => return false,
    };
    name == "config.json"
        || is_profile_store_file_name(name)
        || is_keyring_store_file_name(name)
        || is_keyring_master_store_file_name(name)
}

fn is_profile_store_file_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    lower == "llm_profiles_v1.json"
        || (lower.starts_with("llm_profiles_") && lower.ends_with("_v1.json"))
}

fn is_keyring_store_file_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    lower == "llm_keyring_v1.json"
        || (lower.starts_with("llm_keyring_")
            && lower.ends_with("_v1.json")
            && !lower.starts_with("llm_keyring_master_"))
}

fn is_keyring_master_store_file_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    lower == "llm_keyring_master_v1.json"
        || (lower.starts_with("llm_keyring_master_") && lower.ends_with("_v1.json"))
}

fn is_app_settings_store_file_name(name: &str) -> bool {
    name.trim().eq_ignore_ascii_case("app_settings_v1.json")
}

fn sanitize_app_settings_store_value(mut value: Value) -> Value {
    if let Some(root) = value.as_object_mut() {
        for field in [
            "webSearchApiKey",
            "braveSearchApiKey",
            "tavilyApiKey",
            "serpApiKey",
        ] {
            root.remove(field);
        }
    }
    value
}

fn sanitize_profile_store_value(mut value: Value) -> Value {
    if let Some(root) = value.as_object_mut() {
        if let Some(profiles_value) = root.get_mut("profiles") {
            if let Some(profiles) = profiles_value.as_object_mut() {
                for profile in profiles.values_mut() {
                    if let Some(obj) = profile.as_object_mut() {
                        obj.insert("activeKeyId".to_string(), Value::Null);
                        obj.insert("webSearchEnabled".to_string(), Value::Bool(false));
                        obj.insert("proxyAuthToken".to_string(), Value::String(String::new()));
                        obj.insert(
                            "vertexaiServiceAccount".to_string(),
                            Value::String(String::new()),
                        );
                        obj.insert("_saEncrypted".to_string(), Value::Bool(false));
                    }
                }
            }
        }
    }
    value
}

fn add_sanitized_profile_stores_to_zip<W: Write + Seek>(
    writer: &mut ZipWriter<W>,
    data_dir: &Path,
    options: FileOptions,
) -> Result<usize, String> {
    let mut count = 0usize;
    for entry in fs::read_dir(data_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(value) => value,
            None => continue,
        };
        if !is_profile_store_file_name(file_name) {
            continue;
        }
        let json = match fs::read_to_string(&path) {
            Ok(value) => value,
            Err(err) => {
                eprintln!(
                    "[export_data_bundle] skip profile store (read failed): {:?}, {}",
                    path, err
                );
                continue;
            }
        };
        let raw_value: Value = match serde_json::from_str(&json) {
            Ok(value) => value,
            Err(err) => {
                eprintln!(
                    "[export_data_bundle] skip profile store (parse failed): {:?}, {}",
                    path, err
                );
                continue;
            }
        };
        let safe_value = sanitize_profile_store_value(raw_value);
        let safe_json = serde_json::to_string_pretty(&safe_value).map_err(|e| e.to_string())?;
        let rel = path
            .strip_prefix(data_dir)
            .map_err(|_| "invalid profile store path".to_string())?;
        let zip_name = rel.to_string_lossy().replace('\\', "/");
        writer
            .start_file(zip_name, options)
            .map_err(|e| e.to_string())?;
        writer
            .write_all(safe_json.as_bytes())
            .map_err(|e| e.to_string())?;
        count += 1;
    }
    Ok(count)
}

fn add_dir_to_zip<W: Write + Seek>(
    writer: &mut ZipWriter<W>,
    base: &Path,
    dir: &Path,
    options: FileOptions,
    skip: Option<&Path>,
) -> Result<usize, String> {
    if is_sensitive_bundle_path(dir) {
        return Ok(0);
    }
    if let Some(skip_path) = skip {
        if dir == skip_path {
            return Ok(0);
        }
    }
    if dir.is_dir() {
        let rel = dir
            .strip_prefix(base)
            .map_err(|_| "invalid base path".to_string())?;
        if !rel.as_os_str().is_empty() {
            let name = format!("{}/", rel.to_string_lossy().replace('\\', "/"));
            writer
                .add_directory(name, options)
                .map_err(|e| e.to_string())?;
        }
        let mut count = 0;
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            count += add_dir_to_zip(writer, base, &entry.path(), options, skip)?;
        }
        return Ok(count);
    }
    let rel = dir
        .strip_prefix(base)
        .map_err(|_| "invalid base path".to_string())?;
    let name = rel.to_string_lossy().replace('\\', "/");
    if dir
        .file_name()
        .and_then(|value| value.to_str())
        .map(is_app_settings_store_file_name)
        .unwrap_or(false)
    {
        let raw = fs::read_to_string(dir).map_err(|e| e.to_string())?;
        let value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let safe = sanitize_app_settings_store_value(value);
        let json = serde_json::to_vec_pretty(&safe).map_err(|e| e.to_string())?;
        writer
            .start_file(name, options)
            .map_err(|e| e.to_string())?;
        writer.write_all(&json).map_err(|e| e.to_string())?;
        return Ok(1);
    }
    writer
        .start_file(name, options)
        .map_err(|e| e.to_string())?;
    let mut file = fs::File::open(dir).map_err(|e| e.to_string())?;
    std::io::copy(&mut file, writer).map_err(|e| e.to_string())?;
    Ok(1)
}

fn import_bundle_from_reader<R: Read + Seek>(
    data_dir: &Path,
    memory_db: &MemoryDb,
    reader: R,
    mode: &str,
) -> Result<DataBundleImportResult, String> {
    memory_db.close_all();
    if mode != "merge" {
        clear_data_dir(data_dir)?;
    }
    let mut archive = ZipArchive::new(reader).map_err(|e| e.to_string())?;
    let mut files = 0usize;
    let mut skipped = 0usize;
    for i in 0..archive.len() {
        let mut file = match archive.by_index(i) {
            Ok(entry) => entry,
            Err(err) => {
                skipped += 1;
                eprintln!("[import_bundle] read entry failed: {}", err);
                continue;
            }
        };
        let name = file.name().to_string();
        if name == "bundle.json" {
            continue;
        }
        if is_sensitive_bundle_path(Path::new(&name)) {
            continue;
        }
        if name.ends_with('/') {
            let Some(rel) = file.enclosed_name() else {
                skipped += 1;
                eprintln!("[import_bundle] unsafe path: {}", name);
                continue;
            };
            let out_dir = data_dir.join(rel);
            if let Err(err) = fs::create_dir_all(&out_dir) {
                skipped += 1;
                eprintln!("[import_bundle] mkdir failed: {} ({})", name, err);
            }
            continue;
        }
        let Some(rel) = file.enclosed_name() else {
            skipped += 1;
            eprintln!("[import_bundle] unsafe path: {}", name);
            continue;
        };
        let out_path = data_dir.join(rel);
        if let Some(parent) = out_path.parent() {
            if let Err(err) = fs::create_dir_all(parent) {
                skipped += 1;
                eprintln!("[import_bundle] mkdir failed: {} ({})", name, err);
                continue;
            }
        }
        if out_path
            .file_name()
            .and_then(|value| value.to_str())
            .map(is_app_settings_store_file_name)
            .unwrap_or(false)
        {
            let mut raw = String::new();
            if let Err(err) = file.read_to_string(&mut raw) {
                skipped += 1;
                eprintln!(
                    "[import_bundle] read app settings failed: {} ({})",
                    name, err
                );
                continue;
            }
            let value: Value = match serde_json::from_str(&raw) {
                Ok(value) => value,
                Err(err) => {
                    skipped += 1;
                    eprintln!(
                        "[import_bundle] parse app settings failed: {} ({})",
                        name, err
                    );
                    continue;
                }
            };
            let safe = sanitize_app_settings_store_value(value);
            let safe_json = match serde_json::to_vec_pretty(&safe) {
                Ok(value) => value,
                Err(err) => {
                    skipped += 1;
                    eprintln!(
                        "[import_bundle] encode app settings failed: {} ({})",
                        name, err
                    );
                    continue;
                }
            };
            if let Err(err) = fs::write(&out_path, safe_json) {
                skipped += 1;
                eprintln!(
                    "[import_bundle] write app settings failed: {} ({})",
                    name, err
                );
                continue;
            }
            files += 1;
            continue;
        }
        let mut outfile = match fs::File::create(&out_path) {
            Ok(f) => f,
            Err(err) => {
                skipped += 1;
                eprintln!("[import_bundle] create file failed: {} ({})", name, err);
                continue;
            }
        };
        if let Err(err) = std::io::copy(&mut file, &mut outfile) {
            skipped += 1;
            eprintln!("[import_bundle] write failed: {} ({})", name, err);
            continue;
        }
        files += 1;
    }
    Ok(DataBundleImportResult { files, skipped })
}

/// Ensure bundled media assets exist in app data dir.
#[tauri::command]
pub async fn ensure_media_bundle(app: AppHandle) -> Result<MediaBundleInfo, String> {
    let data_dir = get_data_dir(&app)?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let target_dir = data_dir.join("media");
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let manifest_path = target_dir.join("manifest.json");

    let mut copied = false;
    let mut warning = None;
    match app.path().resource_dir() {
        Ok(resource_dir) => {
            let candidates = [
                resource_dir.join("media"),
                resource_dir.join("resources").join("media"),
                resource_dir
                    .join("src-tauri")
                    .join("resources")
                    .join("media"),
            ];
            let mut picked = None;
            for dir in candidates {
                if dir.exists() {
                    picked = Some(dir);
                    break;
                }
            }
            if let Some(src_dir) = picked {
                let src_manifest_path = src_dir.join("manifest.json");
                let src_manifest_text = fs::read_to_string(&src_manifest_path).ok();
                let dst_manifest_text = fs::read_to_string(&manifest_path).ok();
                let should_refresh = !manifest_path.exists()
                    || matches!(
                        (src_manifest_text.as_deref(), dst_manifest_text.as_deref()),
                        (Some(src), Some(dst)) if src != dst
                    );
                if should_refresh {
                    if target_dir.exists() {
                        if let Err(err) = fs::remove_dir_all(&target_dir) {
                            warning = Some(format!("remove media bundle failed: {}", err));
                        }
                    }
                    if warning.is_none() {
                        if let Err(err) = fs::create_dir_all(&target_dir) {
                            warning = Some(format!("create media bundle dir failed: {}", err));
                        } else if let Err(err) = copy_dir_recursive(&src_dir, &target_dir) {
                            warning = Some(format!("copy media bundle failed: {}", err));
                        } else {
                            copied = true;
                        }
                    }
                }
            } else {
                warning = Some("media bundle not found in resources".to_string());
            }
        }
        Err(err) => {
            warning = Some(format!("resource_dir unavailable: {}", err));
        }
    }

    let manifest = if manifest_path.exists() {
        match fs::read_to_string(&manifest_path) {
            Ok(json) => serde_json::from_str::<Value>(&json).ok(),
            Err(err) => {
                warning = Some(format!("read media manifest failed: {}", err));
                None
            }
        }
    } else {
        None
    };

    Ok(MediaBundleInfo {
        ready: manifest.is_some(),
        copied,
        base_dir: target_dir.to_string_lossy().to_string(),
        manifest,
        warning,
    })
}

/// 保存聊天壁纸到本地（AppData）
#[tauri::command]
pub async fn save_wallpaper(
    app: AppHandle,
    session_id: String,
    data_url: String,
    file_name: Option<String>,
    previous_path: Option<String>,
) -> Result<WallpaperSaveResult, String> {
    let data_dir = get_data_dir(&app)?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let safe_sid = sanitize_session_asset_segment(&session_id);
    let wallpaper_root = data_dir.join("wallpapers").join(&safe_sid);
    fs::create_dir_all(&wallpaper_root).map_err(|e| e.to_string())?;

    let (bytes, ext_from_mime) = decode_data_url(&data_url)?;
    let ext_from_name = file_name.as_deref().and_then(extension_from_name);
    let ext = ext_from_mime
        .or(ext_from_name)
        .unwrap_or_else(|| "png".to_string());
    let stem = sanitize_segment(file_name.as_deref().unwrap_or("wallpaper"));
    let ts = chrono::Utc::now().timestamp();
    let file = wallpaper_root.join(format!("wallpaper_{safe_sid}_{stem}_{ts}.{ext}"));
    fs::write(&file, &bytes).map_err(|e| e.to_string())?;

    if let Some(prev) = previous_path {
        let prev_path = PathBuf::from(prev);
        let allowed_roots = session_asset_roots(&data_dir, "wallpapers", &session_id);
        if path_is_within_roots(&prev_path, &allowed_roots) && prev_path.exists() {
            let _ = fs::remove_file(prev_path);
        }
    }

    Ok(WallpaperSaveResult {
        path: file.to_string_lossy().to_string(),
        bytes: bytes.len(),
    })
}

/// 保存聊天壁纸（分块传输，支持原图无损保存）
#[tauri::command]
pub async fn save_wallpaper_chunked(
    app: AppHandle,
    session_id: String,
    chunks: Vec<String>,
    file_name: Option<String>,
    mime_type: Option<String>,
    previous_path: Option<String>,
) -> Result<WallpaperSaveResult, String> {
    let data_dir = get_data_dir(&app)?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let safe_sid = sanitize_session_asset_segment(&session_id);
    let wallpaper_root = data_dir.join("wallpapers").join(&safe_sid);
    fs::create_dir_all(&wallpaper_root).map_err(|e| e.to_string())?;

    // 合并所有Base64块并解码
    let combined = chunks.join("");
    let bytes = BASE64_ENGINE
        .decode(&combined)
        .map_err(|e| format!("Base64解码失败: {}", e))?;

    // 确定扩展名
    let ext_from_mime = mime_type.as_deref().and_then(|m| match m {
        "image/png" => Some("png".to_string()),
        "image/jpeg" | "image/jpg" => Some("jpg".to_string()),
        "image/webp" => Some("webp".to_string()),
        "image/gif" => Some("gif".to_string()),
        _ => None,
    });
    let ext_from_name = file_name.as_deref().and_then(extension_from_name);
    let ext = ext_from_mime
        .or(ext_from_name)
        .unwrap_or_else(|| "png".to_string());

    let stem = sanitize_segment(file_name.as_deref().unwrap_or("wallpaper"));
    let ts = chrono::Utc::now().timestamp();
    let file = wallpaper_root.join(format!("wallpaper_{safe_sid}_{stem}_{ts}.{ext}"));

    fs::write(&file, &bytes).map_err(|e| e.to_string())?;

    // 删除旧壁纸
    if let Some(prev) = previous_path {
        let prev_path = PathBuf::from(prev);
        let allowed_roots = session_asset_roots(&data_dir, "wallpapers", &session_id);
        if path_is_within_roots(&prev_path, &allowed_roots) && prev_path.exists() {
            let _ = fs::remove_file(prev_path);
        }
    }

    Ok(WallpaperSaveResult {
        path: file.to_string_lossy().to_string(),
        bytes: bytes.len(),
    })
}

/// 保存聊天壁纸（流式分块，避免大 payload）
#[tauri::command]
pub async fn save_wallpaper_stream_start(
    app: AppHandle,
    session_id: String,
    file_name: Option<String>,
    mime_type: Option<String>,
    previous_path: Option<String>,
    state: State<'_, WallpaperStreamState>,
) -> Result<WallpaperStreamStartResult, String> {
    let data_dir = get_data_dir(&app)?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let safe_sid = sanitize_session_asset_segment(&session_id);
    let wallpaper_root = data_dir.join("wallpapers").join(&safe_sid);
    fs::create_dir_all(&wallpaper_root).map_err(|e| e.to_string())?;

    let ext_from_mime = mime_type.as_deref().and_then(|m| match m {
        "image/png" => Some("png".to_string()),
        "image/jpeg" | "image/jpg" => Some("jpg".to_string()),
        "image/webp" => Some("webp".to_string()),
        "image/gif" => Some("gif".to_string()),
        _ => None,
    });
    let ext_from_name = file_name.as_deref().and_then(extension_from_name);
    let ext = ext_from_mime
        .or(ext_from_name)
        .unwrap_or_else(|| "png".to_string());
    let stem = sanitize_segment(file_name.as_deref().unwrap_or("wallpaper"));
    let ts = chrono::Utc::now().timestamp_millis();
    let file = wallpaper_root.join(format!("wallpaper_{safe_sid}_{stem}_{ts}.{ext}"));

    fs::write(&file, &[]).map_err(|e| e.to_string())?;

    let upload_id = format!("{safe_sid}_{ts}");
    let allowed_roots = session_asset_roots(&data_dir, "wallpapers", &session_id);
    let previous_path = previous_path.filter(|raw| {
        let path = PathBuf::from(raw);
        path_is_within_roots(&path, &allowed_roots)
    });
    let entry = WallpaperStreamEntry {
        path: file.clone(),
        previous_path,
    };
    let mut map = state
        .inner
        .lock()
        .map_err(|_| "stream state lock poisoned".to_string())?;
    map.insert(upload_id.clone(), entry);

    Ok(WallpaperStreamStartResult {
        upload_id,
        path: file.to_string_lossy().to_string(),
    })
}

/// 追加壁纸分块
#[tauri::command]
pub async fn save_wallpaper_stream_chunk(
    upload_id: String,
    chunk: String,
    state: State<'_, WallpaperStreamState>,
) -> Result<(), String> {
    let (path, _) = {
        let map = state
            .inner
            .lock()
            .map_err(|_| "stream state lock poisoned".to_string())?;
        let entry = map
            .get(upload_id.trim())
            .ok_or("invalid upload id".to_string())?;
        (entry.path.clone(), entry.previous_path.clone())
    };

    let bytes = decode_base64_payload(&chunk)?;
    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(())
}

/// 完成保存壁纸
#[tauri::command]
pub async fn save_wallpaper_stream_finish(
    upload_id: String,
    state: State<'_, WallpaperStreamState>,
) -> Result<WallpaperSaveResult, String> {
    let entry = {
        let mut map = state
            .inner
            .lock()
            .map_err(|_| "stream state lock poisoned".to_string())?;
        map.remove(upload_id.trim())
            .ok_or("invalid upload id".to_string())?
    };

    if let Some(prev) = entry.previous_path.clone() {
        let prev_path = PathBuf::from(prev);
        if prev_path.exists() {
            let _ = fs::remove_file(prev_path);
        }
    }

    let bytes = fs::metadata(&entry.path).map_err(|e| e.to_string())?.len() as usize;

    Ok(WallpaperSaveResult {
        path: entry.path.to_string_lossy().to_string(),
        bytes,
    })
}

/// 删除聊天壁纸文件
#[tauri::command]
pub async fn delete_wallpaper(
    app: AppHandle,
    session_id: String,
    path: Option<String>,
) -> Result<bool, String> {
    let raw = path.unwrap_or_default();
    if raw.trim().is_empty() {
        return Ok(false);
    }
    let data_dir = get_data_dir(&app)?;
    let wallpaper_roots = session_asset_roots(&data_dir, "wallpapers", &session_id);
    let target = PathBuf::from(raw);
    if !path_is_within_roots(&target, &wallpaper_roots) {
        return Err("invalid wallpaper path".to_string());
    }
    if target.exists() {
        fs::remove_file(&target).map_err(|e| e.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

/// 检查保存过的聊天壁纸路径是否仍然存在。
#[tauri::command]
pub async fn wallpaper_path_exists(app: AppHandle, path: Option<String>) -> Result<bool, String> {
    let raw = path.unwrap_or_default();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    let data_dir = get_data_dir(&app)?;
    let wallpaper_root = data_dir.join("wallpapers");
    let target = PathBuf::from(trimmed);
    if !target.starts_with(&wallpaper_root) {
        return Ok(false);
    }
    Ok(target.is_file())
}

/// 保存附件图片到本地（AppData）
#[tauri::command]
pub async fn save_attachment(
    app: AppHandle,
    session_id: String,
    data_url: String,
    file_name: Option<String>,
) -> Result<AttachmentSaveResult, String> {
    let data_dir = get_data_dir(&app)?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let safe_sid = sanitize_session_asset_segment(&session_id);
    let attach_root = data_dir.join("attachments").join(&safe_sid);
    fs::create_dir_all(&attach_root).map_err(|e| e.to_string())?;

    let (bytes, ext_from_mime) = decode_data_url(&data_url)?;
    let ext_from_name = file_name.as_deref().and_then(extension_from_name);
    let ext = ext_from_mime
        .or(ext_from_name)
        .unwrap_or_else(|| "png".to_string());
    let stem = sanitize_segment(file_name.as_deref().unwrap_or("attachment"));
    let ts = chrono::Utc::now().timestamp_millis();
    let file = attach_root.join(format!("attachment_{safe_sid}_{stem}_{ts}.{ext}"));
    fs::write(&file, &bytes).map_err(|e| e.to_string())?;

    Ok(AttachmentSaveResult {
        path: file.to_string_lossy().to_string(),
        bytes: bytes.len(),
    })
}

/// 保存附件（base64 字节，用于非图片文件）
#[tauri::command]
pub async fn save_attachment_bytes(
    app: AppHandle,
    session_id: String,
    base64: String,
    file_name: Option<String>,
) -> Result<AttachmentSaveResult, String> {
    let data_dir = get_data_dir(&app)?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let safe_sid = sanitize_session_asset_segment(&session_id);
    let attach_root = data_dir.join("attachments").join(&safe_sid);
    fs::create_dir_all(&attach_root).map_err(|e| e.to_string())?;

    let bytes = decode_base64_payload(&base64)?;
    let ext_from_name = file_name.as_deref().and_then(extension_from_name);
    let ext = ext_from_name.unwrap_or_else(|| "bin".to_string());
    let stem = sanitize_segment(file_name.as_deref().unwrap_or("attachment"));
    let ts = chrono::Utc::now().timestamp_millis();
    let file = attach_root.join(format!("attachment_{safe_sid}_{stem}_{ts}.{ext}"));
    write_bytes_file(&file, &bytes)?;

    Ok(AttachmentSaveResult {
        path: file.to_string_lossy().to_string(),
        bytes: bytes.len(),
    })
}

/// 读取当前会话附件为 data URL，用于发送给支持视觉的文本模型。
#[tauri::command]
pub async fn read_attachment_data_url(
    app: AppHandle,
    session_id: String,
    path: String,
) -> Result<AttachmentDataUrlResult, String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("attachment path empty".to_string());
    }
    let data_dir = get_data_dir(&app)?;
    let attach_roots = session_asset_roots(&data_dir, "attachments", &session_id);
    let target = PathBuf::from(raw);
    if !path_is_within_roots(&target, &attach_roots) {
        return Err("invalid attachment path".to_string());
    }
    let bytes = fs::read(&target).map_err(|e| e.to_string())?;
    let ext = target
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_string();
    let mime = mime_from_extension(&ext).unwrap_or_else(|| "application/octet-stream".to_string());
    if !is_image_mime(&mime) {
        return Err("attachment is not an image".to_string());
    }
    let encoded = BASE64_ENGINE.encode(&bytes);
    Ok(AttachmentDataUrlResult {
        data_url: format!("data:{mime};base64,{encoded}"),
        bytes: bytes.len(),
        mime,
    })
}

/// 保存附件（流式分块，避免超大 payload）
#[tauri::command]
pub async fn save_attachment_stream_start(
    app: AppHandle,
    session_id: String,
    file_name: Option<String>,
    mime_type: Option<String>,
    state: State<'_, AttachmentStreamState>,
) -> Result<AttachmentStreamStartResult, String> {
    let data_dir = get_data_dir(&app)?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let safe_sid = sanitize_session_asset_segment(&session_id);
    let attach_root = data_dir.join("attachments").join(&safe_sid);
    fs::create_dir_all(&attach_root).map_err(|e| e.to_string())?;

    let ext_from_mime = mime_type.as_deref().and_then(|m| match m {
        "image/png" => Some("png".to_string()),
        "image/jpeg" | "image/jpg" => Some("jpg".to_string()),
        "image/webp" => Some("webp".to_string()),
        "image/gif" => Some("gif".to_string()),
        _ => None,
    });
    let ext_from_name = file_name.as_deref().and_then(extension_from_name);
    let ext = ext_from_mime
        .or(ext_from_name)
        .unwrap_or_else(|| "png".to_string());
    let stem = sanitize_segment(file_name.as_deref().unwrap_or("attachment"));
    let ts = chrono::Utc::now().timestamp_millis();
    let file = attach_root.join(format!("attachment_{safe_sid}_{stem}_{ts}.{ext}"));

    fs::write(&file, &[]).map_err(|e| e.to_string())?;

    let upload_id = format!("{safe_sid}_{ts}");
    let entry = AttachmentStreamEntry { path: file.clone() };
    let mut map = state
        .inner
        .lock()
        .map_err(|_| "stream state lock poisoned".to_string())?;
    map.insert(upload_id.clone(), entry);

    Ok(AttachmentStreamStartResult {
        upload_id,
        path: file.to_string_lossy().to_string(),
    })
}

/// 追加附件分块
#[tauri::command]
pub async fn save_attachment_stream_chunk(
    upload_id: String,
    chunk: String,
    state: State<'_, AttachmentStreamState>,
) -> Result<(), String> {
    let path = {
        let map = state
            .inner
            .lock()
            .map_err(|_| "stream state lock poisoned".to_string())?;
        let entry = map
            .get(upload_id.trim())
            .ok_or("invalid upload id".to_string())?;
        entry.path.clone()
    };

    let bytes = decode_base64_payload(&chunk)?;
    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(())
}

/// 完成附件分块保存
#[tauri::command]
pub async fn save_attachment_stream_finish(
    upload_id: String,
    state: State<'_, AttachmentStreamState>,
) -> Result<AttachmentSaveResult, String> {
    let entry = {
        let mut map = state
            .inner
            .lock()
            .map_err(|_| "stream state lock poisoned".to_string())?;
        map.remove(upload_id.trim())
            .ok_or("invalid upload id".to_string())?
    };

    let bytes = fs::metadata(&entry.path).map_err(|e| e.to_string())?.len() as usize;

    Ok(AttachmentSaveResult {
        path: entry.path.to_string_lossy().to_string(),
        bytes,
    })
}

/// 删除附件文件
#[tauri::command]
pub async fn delete_attachment(
    app: AppHandle,
    session_id: String,
    path: String,
) -> Result<bool, String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Ok(false);
    }
    let data_dir = get_data_dir(&app)?;
    let attach_roots = session_asset_roots(&data_dir, "attachments", &session_id);
    let target = PathBuf::from(raw);
    if !path_is_within_roots(&target, &attach_roots) {
        return Err("invalid attachment path".to_string());
    }
    if target.exists() {
        fs::remove_file(&target).map_err(|e| e.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

/// 导出附件到下载目录或指定路径
#[tauri::command]
pub async fn export_attachment(
    app: AppHandle,
    source_path: Option<String>,
    data_url: Option<String>,
    file_name: Option<String>,
    path: Option<String>,
) -> Result<AttachmentSaveResult, String> {
    let raw_name = file_name.as_deref().unwrap_or("download");
    let name_with_ext = ensure_extension(raw_name, None);
    let mut safe_name = sanitize_download_name(&name_with_ext);
    let target_path = path.unwrap_or_default();
    let source = source_path.unwrap_or_default();
    let data = data_url.unwrap_or_default();

    if !source.trim().is_empty() {
        let src_path = PathBuf::from(source.trim());
        if !src_path.exists() {
            return Err("source file missing".to_string());
        }
        let ext = extension_from_name(raw_name).or_else(|| {
            src_path
                .extension()
                .map(|v| v.to_string_lossy().to_string())
        });
        let mime = ext.as_ref().and_then(|v| mime_from_extension(v));
        if let Some(mime) = &mime {
            if is_image_mime(mime) && target_path.trim().is_empty() && mime != "image/gif" {
                safe_name = sanitize_download_name(&ensure_extension(raw_name, ext.as_deref()));
                #[cfg(target_os = "android")]
                {
                    let bytes = fs::read(&src_path).map_err(|e| e.to_string())?;
                    let published = publish_image_to_gallery_bytes(&bytes, &safe_name, mime)?;
                    return Ok(AttachmentSaveResult {
                        path: published,
                        bytes: bytes.len(),
                    });
                }
            }
        }
        let bytes = fs::metadata(&src_path).map_err(|e| e.to_string())?.len() as usize;
        if !target_path.trim().is_empty() {
            let dst = PathBuf::from(target_path.trim());
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            if src_path != dst {
                fs::copy(&src_path, &dst).map_err(|e| e.to_string())?;
            }
            return Ok(AttachmentSaveResult {
                path: dst.to_string_lossy().to_string(),
                bytes,
            });
        }
        let published = publish_bundle_to_downloads(&app, &src_path, &safe_name)?;
        return Ok(AttachmentSaveResult {
            path: published,
            bytes,
        });
    }

    if data.trim().is_empty() {
        return Err("missing export data".to_string());
    }
    let (bytes, ext_from_mime) = decode_data_url(&data)?;
    let data_mime = mime_from_data_url(&data)
        .or_else(|| ext_from_mime.as_ref().and_then(|v| mime_from_extension(v)));
    if let Some(mime) = data_mime {
        if is_image_mime(&mime) && target_path.trim().is_empty() && mime != "image/gif" {
            safe_name =
                sanitize_download_name(&ensure_extension(raw_name, ext_from_mime.as_deref()));
            #[cfg(target_os = "android")]
            {
                let published = publish_image_to_gallery_bytes(&bytes, &safe_name, &mime)?;
                return Ok(AttachmentSaveResult {
                    path: published,
                    bytes: bytes.len(),
                });
            }
        }
    }
    if !target_path.trim().is_empty() {
        let dst = PathBuf::from(target_path.trim());
        write_bytes_file(&dst, &bytes)?;
        return Ok(AttachmentSaveResult {
            path: dst.to_string_lossy().to_string(),
            bytes: bytes.len(),
        });
    }
    let data_dir = get_data_dir(&app)?;
    let temp_dir = data_dir.join("exports_tmp");
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let temp_name = if ext_from_mime.is_some() {
        sanitize_download_name(&ensure_extension(raw_name, ext_from_mime.as_deref()))
    } else {
        safe_name
    };
    let temp_path = temp_dir.join(&temp_name);
    write_bytes_file(&temp_path, &bytes)?;
    let published = publish_bundle_to_downloads(&app, &temp_path, &temp_name)?;
    Ok(AttachmentSaveResult {
        path: published,
        bytes: bytes.len(),
    })
}

#[tauri::command]
pub async fn pick_save_path(
    app: AppHandle,
    #[allow(unused_variables)] window: Window,
    default_name: Option<String>,
    filters: Option<Vec<SaveDialogFilter>>,
) -> Result<Option<String>, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        let _ = window;
        let _ = default_name;
        let _ = filters;
        return Ok(None);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri_plugin_dialog::DialogExt;

        let safe_name = sanitize_download_name(default_name.as_deref().unwrap_or("download"));
        let mut dialog = app.dialog().file().set_file_name(safe_name);
        #[cfg(any(windows, target_os = "macos"))]
        {
            dialog = dialog.set_parent(&window);
        }
        for filter in filters.unwrap_or_default() {
            let extensions: Vec<&str> = filter
                .extensions
                .iter()
                .map(|ext| ext.trim())
                .filter(|ext| !ext.is_empty())
                .collect();
            if extensions.is_empty() {
                continue;
            }
            let name = filter.name.trim();
            dialog = dialog.add_filter(if name.is_empty() { "Files" } else { name }, &extensions);
        }
        let path = dialog
            .blocking_save_file()
            .and_then(|file_path| file_path.into_path().ok())
            .map(|path| path.to_string_lossy().to_string());
        Ok(path)
    }
}

/// 导出贴图帧序列为 GIF
#[tauri::command]
pub async fn export_sticker_gif(
    app: AppHandle,
    frames: Vec<String>,
    fps: Option<u16>,
    file_name: Option<String>,
    path: Option<String>,
) -> Result<AttachmentSaveResult, String> {
    if frames.is_empty() {
        return Err("no sticker frames".to_string());
    }
    let fps = fps.unwrap_or(12).clamp(1, 60);
    let delay = ((100.0 / fps as f32).round() as u16).max(1);
    let mut images: Vec<RgbaImage> = Vec::new();
    let mut max_w = 0u32;
    let mut max_h = 0u32;
    for frame in frames.iter() {
        let raw = frame.trim();
        if raw.is_empty() {
            continue;
        }
        let img = if raw.starts_with("data:") {
            let (bytes, _ext) = decode_data_url(raw)?;
            image::load_from_memory(&bytes).map_err(|e| e.to_string())?
        } else {
            let mut normalized = raw.to_string();
            if let Some(stripped) = normalized.strip_prefix("file:///") {
                normalized = stripped.to_string();
            } else if let Some(stripped) = normalized.strip_prefix("file://") {
                normalized = stripped.to_string();
            }
            let candidate = PathBuf::from(normalized);
            if !candidate.exists() {
                return Err(format!("frame missing: {}", raw));
            }
            image::open(&candidate).map_err(|e| e.to_string())?
        };
        let rgba = img.to_rgba8();
        max_w = max_w.max(rgba.width());
        max_h = max_h.max(rgba.height());
        images.push(rgba);
    }
    if images.is_empty() || max_w == 0 || max_h == 0 {
        return Err("invalid sticker frames".to_string());
    }

    let raw_name = file_name.unwrap_or_else(|| "sticker.gif".to_string());
    let safe_name = sanitize_download_name(&ensure_extension(&raw_name, Some("gif")));
    let target_path = path.unwrap_or_default();
    let mut publish_download = false;
    let output_path = if target_path.trim().is_empty() {
        let data_dir = get_data_dir(&app)?;
        let temp_dir = data_dir.join("exports_tmp");
        fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
        publish_download = true;
        temp_dir.join(&safe_name)
    } else {
        PathBuf::from(target_path.trim())
    };
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut file = fs::File::create(&output_path).map_err(|e| e.to_string())?;
    {
        let mut encoder = GifEncoder::new(&mut file, max_w as u16, max_h as u16, &[])
            .map_err(|e| e.to_string())?;
        encoder
            .set_repeat(GifRepeat::Infinite)
            .map_err(|e| e.to_string())?;
        for rgba in images {
            let canvas = if rgba.width() == max_w && rgba.height() == max_h {
                rgba
            } else {
                let mut base = RgbaImage::from_pixel(max_w, max_h, image::Rgba([0, 0, 0, 0]));
                let x = ((max_w - rgba.width()) / 2) as i64;
                let y = ((max_h - rgba.height()) / 2) as i64;
                overlay(&mut base, &rgba, x, y);
                base
            };
            let mut raw = canvas.into_raw();
            let mut frame = GifFrame::from_rgba_speed(max_w as u16, max_h as u16, &mut raw, 10);
            frame.delay = delay;
            encoder.write_frame(&frame).map_err(|e| e.to_string())?;
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    let bytes = fs::metadata(&output_path).map_err(|e| e.to_string())?.len() as usize;
    if publish_download {
        let published = publish_bundle_to_downloads(&app, &output_path, &safe_name)?;
        return Ok(AttachmentSaveResult {
            path: published,
            bytes,
        });
    }
    Ok(AttachmentSaveResult {
        path: output_path.to_string_lossy().to_string(),
        bytes,
    })
}

/// 导出切割结果为 ZIP
#[tauri::command]
pub async fn export_sticker_zip(
    app: AppHandle,
    entries: Vec<StickerZipEntry>,
    file_name: Option<String>,
    path: Option<String>,
) -> Result<AttachmentSaveResult, String> {
    if entries.is_empty() {
        return Err("no zip entries".to_string());
    }
    let safe_name = sanitize_segment(file_name.as_deref().unwrap_or("sticker_slices.zip"));
    let target_path = path.unwrap_or_default();
    let data_dir = get_data_dir(&app)?;
    let mut publish_download = false;
    let output_path = if target_path.trim().is_empty() {
        let temp_dir = data_dir.join("exports_tmp");
        fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
        publish_download = true;
        temp_dir.join(&safe_name)
    } else {
        PathBuf::from(target_path.trim())
    };

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = fs::File::create(&output_path).map_err(|e| e.to_string())?;
    let mut writer = ZipWriter::new(file);
    let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
    for (idx, entry) in entries.iter().enumerate() {
        let name_raw = if entry.name.trim().is_empty() {
            format!("slice_{}.png", idx + 1)
        } else {
            entry.name.trim().to_string()
        };
        let entry_name = sanitize_zip_entry_name(&name_raw);
        let payload = if let Some(path) = &entry.path {
            let src = PathBuf::from(path.trim());
            if !src.exists() {
                continue;
            }
            fs::read(&src).map_err(|e| e.to_string())?
        } else if let Some(data_url) = &entry.data_url {
            let (bytes, _ext) = decode_data_url(data_url)?;
            bytes
        } else {
            continue;
        };
        writer
            .start_file(entry_name, options)
            .map_err(|e| e.to_string())?;
        writer.write_all(&payload).map_err(|e| e.to_string())?;
    }
    writer.finish().map_err(|e| e.to_string())?;
    let bytes = fs::metadata(&output_path).map_err(|e| e.to_string())?.len() as usize;

    if publish_download {
        let published = publish_bundle_to_downloads(&app, &output_path, &safe_name)?;
        return Ok(AttachmentSaveResult {
            path: published,
            bytes,
        });
    }
    Ok(AttachmentSaveResult {
        path: output_path.to_string_lossy().to_string(),
        bytes,
    })
}

/// 清理未引用的壁纸文件
#[tauri::command]
pub async fn cleanup_wallpapers(
    app: AppHandle,
    referenced_paths: Vec<String>,
) -> Result<WallpaperCleanupResult, String> {
    let data_dir = get_data_dir(&app)?;
    let wallpaper_root = data_dir.join("wallpapers");
    if !wallpaper_root.exists() {
        return Ok(WallpaperCleanupResult {
            removed: 0,
            kept: 0,
        });
    }

    let mut referenced = std::collections::HashSet::new();
    for raw in referenced_paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        referenced.insert(trimmed.to_string());
        if let Ok(canon) = PathBuf::from(trimmed).canonicalize() {
            referenced.insert(canon.to_string_lossy().to_string());
        }
    }

    let mut removed = 0usize;
    let mut kept = 0usize;
    let mut stack = vec![wallpaper_root.clone()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let raw_path = path.to_string_lossy().to_string();
            let mut in_use = referenced.contains(&raw_path);
            if !in_use {
                if let Ok(canon) = path.canonicalize() {
                    let canon_str = canon.to_string_lossy().to_string();
                    if referenced.contains(&canon_str) {
                        in_use = true;
                    }
                }
            }
            if in_use {
                kept += 1;
            } else {
                fs::remove_file(&path).map_err(|e| e.to_string())?;
                removed += 1;
            }
        }
    }

    Ok(WallpaperCleanupResult { removed, kept })
}

/// 导出本地资料包（聊天记录/联系人/壁纸/记忆表格等）
#[tauri::command]
pub async fn export_data_bundle(
    app: AppHandle,
    state: State<'_, MemoryDb>,
    path: Option<String>,
) -> Result<DataBundleResult, String> {
    state.close_all();
    let data_dir = get_data_dir(&app)?;
    let ts = chrono::Utc::now().format("%Y%m%d_%H%M%S");
    let file_name = format!("omnitavern_backup_{ts}.zip");
    let mut output_path: PathBuf;
    #[cfg(target_os = "android")]
    let mut publish_download = false;
    let raw_path = path.unwrap_or_default();
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        #[cfg(target_os = "android")]
        {
            let temp_dir = data_dir.join("exports_tmp");
            output_path = temp_dir.join(&file_name);
            publish_download = true;
        }
        #[cfg(not(target_os = "android"))]
        {
            output_path = resolve_export_dir(&app)?.join(&file_name);
        }
    } else {
        output_path = PathBuf::from(trimmed);
        if output_path.extension().is_none() {
            output_path.set_extension("zip");
        }
        if output_path.is_dir() {
            output_path = output_path.join(&file_name);
        }
    }
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = fs::File::create(&output_path).map_err(|e| e.to_string())?;
    let mut writer = ZipWriter::new(file);
    let options = FileOptions::default().compression_method(CompressionMethod::Deflated);

    let manifest = serde_json::json!({
        "format": "tauri-chat-app-backup-v1",
        "createdAt": chrono::Utc::now().to_rfc3339(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "excluded": [
            "config.json",
            "llm_keyring_v1.json",
            "llm_keyring_master_v1.json"
        ],
        "redactedIncluded": [
            "llm_profiles*_v1.json",
            "app_settings_v1.json"
        ]
    });
    writer
        .start_file("bundle.json", options)
        .map_err(|e| e.to_string())?;
    writer
        .write_all(manifest.to_string().as_bytes())
        .map_err(|e| e.to_string())?;

    let mut files = add_dir_to_zip(
        &mut writer,
        &data_dir,
        &data_dir,
        options,
        Some(&output_path),
    )?;
    files += add_sanitized_profile_stores_to_zip(&mut writer, &data_dir, options)?;
    writer.finish().map_err(|e| e.to_string())?;
    let bytes = fs::metadata(&output_path).map_err(|e| e.to_string())?.len();
    #[cfg(target_os = "android")]
    let result_path = {
        if publish_download {
            let published = publish_bundle_to_downloads(&app, &output_path, &file_name)?;
            let _ = fs::remove_file(&output_path);
            published
        } else {
            output_path.to_string_lossy().to_string()
        }
    };
    #[cfg(not(target_os = "android"))]
    let result_path = output_path.to_string_lossy().to_string();

    Ok(DataBundleResult {
        path: result_path,
        bytes,
        files,
    })
}

/// 导入本地资料包
#[tauri::command]
pub async fn import_data_bundle(
    app: AppHandle,
    path: String,
    mode: Option<String>,
    state: State<'_, MemoryDb>,
) -> Result<DataBundleImportResult, String> {
    let mode = mode.unwrap_or_else(|| "replace".to_string()).to_lowercase();
    let data_dir = get_data_dir(&app)?;
    let path_buf = PathBuf::from(path);
    if mode != "merge" && path_buf.starts_with(&data_dir) {
        let bytes = fs::read(&path_buf).map_err(|e| e.to_string())?;
        let cursor = std::io::Cursor::new(bytes);
        return import_bundle_from_reader(&data_dir, &state, cursor, &mode);
    }
    let file = fs::File::open(&path_buf).map_err(|e| e.to_string())?;
    import_bundle_from_reader(&data_dir, &state, file, &mode)
}

/// 导入本地资料包（base64/dataURL）
#[tauri::command]
pub async fn import_data_bundle_bytes(
    app: AppHandle,
    data: String,
    mode: Option<String>,
    state: State<'_, MemoryDb>,
) -> Result<DataBundleImportResult, String> {
    let mode = mode.unwrap_or_else(|| "replace".to_string()).to_lowercase();
    let data_dir = get_data_dir(&app)?;
    let bytes = decode_base64_payload(&data)?;
    let cursor = std::io::Cursor::new(bytes);
    import_bundle_from_reader(&data_dir, &state, cursor, &mode)
}

/// 保存配置
#[tauri::command]
pub async fn save_config(app: AppHandle, config: Value) -> Result<(), String> {
    let data_dir = get_data_dir(&app)?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let config_path = data_dir.join("config.json");

    // 加密敏感字段
    let mut config_to_save = config.clone();
    if let Some(api_key) = config_to_save.get("apiKey").and_then(|v| v.as_str()) {
        let encrypted = simple_encrypt(api_key);
        if let Some(obj) = config_to_save.as_object_mut() {
            obj.insert("apiKey".to_string(), Value::String(encrypted));
            obj.insert("_encrypted".to_string(), Value::Bool(true));
        }
    }

    let json = serde_json::to_string_pretty(&config_to_save).map_err(|e| e.to_string())?;
    fs::write(config_path, json).map_err(|e| e.to_string())?;

    Ok(())
}

/// 加载配置
#[tauri::command]
pub async fn load_config(app: AppHandle) -> Result<Value, String> {
    let data_dir = get_data_dir(&app)?;
    let config_path = data_dir.join("config.json");

    if !config_path.exists() {
        // 返回默认配置
        return Ok(serde_json::json!({
            "provider": "openai",
            "baseUrl": "https://api.openai.com/v1",
            "model": "gpt-3.5-turbo",
            "stream": true,
            "apiKey": ""
        }));
    }

    let json = fs::read_to_string(config_path).map_err(|e| e.to_string())?;
    let mut config: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;

    // 解密 API Key
    if let Some(obj) = config.as_object_mut() {
        if obj
            .get("_encrypted")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            if let Some(api_key) = obj.get("apiKey").and_then(|v| v.as_str()) {
                match simple_decrypt(api_key) {
                    Ok(decrypted) => {
                        obj.insert("apiKey".to_string(), Value::String(decrypted));
                    }
                    Err(_) => {}
                }
            }
            obj.remove("_encrypted");
        }
    }

    Ok(config)
}

/// 保存聊天历史
#[tauri::command]
pub async fn save_chat_history(
    app: AppHandle,
    character_id: String,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    let data_dir = get_data_dir(&app)?;
    let chat_dir = data_dir.join("chats");
    fs::create_dir_all(&chat_dir).map_err(|e| e.to_string())?;

    let chat_file = chat_dir.join(format!("{}.json", character_id));

    // 读取现有记录
    let mut all_messages: Vec<ChatMessage> = if chat_file.exists() {
        let json = fs::read_to_string(&chat_file).map_err(|e| e.to_string())?;
        serde_json::from_str(&json).unwrap_or_default()
    } else {
        Vec::new()
    };

    // 添加新消息
    all_messages.extend(messages);

    // 保存
    let json = serde_json::to_string_pretty(&all_messages).map_err(|e| e.to_string())?;
    fs::write(chat_file, json).map_err(|e| e.to_string())?;

    Ok(())
}

/// 获取聊天历史
#[tauri::command]
pub async fn get_chat_history(
    app: AppHandle,
    character_id: String,
    limit: Option<i64>,
) -> Result<Vec<ChatMessage>, String> {
    let data_dir = get_data_dir(&app)?;
    let chat_file = data_dir
        .join("chats")
        .join(format!("{}.json", character_id));

    if !chat_file.exists() {
        return Ok(Vec::new());
    }

    let json = fs::read_to_string(chat_file).map_err(|e| e.to_string())?;
    let mut messages: Vec<ChatMessage> = serde_json::from_str(&json).unwrap_or_default();

    // 限制数量
    if let Some(limit) = limit {
        let start = messages.len().saturating_sub(limit as usize);
        messages = messages[start..].to_vec();
    }

    Ok(messages)
}

/// 清除聊天历史
#[tauri::command]
pub async fn clear_chat_history(app: AppHandle, character_id: String) -> Result<(), String> {
    let data_dir = get_data_dir(&app)?;
    let chat_file = data_dir
        .join("chats")
        .join(format!("{}.json", character_id));

    if chat_file.exists() {
        fs::remove_file(chat_file).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// 保存世界书数据
fn world_info_file_path(data_dir: &Path, character_id: &str) -> Result<PathBuf, String> {
    let id = character_id.trim();
    if id.is_empty() {
        return Err("world info id empty".to_string());
    }
    if id == "." || id == ".." || id.contains('/') || id.contains('\\') || id.contains('\0') {
        return Err("world info id contains invalid path characters".to_string());
    }
    Ok(data_dir.join("worldinfo").join(format!("{id}.json")))
}

fn delete_world_info_file(data_dir: &Path, character_id: &str) -> Result<bool, String> {
    let world_file = world_info_file_path(data_dir, character_id)?;
    if !world_file.exists() {
        return Ok(false);
    }
    fs::remove_file(world_file).map_err(|e| e.to_string())?;
    Ok(true)
}

fn list_world_info_file_ids(data_dir: &Path) -> Result<Vec<String>, String> {
    let world_dir = data_dir.join("worldinfo");
    if !world_dir.exists() {
        return Ok(Vec::new());
    }
    let mut ids = Vec::new();
    for entry in fs::read_dir(world_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Some(id) = path.file_stem().and_then(|value| value.to_str()) {
            let id = id.trim();
            if !id.is_empty() {
                ids.push(id.to_string());
            }
        }
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

#[tauri::command]
pub async fn save_world_info(
    app: AppHandle,
    character_id: String,
    data: Value,
) -> Result<(), String> {
    let data_dir = get_data_dir(&app)?;
    let world_file = world_info_file_path(&data_dir, &character_id)?;
    fs::create_dir_all(world_file.parent().ok_or("world info dir unavailable")?)
        .map_err(|e| e.to_string())?;

    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    write_file_atomically(&world_file, json.as_bytes())?;

    Ok(())
}

/// 获取世界书数据
#[tauri::command]
pub async fn get_world_info(app: AppHandle, character_id: String) -> Result<Value, String> {
    let data_dir = get_data_dir(&app)?;
    // 非法 id（路径穿越等）按“缺失”返回 `{}`，保持 legacy 语义不向调用方抛新错误。
    let world_file = match world_info_file_path(&data_dir, &character_id) {
        Ok(path) => path,
        Err(_) => return Ok(serde_json::json!({})),
    };

    if !world_file.exists() {
        return Ok(serde_json::json!({}));
    }

    let json = fs::read_to_string(world_file).map_err(|e| e.to_string())?;
    let data: Value = serde_json::from_str(&json).unwrap_or(serde_json::json!({}));

    Ok(data)
}

/// 删除世界书原生文件；不存在视为幂等成功并返回 false。
#[tauri::command]
pub async fn delete_world_info(app: AppHandle, character_id: String) -> Result<bool, String> {
    let data_dir = get_data_dir(&app)?;
    delete_world_info_file(&data_dir, &character_id)
}

/// 独立存在性探测；保留 get_world_info 缺失时返回空对象的既有语义。
#[tauri::command]
pub async fn world_info_exists(app: AppHandle, character_id: String) -> Result<bool, String> {
    let data_dir = get_data_dir(&app)?;
    Ok(world_info_file_path(&data_dir, &character_id)?.exists())
}

/// 只读列出原生 worldinfo 目录中的 JSON 文件 ID，供索引外文件审计。
#[tauri::command]
pub async fn list_world_info_files(app: AppHandle) -> Result<Vec<String>, String> {
    let data_dir = get_data_dir(&app)?;
    list_world_info_file_ids(&data_dir)
}

/// 保存角色信息
#[tauri::command]
pub async fn save_character(
    app: AppHandle,
    id: String,
    name: String,
    description: Option<String>,
    avatar_url: Option<String>,
    system_prompt: Option<String>,
) -> Result<(), String> {
    let data_dir = get_data_dir(&app)?;
    let char_dir = data_dir.join("characters");
    fs::create_dir_all(&char_dir).map_err(|e| e.to_string())?;

    let char_file = char_dir.join(format!("{}.json", id));
    let character = serde_json::json!({
        "id": id,
        "name": name,
        "description": description,
        "avatarUrl": avatar_url,
        "systemPrompt": system_prompt
    });

    let json = serde_json::to_string_pretty(&character).map_err(|e| e.to_string())?;
    fs::write(char_file, json).map_err(|e| e.to_string())?;

    Ok(())
}

/// 获取所有角色
#[tauri::command]
pub async fn get_characters(app: AppHandle) -> Result<Vec<Value>, String> {
    let data_dir = get_data_dir(&app)?;
    let char_dir = data_dir.join("characters");

    if !char_dir.exists() {
        return Ok(Vec::new());
    }

    let mut characters = Vec::new();

    for entry in fs::read_dir(char_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            let json = fs::read_to_string(path).map_err(|e| e.to_string())?;
            if let Ok(character) = serde_json::from_str::<Value>(&json) {
                characters.push(character);
            }
        }
    }

    Ok(characters)
}

/// 保存 Persona 原始角色卡（单独文件，避免 KV 体积上限）
#[tauri::command]
pub async fn save_persona_card(app: AppHandle, id: String, data: Value) -> Result<Value, String> {
    let data_dir = get_data_dir(&app)?;
    let card_dir = data_dir.join("persona_cards");
    fs::create_dir_all(&card_dir).map_err(|e| e.to_string())?;
    let safe_id = sanitize_segment(&id);
    let file = card_dir.join(format!("{}.json", safe_id));
    let json = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    fs::write(&file, &json).map_err(|e| e.to_string())?;

    #[cfg(target_os = "android")]
    {
        if let Ok(f) = fs::File::open(&file) {
            unsafe {
                libc::fsync(f.as_raw_fd());
            }
        }
    }

    Ok(serde_json::json!({
        "path": file.to_string_lossy().to_string(),
        "bytes": json.len(),
        "id": safe_id
    }))
}

/// 读取 Persona 原始角色卡
#[tauri::command]
pub async fn load_persona_card(app: AppHandle, id: String) -> Result<Value, String> {
    let data_dir = get_data_dir(&app)?;
    let card_dir = data_dir.join("persona_cards");
    let safe_id = sanitize_segment(&id);
    let file = card_dir.join(format!("{}.json", safe_id));
    if !file.exists() {
        return Ok(serde_json::json!({}));
    }
    let max_len: u64 = 30 * 1024 * 1024; // 30 MiB safety cap
    if let Ok(meta) = fs::metadata(&file) {
        let len = meta.len();
        if len > max_len {
            eprintln!(
                "[load_persona_card] 文件过大，跳过加载: {:?}, {} bytes",
                file, len
            );
            return Ok(serde_json::json!({ "_tooLarge": true, "size": len }));
        }
    }
    let json = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let data: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok(data)
}

/// 删除 Persona 原始角色卡
#[tauri::command]
pub async fn delete_persona_card(app: AppHandle, id: String) -> Result<bool, String> {
    let data_dir = get_data_dir(&app)?;
    let card_dir = data_dir.join("persona_cards");
    let safe_id = sanitize_segment(&id);
    let file = card_dir.join(format!("{}.json", safe_id));
    if file.exists() {
        fs::remove_file(&file).map_err(|e| e.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

static KV_WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn write_file_atomically(file: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = file
        .parent()
        .ok_or_else(|| format!("KV 路径缺少父目录: {file:?}"))?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let file_name = file
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("KV 文件名无效: {file:?}"))?;

    for _ in 0..8 {
        let counter = KV_WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp = parent.join(format!(
            ".{file_name}.kv-write-{}-{counter}.tmp",
            std::process::id()
        ));
        let mut handle = match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(handle) => handle,
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err.to_string()),
        };

        let result = (|| -> std::io::Result<()> {
            handle.write_all(contents)?;
            handle.sync_all()?;
            drop(handle);
            fs::rename(&temp, file)?;
            if let Ok(directory) = fs::File::open(parent) {
                let _ = directory.sync_all();
            }
            Ok(())
        })();
        if let Err(err) = result {
            let _ = fs::remove_file(&temp);
            return Err(err.to_string());
        }
        return Ok(());
    }

    Err(format!("无法为 KV 写入创建临时文件: {file:?}"))
}

/// 通用 KV 持久化（前端清缓存后仍可讀）
#[tauri::command]
pub async fn save_kv(app: AppHandle, name: String, data: Value) -> Result<(), String> {
    let data_dir = get_data_dir(&app)?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let file = data_dir.join(format!("{name}.json"));
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;

    // 先在同目录完整写入并同步临时文件，再原子替换权威副本。
    write_file_atomically(&file, json.as_bytes())?;

    if is_kv_debug_enabled() {
        eprintln!("[save_kv] 文件: {:?}, 大小: {} bytes", file, json.len());
        if name == "llm_profiles_v1" {
            if let Some(obj) = data.as_object() {
                if let Some(active_id) = obj.get("activeProfileId") {
                    eprintln!("[save_kv] activeProfileId: {}", active_id);
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn load_kv(app: AppHandle, name: String) -> Result<Value, String> {
    let data_dir = get_data_dir(&app)?;
    let file = data_dir.join(format!("{name}.json"));

    if !file.exists() {
        if is_kv_debug_enabled() {
            eprintln!("[load_kv] 文件不存在: {:?}", file);
        }
        return Ok(serde_json::json!({}));
    }

    let max_len: u64 = 30 * 1024 * 1024; // 30 MiB safety cap
    if let Ok(meta) = fs::metadata(&file) {
        let len = meta.len();
        if len > max_len {
            eprintln!("[load_kv] 文件过大，跳过加载: {:?}, {} bytes", file, len);
            return Ok(serde_json::json!({ "_tooLarge": true, "size": len }));
        }
    }

    let json = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let data: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;

    if is_kv_debug_enabled() {
        eprintln!("[load_kv] 文件: {:?}, 大小: {} bytes", file, json.len());
        if name == "llm_profiles_v1" {
            if let Some(obj) = data.as_object() {
                if let Some(active_id) = obj.get("activeProfileId") {
                    eprintln!("[load_kv] activeProfileId: {}", active_id);
                }
                if let Some(profiles) = obj.get("profiles") {
                    if let Some(profiles_obj) = profiles.as_object() {
                        eprintln!("[load_kv] profiles数量: {}", profiles_obj.len());
                    }
                }
            }
        }
    }

    Ok(data)
}

/// 删除已完成 sidecar 迁移后的旧世界书聚合 KV。
/// 固定文件名，避免把通用 KV 删除能力暴露给 WebView 调用方。
#[tauri::command]
pub async fn delete_worldinfo_legacy_store(app: AppHandle) -> Result<bool, String> {
    let data_dir = get_data_dir(&app)?;
    let file = data_dir.join("worldinfo_store.json");
    if !file.exists() {
        return Ok(false);
    }
    fs::remove_file(&file).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn list_contacts_by_scopes(
    app: AppHandle,
    scopes: Vec<String>,
    limit_per_scope: Option<usize>,
) -> Result<Value, String> {
    let data_dir = get_data_dir(&app)?;
    let limit = limit_per_scope.unwrap_or(usize::MAX);
    let mut results: Vec<Value> = Vec::new();

    for raw_scope in scopes {
        let scope = normalize_scope_id(&raw_scope);
        if scope.is_empty() {
            continue;
        }
        let mut file = data_dir.join(format!("contacts_store_v1__{scope}.json"));
        if !file.exists() && scope == "default" {
            let legacy = data_dir.join("contacts_store_v1.json");
            if legacy.exists() {
                file = legacy;
            }
        }
        if !file.exists() {
            continue;
        }

        let json = match fs::read_to_string(&file) {
            Ok(val) => val,
            Err(_) => continue,
        };
        let max_len: usize = 30 * 1024 * 1024; // 30 MiB safety cap
        if json.len() > max_len {
            results.push(serde_json::json!({
                "scopeId": scope,
                "contacts": [],
                "_tooLarge": true,
                "size": json.len(),
            }));
            continue;
        }
        let data: Value = serde_json::from_str(&json).unwrap_or(serde_json::json!({}));
        let obj = match data.as_object() {
            Some(val) => val,
            None => continue,
        };
        let stored_scope = obj
            .get("scopeId")
            .and_then(|v| v.as_str())
            .map(normalize_scope_id)
            .unwrap_or_default();
        if stored_scope.is_empty() {
            if scope != "default" {
                continue;
            }
        } else if stored_scope != scope {
            continue;
        }
        let scope_id = if stored_scope.is_empty() {
            scope.as_str()
        } else {
            stored_scope.as_str()
        };

        let mut contacts_out: Vec<Value> = Vec::new();
        if let Some(contacts) = obj.get("contacts").and_then(|v| v.as_object()) {
            for (key, value) in contacts.iter() {
                if contacts_out.len() >= limit {
                    break;
                }
                let map = match value.as_object() {
                    Some(v) => v,
                    None => continue,
                };
                let id = map
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or(key)
                    .trim()
                    .to_string();
                if id.is_empty() {
                    continue;
                }
                let name = map
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(id.as_str())
                    .to_string();
                let mut avatar = map
                    .get("avatar")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if avatar.len() > 200_000 {
                    avatar.clear();
                }
                let is_group = map
                    .get("isGroup")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(id.starts_with("group:"));
                let members = map
                    .get("members")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect::<Vec<String>>()
                    })
                    .unwrap_or_else(Vec::new);
                let added_at = map.get("addedAt").and_then(|v| v.as_i64()).unwrap_or(0);
                let description = map
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                contacts_out.push(serde_json::json!({
                    "id": id,
                    "name": name,
                    "avatar": avatar,
                    "isGroup": is_group,
                    "members": members,
                    "addedAt": added_at,
                    "description": description,
                }));
            }
        }

        results.push(serde_json::json!({
            "scopeId": scope_id,
            "contacts": contacts_out,
        }));
    }

    Ok(serde_json::json!(results))
}

const PERSONA_SCOPED_JSON_BASES: &[&str] = &[
    "contacts_store_v1",
    "contact_groups_v1",
    "chat_store_v1",
    "moments_store_v1",
    "moment_summary_store_v1",
    "rp_session_v1",
    "world_session_map_v1",
    "global_world_id_v1",
    "world_global_settings_v1",
];

fn extract_scoped_json_scope(file_name: &str, base: &str) -> Option<String> {
    let prefix = format!("{base}__");
    if !file_name.starts_with(&prefix) || !file_name.ends_with(".json") {
        return None;
    }
    let raw_scope = &file_name[prefix.len()..file_name.len().saturating_sub(5)];
    let scope = normalize_scope_id(raw_scope);
    if scope.is_empty() {
        return None;
    }
    Some(scope)
}

fn read_json_file(path: &Path) -> Option<Value> {
    let json = fs::read_to_string(path).ok()?;
    serde_json::from_str(&json).ok()
}

fn collect_scope_session_ids_from_dirs(
    data_dir: &Path,
    chat_v2_base: &Path,
    scope: &str,
) -> HashSet<String> {
    let mut session_ids: HashSet<String> = HashSet::new();

    let contacts_file = data_dir.join(format!("contacts_store_v1__{scope}.json"));
    if let Some(value) = read_json_file(&contacts_file) {
        if let Some(contacts) = value.get("contacts").and_then(|v| v.as_object()) {
            for (key, item) in contacts {
                let id = item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or(key)
                    .trim();
                if !id.is_empty() {
                    session_ids.insert(id.to_string());
                }
            }
        }
    }

    let chat_v1_file = data_dir.join(format!("chat_store_v1__{scope}.json"));
    if let Some(value) = read_json_file(&chat_v1_file) {
        if let Some(sessions) = value.get("sessions").and_then(|v| v.as_object()) {
            for key in sessions.keys() {
                let id = key.trim();
                if !id.is_empty() {
                    session_ids.insert(id.to_string());
                }
            }
        }
    }

    let world_map_file = data_dir.join(format!("world_session_map_v1__{scope}.json"));
    if let Some(value) = read_json_file(&world_map_file) {
        if let Some(map) = value.as_object() {
            for key in map.keys() {
                let id = key.trim();
                if !id.is_empty() {
                    session_ids.insert(id.to_string());
                }
            }
        }
    }

    let index_file = chat_v2_base
        .join(format!("scope_{scope}"))
        .join("index.json");
    if let Some(value) = read_json_file(&index_file) {
        if let Some(sessions) = value.get("sessions").and_then(|v| v.as_object()) {
            for key in sessions.keys() {
                let id = key.trim();
                if !id.is_empty() {
                    session_ids.insert(id.to_string());
                }
            }
        }
    }

    session_ids
}

fn collect_scope_session_ids(app: &AppHandle, data_dir: &Path, scope: &str) -> HashSet<String> {
    let Ok(chat_v2_base) = chat_store_v2_base(app) else {
        return HashSet::new();
    };
    collect_scope_session_ids_from_dirs(data_dir, &chat_v2_base, scope)
}

fn collect_known_data_scopes(data_dir: &Path, chat_v2_base: &Path) -> HashSet<String> {
    let mut scopes: HashSet<String> = HashSet::new();

    if let Ok(entries) = fs::read_dir(data_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            for base in PERSONA_SCOPED_JSON_BASES {
                if let Some(scope) = extract_scoped_json_scope(&name, base) {
                    scopes.insert(scope);
                }
            }
        }
    }

    if let Ok(entries) = fs::read_dir(chat_v2_base) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(raw_scope) = name.strip_prefix("scope_") else {
                continue;
            };
            let scope = normalize_scope_id(raw_scope);
            if !scope.is_empty() {
                scopes.insert(scope);
            }
        }
    }

    scopes
}

fn collect_protected_session_ids(
    data_dir: &Path,
    chat_v2_base: &Path,
    scopes_to_delete: &HashSet<String>,
) -> HashSet<String> {
    let mut protected: HashSet<String> = HashSet::new();
    for scope in collect_known_data_scopes(data_dir, chat_v2_base) {
        if scopes_to_delete.contains(&scope) {
            continue;
        }
        protected.extend(collect_scope_session_ids_from_dirs(
            data_dir,
            chat_v2_base,
            &scope,
        ));
    }
    protected
}

fn delete_path_if_exists(path: &Path, deleted_paths: &mut Vec<String>) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    deleted_paths.push(path.to_string_lossy().to_string());
    Ok(())
}

fn delete_unprotected_session_sidecars(
    data_dir: &Path,
    session_ids: HashSet<String>,
    protected_session_ids: &HashSet<String>,
    deleted_paths: &mut Vec<String>,
) -> Result<(), String> {
    let protected_segments: HashSet<String> = protected_session_ids
        .iter()
        .flat_map(|session_id| session_asset_segments(session_id))
        .collect();
    let mut handled_segments: HashSet<String> = HashSet::new();
    for session_id in session_ids {
        if protected_session_ids.contains(&session_id) {
            continue;
        }
        for safe_sid in session_asset_segments(&session_id) {
            if protected_segments.contains(&safe_sid) || !handled_segments.insert(safe_sid.clone())
            {
                continue;
            }
            let raw_reply_dir = data_dir.join("raw_replies").join(&safe_sid);
            delete_path_if_exists(&raw_reply_dir, deleted_paths)?;
            let wallpaper_dir = data_dir.join("wallpapers").join(&safe_sid);
            delete_path_if_exists(&wallpaper_dir, deleted_paths)?;
            let attachment_dir = data_dir.join("attachments").join(&safe_sid);
            delete_path_if_exists(&attachment_dir, deleted_paths)?;
        }
    }
    Ok(())
}

fn purge_persona_scope_data(
    app: &AppHandle,
    memory_db: &MemoryDb,
    scope: &str,
    protected_session_ids: &HashSet<String>,
    deleted_paths: &mut Vec<String>,
) -> Result<(), String> {
    let normalized_scope = normalize_scope_id(scope);
    if normalized_scope.is_empty() {
        return Ok(());
    }
    let data_dir = get_data_dir(app)?;
    let session_ids = collect_scope_session_ids(app, &data_dir, &normalized_scope);

    memory_db.close_all();

    for base in PERSONA_SCOPED_JSON_BASES {
        let file = data_dir.join(format!("{base}__{normalized_scope}.json"));
        delete_path_if_exists(&file, deleted_paths)?;
    }

    let memory_db_path = data_dir.join(format!("memories__{normalized_scope}.db"));
    delete_path_if_exists(&memory_db_path, deleted_paths)?;
    let memory_db_wal = data_dir.join(format!("memories__{normalized_scope}.db-wal"));
    delete_path_if_exists(&memory_db_wal, deleted_paths)?;
    let memory_db_shm = data_dir.join(format!("memories__{normalized_scope}.db-shm"));
    delete_path_if_exists(&memory_db_shm, deleted_paths)?;

    let chat_v2_dir = chat_store_v2_scope_dir(app, &normalized_scope)?;
    delete_path_if_exists(&chat_v2_dir, deleted_paths)?;

    delete_unprotected_session_sidecars(
        &data_dir,
        session_ids,
        protected_session_ids,
        deleted_paths,
    )?;

    Ok(())
}

fn select_explicit_persona_scopes(
    keep_scopes: &HashSet<String>,
    delete_scopes: HashSet<String>,
) -> Vec<String> {
    let mut scopes: Vec<String> = delete_scopes
        .into_iter()
        .filter(|scope| !keep_scopes.contains(scope))
        .collect();
    scopes.sort();
    scopes
}

#[tauri::command]
pub async fn cleanup_persona_scoped_data(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    keep_persona_ids: Vec<String>,
    delete_persona_ids: Vec<String>,
) -> Result<Value, String> {
    let keep_scopes: HashSet<String> = keep_persona_ids
        .into_iter()
        .map(|id| normalize_scope_id(&id))
        .filter(|scope| !scope.is_empty())
        .collect();
    let explicit_delete_scopes: HashSet<String> = delete_persona_ids
        .into_iter()
        .map(|id| normalize_scope_id(&id))
        .filter(|scope| !scope.is_empty())
        .collect();

    let data_dir = get_data_dir(&app)?;
    let scopes_to_delete = select_explicit_persona_scopes(&keep_scopes, explicit_delete_scopes);
    let scopes_to_delete_set: HashSet<String> = scopes_to_delete.iter().cloned().collect();
    let chat_v2_base = chat_store_v2_base(&app)?;
    let protected_session_ids =
        collect_protected_session_ids(&data_dir, &chat_v2_base, &scopes_to_delete_set);

    let mut deleted_scopes: Vec<String> = Vec::new();
    let mut deleted_paths: Vec<String> = Vec::new();
    let mut failed_scopes: Vec<Value> = Vec::new();

    for scope in scopes_to_delete {
        match purge_persona_scope_data(
            &app,
            &db,
            &scope,
            &protected_session_ids,
            &mut deleted_paths,
        ) {
            Ok(()) => deleted_scopes.push(scope),
            Err(err) => failed_scopes.push(serde_json::json!({
                "scope": scope,
                "error": err,
            })),
        }
    }

    Ok(serde_json::json!({
        "deletedScopes": deleted_scopes,
        "deletedPaths": deleted_paths,
        "failedScopes": failed_scopes,
    }))
}

/// 读取分片聊天索引
#[tauri::command]
pub async fn chat_store_v2_read_index(app: AppHandle, scope: String) -> Result<Value, String> {
    let dir = chat_store_v2_scope_dir(&app, &scope)?;
    let file = dir.join("index.json");
    if !file.exists() {
        return Ok(serde_json::json!({}));
    }
    let json = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

/// 写入分片聊天索引
#[tauri::command]
pub async fn chat_store_v2_write_index(
    app: AppHandle,
    scope: String,
    data: Value,
) -> Result<(), String> {
    let dir = chat_store_v2_scope_dir(&app, &scope)?;
    let file = dir.join("index.json");
    write_json_file(&file, &data)
}

/// 读取分片文件
#[tauri::command]
pub async fn chat_store_v2_read_part(
    app: AppHandle,
    scope: String,
    session_dir: String,
    thread_dir: String,
    part_id: String,
) -> Result<Value, String> {
    let dir = chat_store_v2_thread_dir(&app, &scope, &session_dir, &thread_dir)?;
    let part = validate_safe_key(&part_id, "part_id")?;
    let file = dir.join(format!("{part}.json"));
    if !file.exists() {
        return Ok(serde_json::json!([]));
    }
    let json = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

/// 写入分片文件
#[tauri::command]
pub async fn chat_store_v2_write_part(
    app: AppHandle,
    scope: String,
    session_dir: String,
    thread_dir: String,
    part_id: String,
    data: Value,
) -> Result<(), String> {
    let dir = chat_store_v2_thread_dir(&app, &scope, &session_dir, &thread_dir)?;
    let part = validate_safe_key(&part_id, "part_id")?;
    let file = dir.join(format!("{part}.json"));
    write_json_file(&file, &data)
}

/// 删除分片文件
#[tauri::command]
pub async fn chat_store_v2_delete_part(
    app: AppHandle,
    scope: String,
    session_dir: String,
    thread_dir: String,
    part_id: String,
) -> Result<(), String> {
    let dir = chat_store_v2_thread_dir(&app, &scope, &session_dir, &thread_dir)?;
    let part = validate_safe_key(&part_id, "part_id")?;
    let file = dir.join(format!("{part}.json"));
    if file.exists() {
        fs::remove_file(file).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 写入大字段旁路文件（分片 JSON 只保存引用和预览）
#[tauri::command]
pub async fn chat_store_v2_write_field(
    app: AppHandle,
    scope: String,
    session_dir: String,
    thread_dir: String,
    field_id: String,
    text: String,
) -> Result<(), String> {
    let file = chat_store_v2_field_path(&app, &scope, &session_dir, &thread_dir, &field_id)?;
    write_bytes_file(&file, text.as_bytes())
}

/// 读取大字段旁路文件
#[tauri::command]
pub async fn chat_store_v2_read_field(
    app: AppHandle,
    scope: String,
    session_dir: String,
    thread_dir: String,
    field_id: String,
) -> Result<Option<String>, String> {
    let file = chat_store_v2_field_path(&app, &scope, &session_dir, &thread_dir, &field_id)?;
    if !file.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(file).map_err(|e| e.to_string())?;
    Ok(Some(text))
}

/// 删除大字段旁路文件
#[tauri::command]
pub async fn chat_store_v2_delete_field(
    app: AppHandle,
    scope: String,
    session_dir: String,
    thread_dir: String,
    field_id: String,
) -> Result<(), String> {
    let file = chat_store_v2_field_path(&app, &scope, &session_dir, &thread_dir, &field_id)?;
    if file.exists() {
        fs::remove_file(file).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 删除会话内的某个线程（当前/存档）
#[tauri::command]
pub async fn chat_store_v2_delete_thread(
    app: AppHandle,
    scope: String,
    session_dir: String,
    thread_dir: String,
) -> Result<(), String> {
    let dir = chat_store_v2_thread_dir(&app, &scope, &session_dir, &thread_dir)?;
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 删除会话目录（含全部分片/存档）
#[tauri::command]
pub async fn chat_store_v2_delete_session(
    app: AppHandle,
    scope: String,
    session_dir: String,
) -> Result<(), String> {
    let scope_dir = chat_store_v2_scope_dir(&app, &scope)?;
    let session_key = validate_safe_key(&session_dir, "session_dir")?;
    let dir = scope_dir.join(format!("session_{session_key}"));
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 保存原始回复（用于富文本/创意写作回溯）
#[tauri::command]
pub async fn save_raw_reply(
    app: AppHandle,
    session_id: String,
    message_id: String,
    text: String,
) -> Result<(), String> {
    let file = raw_reply_path(&app, &session_id, &message_id)?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&file, text).map_err(|e| e.to_string())?;

    #[cfg(target_os = "android")]
    {
        if let Ok(f) = fs::File::open(&file) {
            unsafe {
                libc::fsync(f.as_raw_fd());
            }
        }
    }

    Ok(())
}

/// 读取原始回复
#[tauri::command]
pub async fn load_raw_reply(
    app: AppHandle,
    session_id: String,
    message_id: String,
) -> Result<Option<String>, String> {
    for file in raw_reply_paths(&app, &session_id, &message_id)? {
        if !file.exists() {
            continue;
        }
        let text = fs::read_to_string(file).map_err(|e| e.to_string())?;
        return Ok(Some(text));
    }
    Ok(None)
}

/// 删除原始回复
#[tauri::command]
pub async fn delete_raw_reply(
    app: AppHandle,
    session_id: String,
    message_id: String,
) -> Result<(), String> {
    for file in raw_reply_paths(&app, &session_id, &message_id)? {
        if file.exists() {
            fs::remove_file(file).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn read_plugin_zip_bytes(bytes: Vec<u8>) -> Result<serde_json::Value, String> {
    if bytes.is_empty() {
        return Err("zip bytes empty".to_string());
    }
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;

    let mut manifest_name: Option<String> = None;
    for i in 0..archive.len() {
        let file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().replace('\\', "/");
        if name.to_lowercase().ends_with("manifest.json") {
            let pick = match &manifest_name {
                None => true,
                Some(existing) => name.len() < existing.len(),
            };
            if pick {
                manifest_name = Some(name);
            }
        }
    }
    let manifest_path = manifest_name.ok_or_else(|| "manifest.json not found".to_string())?;

    let manifest_text = {
        let mut file = archive
            .by_name(&manifest_path)
            .map_err(|e| format!("read manifest failed: {e}"))?;
        let mut text = String::new();
        file.read_to_string(&mut text).map_err(|e| e.to_string())?;
        text
    };

    let manifest_json: serde_json::Value =
        serde_json::from_str(&manifest_text).map_err(|e| format!("manifest json invalid: {e}"))?;
    let main_raw = manifest_json
        .get("main")
        .and_then(|v| v.as_str())
        .or_else(|| manifest_json.get("js").and_then(|v| v.as_str()))
        .unwrap_or("index.js");

    let normalize_path = |raw: &str| -> String {
        let mut out = raw.replace('\\', "/");
        while out.starts_with("./") {
            out = out.trim_start_matches("./").to_string();
        }
        while out.starts_with('/') {
            out = out.trim_start_matches('/').to_string();
        }
        let mut parts: Vec<&str> = Vec::new();
        for part in out.split('/') {
            if part.is_empty() || part == "." {
                continue;
            }
            if part == ".." {
                parts.pop();
                continue;
            }
            parts.push(part);
        }
        parts.join("/")
    };

    let base_dir = match manifest_path.rsplit_once('/') {
        Some((dir, _)) => format!("{dir}/"),
        None => String::new(),
    };
    let main_path = format!("{}{}", base_dir, normalize_path(main_raw));

    let main_text = {
        let mut file = archive
            .by_name(&main_path)
            .map_err(|e| format!("main file not found: {e}"))?;
        let mut text = String::new();
        file.read_to_string(&mut text).map_err(|e| e.to_string())?;
        text
    };

    Ok(serde_json::json!({
        "manifestPath": manifest_path,
        "manifestText": manifest_text,
        "mainPath": main_path,
        "mainText": main_text
    }))
}

#[tauri::command]
pub async fn read_plugin_zip(bytes: Vec<u8>) -> Result<serde_json::Value, String> {
    read_plugin_zip_bytes(bytes)
}

#[derive(serde::Serialize)]
pub struct ZipEntryPayload {
    pub name: String,
    pub size: usize,
    pub is_text: bool,
    pub text: Option<String>,
    pub base64: Option<String>,
}

const ZIP_ENTRY_MAX_TOTAL_BYTES: usize = 30 * 1024 * 1024;
const ZIP_ENTRY_MAX_FILE_BYTES: usize = 12 * 1024 * 1024;

fn is_text_zip_entry_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".json")
        || lower.ends_with(".txt")
        || lower.ends_with(".md")
        || lower.ends_with(".js")
        || lower.ends_with(".yaml")
        || lower.ends_with(".yml")
}

fn read_zip_entry_payloads<R: Read + Seek>(reader: R) -> Result<Vec<ZipEntryPayload>, String> {
    let mut archive = ZipArchive::new(reader).map_err(|e| e.to_string())?;
    let mut out: Vec<ZipEntryPayload> = Vec::new();
    let mut total: usize = 0;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().replace('\\', "/");
        let mut buf: Vec<u8> = Vec::new();
        file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        if buf.len() > ZIP_ENTRY_MAX_FILE_BYTES {
            return Err(format!("zip entry too large: {}", name));
        }
        total = total.saturating_add(buf.len());
        if total > ZIP_ENTRY_MAX_TOTAL_BYTES {
            return Err("zip too large".to_string());
        }
        if is_text_zip_entry_name(&name) {
            if let Ok(text) = String::from_utf8(buf.clone()) {
                out.push(ZipEntryPayload {
                    name,
                    size: buf.len(),
                    is_text: true,
                    text: Some(text),
                    base64: None,
                });
                continue;
            }
        }
        let encoded = BASE64_ENGINE.encode(&buf);
        out.push(ZipEntryPayload {
            name,
            size: buf.len(),
            is_text: false,
            text: None,
            base64: Some(encoded),
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn read_zip_entries(bytes: Vec<u8>) -> Result<Vec<ZipEntryPayload>, String> {
    if bytes.is_empty() {
        return Err("zip bytes empty".to_string());
    }
    read_zip_entry_payloads(Cursor::new(bytes))
}

#[derive(serde::Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub ok: bool,
    pub headers: HashMap<String, String>,
    pub body: String,
}

fn set_http_stream_meta(
    state: &Arc<Mutex<HashMap<String, HttpStreamEntry>>>,
    request_id: &str,
    status: u16,
    ok: bool,
    headers: HashMap<String, String>,
) {
    if let Ok(mut map) = state.lock() {
        if let Some(entry) = map.get_mut(request_id) {
            entry.status = Some(status);
            entry.ok = Some(ok);
            entry.headers = Some(headers);
        }
    }
}

fn push_http_stream_chunk(
    state: &Arc<Mutex<HashMap<String, HttpStreamEntry>>>,
    request_id: &str,
    chunk: String,
) {
    if chunk.is_empty() {
        return;
    }
    if let Ok(mut map) = state.lock() {
        if let Some(entry) = map.get_mut(request_id) {
            entry.chunks.push_back(chunk);
        }
    }
}

fn push_http_stream_utf8_bytes(
    state: &Arc<Mutex<HashMap<String, HttpStreamEntry>>>,
    request_id: &str,
    pending: &mut Vec<u8>,
    bytes: &[u8],
) {
    if !bytes.is_empty() {
        pending.extend_from_slice(bytes);
    }
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                if !text.is_empty() {
                    push_http_stream_chunk(state, request_id, text.to_string());
                }
                pending.clear();
                break;
            }
            Err(err) => {
                let valid_up_to = err.valid_up_to();
                if valid_up_to > 0 {
                    if let Ok(text) = std::str::from_utf8(&pending[..valid_up_to]) {
                        push_http_stream_chunk(state, request_id, text.to_string());
                    }
                    pending.drain(..valid_up_to);
                    continue;
                }
                if err.error_len().is_none() {
                    break;
                }
                push_http_stream_chunk(state, request_id, "\u{FFFD}".to_string());
                let drain_len = err.error_len().unwrap_or(1).min(pending.len());
                pending.drain(..drain_len);
                if pending.is_empty() {
                    break;
                }
            }
        }
    }
}

fn finish_http_stream_utf8_bytes(
    state: &Arc<Mutex<HashMap<String, HttpStreamEntry>>>,
    request_id: &str,
    pending: &mut Vec<u8>,
) {
    if pending.is_empty() {
        return;
    }
    let text = String::from_utf8_lossy(pending).to_string();
    pending.clear();
    push_http_stream_chunk(state, request_id, text);
}

fn finish_http_stream(
    state: &Arc<Mutex<HashMap<String, HttpStreamEntry>>>,
    request_id: &str,
    error: Option<String>,
) {
    if let Ok(mut map) = state.lock() {
        if let Some(entry) = map.get_mut(request_id) {
            if let Some(err) = error {
                entry.error = Some(err);
            }
            entry.done = true;
        }
    }
}

const DEFAULT_PUBLIC_HTTP_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_PUBLIC_HTTP_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_PUBLIC_HTTP_REDIRECTS: usize = 5;

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _d] = ip.octets();
    !(a == 0
        || a == 10
        || (a == 100 && (64..=127).contains(&b))
        || a == 127
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4() {
        return is_public_ipv4(mapped);
    }
    let segments = ip.segments();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => is_public_ipv4(value),
        IpAddr::V6(value) => is_public_ipv6(value),
    }
}

async fn resolve_public_http_target(url: &reqwest::Url) -> Result<Vec<SocketAddr>, String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("public web request only supports http/https".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("public web request URL credentials are not allowed".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "public web request URL has no host".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "public web request URL has no valid port".to_string())?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !is_public_ip(ip) {
            return Err("public web request blocked a non-public IP address".to_string());
        }
        return Ok(vec![SocketAddr::new(ip, port)]);
    }

    let mut addresses = Vec::new();
    for address in tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("public web DNS lookup failed: {error}"))?
    {
        if !is_public_ip(address.ip()) {
            return Err("public web request DNS resolved to a non-public IP address".to_string());
        }
        if !addresses.contains(&address) {
            addresses.push(address);
        }
    }
    if addresses.is_empty() {
        return Err("public web DNS lookup returned no addresses".to_string());
    }
    Ok(addresses)
}

fn public_http_content_type_allowed(headers: &reqwest::header::HeaderMap) -> bool {
    let Some(value) = headers.get(reqwest::header::CONTENT_TYPE) else {
        return true;
    };
    let Ok(raw) = value.to_str() else {
        return false;
    };
    let mime = raw
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    mime.starts_with("text/")
        || mime == "application/json"
        || mime.ends_with("+json")
        || mime == "application/xml"
        || mime.ends_with("+xml")
        || mime == "application/xhtml+xml"
}

fn public_http_has_sensitive_headers(headers: &reqwest::header::HeaderMap) -> bool {
    [
        "authorization",
        "proxy-authorization",
        "cookie",
        "x-api-key",
        "x-subscription-token",
    ]
    .iter()
    .any(|name| headers.contains_key(*name))
}

async fn execute_public_http_request(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    max_response_bytes: Option<usize>,
) -> Result<HttpResponse, String> {
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut current_url = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    let mut header_map = reqwest::header::HeaderMap::new();
    for (key, value) in headers {
        let name =
            reqwest::header::HeaderName::from_bytes(key.as_bytes()).map_err(|e| e.to_string())?;
        let value = reqwest::header::HeaderValue::from_str(&value).map_err(|e| e.to_string())?;
        header_map.insert(name, value);
    }
    let timeout =
        std::time::Duration::from_millis(timeout_ms.unwrap_or(12_000).clamp(1_000, 30_000));
    let response_limit = max_response_bytes
        .unwrap_or(DEFAULT_PUBLIC_HTTP_RESPONSE_BYTES)
        .clamp(1024, MAX_PUBLIC_HTTP_RESPONSE_BYTES);

    for redirect_count in 0..=MAX_PUBLIC_HTTP_REDIRECTS {
        let resolved = resolve_public_http_target(&current_url).await?;
        let host = current_url
            .host_str()
            .ok_or_else(|| "public web request URL has no host".to_string())?;
        let mut client_builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(timeout);
        if host.parse::<IpAddr>().is_err() {
            client_builder = client_builder.resolve_to_addrs(host, &resolved);
        }
        let client = client_builder.build().map_err(|e| e.to_string())?;
        let mut request = client
            .request(method.clone(), current_url.clone())
            .headers(header_map.clone());
        if let Some(value) = body.as_ref() {
            request = request.body(value.clone());
        }
        let mut response = request.send().await.map_err(|e| e.to_string())?;
        let status = response.status();

        if status.is_redirection() {
            if redirect_count >= MAX_PUBLIC_HTTP_REDIRECTS {
                return Err("public web request exceeded redirect limit".to_string());
            }
            if method != reqwest::Method::GET && method != reqwest::Method::HEAD {
                return Err(
                    "public web request refused a redirect for a non-GET request".to_string(),
                );
            }
            if public_http_has_sensitive_headers(&header_map) {
                return Err("public web request refused to redirect credentials".to_string());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "public web redirect has no valid location".to_string())?;
            current_url = current_url.join(location).map_err(|e| e.to_string())?;
            continue;
        }

        if !public_http_content_type_allowed(response.headers()) {
            return Err("public web request blocked a non-text response".to_string());
        }
        if response
            .content_length()
            .map(|length| length > response_limit as u64)
            .unwrap_or(false)
        {
            return Err("public web response exceeds the size limit".to_string());
        }

        let mut out_headers = HashMap::new();
        for (key, value) in response.headers().iter() {
            if let Ok(value) = value.to_str() {
                out_headers.insert(key.as_str().to_string(), value.to_string());
            }
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len().saturating_add(chunk.len()) > response_limit {
                return Err("public web response exceeds the size limit".to_string());
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok(HttpResponse {
            status: status.as_u16(),
            ok: status.is_success(),
            headers: out_headers,
            body: String::from_utf8_lossy(&bytes).to_string(),
        });
    }
    Err("public web request exceeded redirect limit".to_string())
}

/// Text-only public network request for web search tools. Unlike `http_request`, this rejects
/// local/private targets, pins validated DNS results, checks every redirect, and caps the body.
#[tauri::command]
pub async fn public_http_request(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    request_id: Option<String>,
    max_response_bytes: Option<usize>,
    abort_state: State<'_, HttpAbortState>,
) -> Result<HttpResponse, String> {
    let request_key = match request_id {
        Some(raw) => Some(validate_safe_key(&raw, "request_id")?),
        None => None,
    };
    let task = tokio::spawn(execute_public_http_request(
        url,
        method,
        headers,
        body,
        timeout_ms,
        max_response_bytes,
    ));
    if let Some(key) = request_key.clone() {
        let abort_handle = task.abort_handle();
        let mut map = abort_state
            .inner
            .lock()
            .map_err(|_| "http abort state lock poisoned".to_string())?;
        if let Some(previous) = map.insert(key, abort_handle) {
            previous.abort();
        }
    }
    let joined = task.await;
    if let Some(key) = request_key {
        if let Ok(mut map) = abort_state.inner.lock() {
            map.remove(&key);
        }
    }
    match joined {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => Err("aborted".to_string()),
        Err(error) => Err(error.to_string()),
    }
}

// OpenCode accepts each client's own identity. Use our compiled version; the JS
// transport marks these requests with our product token and a conversation ID.
fn complete_opencode_user_agent(headers: &mut reqwest::header::HeaderMap) {
    use reqwest::header::{HeaderValue, USER_AGENT};
    if headers.contains_key("x-opencode-session")
        && headers.get(USER_AGENT).and_then(|value| value.to_str().ok()) == Some("OmniTavern")
    {
        headers.insert(
            USER_AGENT,
            HeaderValue::from_static(concat!("OmniTavern/", env!("CARGO_PKG_VERSION"))),
        );
    }
}

/// Native HTTP request to bypass WebView CORS (used by OpenAI-compatible providers like DeepSeek).
#[tauri::command]
pub async fn http_request(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    body_base64: Option<String>,
    timeout_ms: Option<u64>,
    request_id: Option<String>,
    response_base64: Option<bool>,
    abort_state: State<'_, HttpAbortState>,
) -> Result<HttpResponse, String> {
    let request_key = match request_id {
        Some(raw) => Some(validate_safe_key(&raw, "request_id")?),
        None => None,
    };

    let task = tokio::spawn(async move {
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;

        let mut header_map = reqwest::header::HeaderMap::new();
        for (k, v) in headers {
            let name =
                reqwest::header::HeaderName::from_bytes(k.as_bytes()).map_err(|e| e.to_string())?;
            let value = reqwest::header::HeaderValue::from_str(&v).map_err(|e| e.to_string())?;
            header_map.insert(name, value);
        }

        complete_opencode_user_agent(&mut header_map);
        let mut builder = reqwest::Client::builder();
        if let Some(ms) = timeout_ms {
            builder = builder.timeout(std::time::Duration::from_millis(ms));
        }
        let client = builder.build().map_err(|e| e.to_string())?;

        let mut req = client.request(method, url).headers(header_map);
        if let Some(body_base64) = body_base64 {
            let bytes = BASE64_ENGINE
                .decode(body_base64)
                .map_err(|e| e.to_string())?;
            req = req.body(bytes);
        } else if let Some(body) = body {
            req = req.body(body);
        }

        let resp = req.send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        let mut out_headers: HashMap<String, String> = HashMap::new();
        for (k, v) in resp.headers().iter() {
            if let Ok(vs) = v.to_str() {
                out_headers.insert(k.as_str().to_string(), vs.to_string());
            }
        }
        let body = if response_base64.unwrap_or(false) {
            let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
            BASE64_ENGINE.encode(bytes)
        } else {
            resp.text().await.map_err(|e| e.to_string())?
        };

        Ok(HttpResponse {
            status: status.as_u16(),
            ok: status.is_success(),
            headers: out_headers,
            body,
        })
    });

    if let Some(key) = request_key.clone() {
        let abort_handle = task.abort_handle();
        let mut map = abort_state
            .inner
            .lock()
            .map_err(|_| "http abort state lock poisoned".to_string())?;
        if let Some(prev) = map.insert(key, abort_handle) {
            prev.abort();
        }
    }

    let joined = task.await;

    if let Some(key) = request_key {
        if let Ok(mut map) = abort_state.inner.lock() {
            map.remove(&key);
        }
    }

    match joined {
        Ok(result) => result,
        Err(err) if err.is_cancelled() => Err("aborted".to_string()),
        Err(err) => Err(err.to_string()),
    }
}

fn validate_openai_realtime_call_input(
    base_url: &str,
    api_key: &str,
    sdp: &str,
    session_json: &str,
) -> Result<(String, String), String> {
    let normalized_base = base_url.trim().trim_end_matches('/');
    if normalized_base != "https://api.openai.com/v1" {
        return Err(
            "OpenAI Realtime requires the official https://api.openai.com/v1 endpoint".to_string(),
        );
    }
    let key = api_key.trim();
    if key.is_empty() || key.len() > 1024 {
        return Err("OpenAI Realtime API key is missing or invalid".to_string());
    }
    let offer = sdp.trim();
    if offer.is_empty() || offer.len() > 1_000_000 || !offer.starts_with("v=0") {
        return Err("OpenAI Realtime SDP offer is invalid".to_string());
    }
    if session_json.len() > 256_000 {
        return Err("OpenAI Realtime session config is too large".to_string());
    }
    let session: Value = serde_json::from_str(session_json)
        .map_err(|_| "OpenAI Realtime session config is invalid JSON".to_string())?;
    if session.get("type").and_then(Value::as_str) != Some("realtime") {
        return Err("OpenAI Realtime session config has an invalid type".to_string());
    }
    if session
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return Err("OpenAI Realtime session config has no model".to_string());
    }
    Ok((format!("{normalized_base}/realtime/calls"), key.to_string()))
}

fn sanitize_openai_realtime_error(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let message = serde_json::from_str::<Value>(trimmed)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.get("message"))
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| trimmed.to_string());
    message.chars().take(400).collect()
}

fn build_openai_realtime_call_form(
    sdp: String,
    session_json: String,
) -> Result<reqwest::multipart::Form, String> {
    let sdp_part = reqwest::multipart::Part::text(sdp)
        .mime_str("application/sdp")
        .map_err(|_| "OpenAI Realtime multipart encoding failed".to_string())?;
    let session_part = reqwest::multipart::Part::text(session_json)
        .mime_str("application/json")
        .map_err(|_| "OpenAI Realtime multipart encoding failed".to_string())?;
    Ok(reqwest::multipart::Form::new()
        .part("sdp", sdp_part)
        .part("session", session_part))
}

fn validate_openai_realtime_sdp_answer(body: String) -> Result<String, String> {
    if body.is_empty() || body.len() > 1_000_000 || !body.starts_with("v=0") {
        return Err("OpenAI Realtime returned an invalid SDP answer".to_string());
    }
    Ok(body)
}

/// Creates one OpenAI Realtime WebRTC call through the unified multipart endpoint.
/// The API key and SDP are consumed only by this native request and never logged.
async fn execute_openai_realtime_call(
    url: String,
    key: String,
    sdp: String,
    session_json: String,
    timeout: std::time::Duration,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(timeout)
        .timeout(timeout)
        .build()
        .map_err(|_| "OpenAI Realtime native client initialization failed".to_string())?;
    let form = build_openai_realtime_call_form(sdp, session_json)?;
    let response = client
        .post(url)
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "OpenAI Realtime connection timed out".to_string()
            } else {
                "OpenAI Realtime connection failed".to_string()
            }
        })?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|_| "OpenAI Realtime response could not be read".to_string())?;
    if !status.is_success() {
        let detail = sanitize_openai_realtime_error(&body);
        return Err(if detail.is_empty() {
            format!("OpenAI Realtime session failed (HTTP {})", status.as_u16())
        } else {
            format!(
                "OpenAI Realtime session failed (HTTP {}): {detail}",
                status.as_u16()
            )
        });
    }
    validate_openai_realtime_sdp_answer(body)
}

async fn await_abortable_realtime_task<T: Send + 'static>(
    task: tokio::task::JoinHandle<Result<T, String>>,
    request_key: Option<String>,
    abort_handles: Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>,
) -> Result<T, String> {
    if let Some(key) = request_key.clone() {
        let abort_handle = task.abort_handle();
        let mut map = abort_handles
            .lock()
            .map_err(|_| "http abort state lock poisoned".to_string())?;
        if let Some(previous) = map.insert(key, abort_handle) {
            previous.abort();
        }
    }
    let joined = task.await;
    if let Some(key) = request_key {
        if let Ok(mut map) = abort_handles.lock() {
            map.remove(&key);
        }
    }
    match joined {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => Err("aborted".to_string()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn openai_realtime_create_call(
    base_url: String,
    api_key: String,
    sdp: String,
    session_json: String,
    timeout_ms: Option<u64>,
    request_id: Option<String>,
    abort_state: State<'_, HttpAbortState>,
) -> Result<String, String> {
    let (url, key) = validate_openai_realtime_call_input(&base_url, &api_key, &sdp, &session_json)?;
    let request_key = match request_id {
        Some(raw) => Some(validate_safe_key(&raw, "request_id")?),
        None => None,
    };
    let timeout =
        std::time::Duration::from_millis(timeout_ms.unwrap_or(30_000).clamp(5_000, 60_000));
    let task = tokio::spawn(execute_openai_realtime_call(
        url,
        key,
        sdp,
        session_json,
        timeout,
    ));
    await_abortable_realtime_task(task, request_key, abort_state.inner.clone()).await
}

fn describe_http_stream_error(e: &reqwest::Error) -> String {
    use std::error::Error as _;
    let mut msg = e.to_string();
    let mut source = e.source();
    while let Some(cause) = source {
        msg.push_str(": ");
        msg.push_str(&cause.to_string());
        source = cause.source();
    }
    msg
}

#[tauri::command]
pub async fn http_stream_request_start(
    url: String,
    method: String,
    mut headers: HashMap<String, String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    request_id: String,
    response_base64: Option<bool>,
    abort_state: State<'_, HttpAbortState>,
    stream_state: State<'_, HttpStreamState>,
) -> Result<bool, String> {
    let key = validate_safe_key(&request_id, "request_id")?;

    if let Ok(mut map) = abort_state.inner.lock() {
        if let Some(prev) = map.remove(&key) {
            prev.abort();
        }
    }
    if let Ok(mut map) = stream_state.inner.lock() {
        map.insert(key.clone(), HttpStreamEntry::default());
    }

    let abort_map = abort_state.inner.clone();
    let stream_map = stream_state.inner.clone();
    let request_key = key.clone();
    let encode_binary_chunks = response_base64.unwrap_or(false);
    let task = tokio::spawn(async move {
        let result: Result<(), String> = async {
            let has_accept_encoding = headers
                .keys()
                .any(|name| name.eq_ignore_ascii_case("accept-encoding"));
            if !has_accept_encoding {
                headers.insert("accept-encoding".to_string(), "identity".to_string());
            }
            let method =
                reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;

            let mut header_map = reqwest::header::HeaderMap::new();
            for (k, v) in headers {
                let name = reqwest::header::HeaderName::from_bytes(k.as_bytes())
                    .map_err(|e| e.to_string())?;
                let value =
                    reqwest::header::HeaderValue::from_str(&v).map_err(|e| e.to_string())?;
                header_map.insert(name, value);
            }

            complete_opencode_user_agent(&mut header_map);
            // 流式请求不使用 reqwest 总超时——它覆盖整个响应体读取，会把健康的
            // 长流在中途杀死并伪装成 "error decoding response body"。改为
            // 连接超时 + 响应头超时 + 块间空闲超时，仅在链路真正无数据时失败。
            let idle_timeout = timeout_ms.map(std::time::Duration::from_millis);
            let mut builder = reqwest::Client::builder();
            if let Some(d) = idle_timeout {
                builder = builder.connect_timeout(d);
            }
            let client = builder.build().map_err(|e| e.to_string())?;

            let mut req = client.request(method, url).headers(header_map);
            if let Some(body) = body {
                req = req.body(body);
            }

            let mut resp = match idle_timeout {
                Some(d) => tokio::time::timeout(d, req.send())
                    .await
                    .map_err(|_| {
                        format!(
                            "http stream timed out after {}ms waiting for response headers",
                            d.as_millis()
                        )
                    })?
                    .map_err(|e| describe_http_stream_error(&e))?,
                None => req
                    .send()
                    .await
                    .map_err(|e| describe_http_stream_error(&e))?,
            };
            let status = resp.status();
            let mut out_headers: HashMap<String, String> = HashMap::new();
            for (k, v) in resp.headers().iter() {
                if let Ok(vs) = v.to_str() {
                    out_headers.insert(k.as_str().to_string(), vs.to_string());
                }
            }
            set_http_stream_meta(
                &stream_map,
                &request_key,
                status.as_u16(),
                status.is_success(),
                out_headers,
            );

            let mut utf8_pending: Vec<u8> = Vec::new();
            loop {
                let next = match idle_timeout {
                    Some(d) => tokio::time::timeout(d, resp.chunk()).await.map_err(|_| {
                        format!(
                            "http stream idle timeout: no data received for {}ms",
                            d.as_millis()
                        )
                    })?,
                    None => resp.chunk().await,
                };
                let Some(chunk) = next.map_err(|e| describe_http_stream_error(&e))? else {
                    break;
                };
                if encode_binary_chunks {
                    push_http_stream_chunk(
                        &stream_map,
                        &request_key,
                        BASE64_ENGINE.encode(chunk.as_ref()),
                    );
                } else {
                    push_http_stream_utf8_bytes(
                        &stream_map,
                        &request_key,
                        &mut utf8_pending,
                        chunk.as_ref(),
                    );
                }
            }
            if !encode_binary_chunks {
                finish_http_stream_utf8_bytes(&stream_map, &request_key, &mut utf8_pending);
            }
            Ok(())
        }
        .await;

        finish_http_stream(&stream_map, &request_key, result.err());
        if let Ok(mut map) = abort_map.lock() {
            map.remove(&request_key);
        }
    });

    let abort_handle = task.abort_handle();
    let mut map = abort_state
        .inner
        .lock()
        .map_err(|_| "http abort state lock poisoned".to_string())?;
    if let Some(prev) = map.insert(key, abort_handle) {
        prev.abort();
    }
    Ok(true)
}

#[tauri::command]
pub async fn http_stream_request_read(
    request_id: String,
    max_chunks: Option<usize>,
    stream_state: State<'_, HttpStreamState>,
) -> Result<HttpStreamReadResult, String> {
    let key = validate_safe_key(&request_id, "request_id")?;
    let take_limit = max_chunks.unwrap_or(32).max(1);
    let mut map = stream_state
        .inner
        .lock()
        .map_err(|_| "http stream state lock poisoned".to_string())?;
    let (result, should_remove) = {
        let entry = map
            .get_mut(&key)
            .ok_or_else(|| "http stream request not found".to_string())?;
        read_http_stream_entry(entry, take_limit)
    };

    if should_remove {
        map.remove(&key);
    }

    Ok(result)
}

fn read_http_stream_entry(
    entry: &mut HttpStreamEntry,
    take_limit: usize,
) -> (HttpStreamReadResult, bool) {
    let mut chunks = Vec::new();
    for _ in 0..take_limit {
        if let Some(chunk) = entry.chunks.pop_front() {
            chunks.push(chunk);
        } else {
            break;
        }
    }
    let should_remove = entry.done && entry.chunks.is_empty();
    (
        HttpStreamReadResult {
            status: entry.status,
            ok: entry.ok,
            headers: entry.headers.clone(),
            chunks,
            done: should_remove,
            error: entry.error.clone(),
        },
        should_remove,
    )
}

#[tauri::command]
pub async fn http_stream_request_close(
    request_id: String,
    stream_state: State<'_, HttpStreamState>,
) -> Result<bool, String> {
    let key = validate_safe_key(&request_id, "request_id")?;
    let mut map = stream_state
        .inner
        .lock()
        .map_err(|_| "http stream state lock poisoned".to_string())?;
    Ok(map.remove(&key).is_some())
}

#[tauri::command]
pub async fn http_abort_request(
    request_id: String,
    abort_state: State<'_, HttpAbortState>,
    stream_state: State<'_, HttpStreamState>,
) -> Result<bool, String> {
    let key = validate_safe_key(&request_id, "request_id")?;
    let handle = {
        let mut map = abort_state
            .inner
            .lock()
            .map_err(|_| "http abort state lock poisoned".to_string())?;
        map.remove(&key)
    };
    if let Some(handle) = handle {
        handle.abort();
        finish_http_stream(&stream_state.inner, &key, Some("aborted".to_string()));
        return Ok(true);
    }
    Ok(false)
}

/// JS -> Rust log bridge (prints to logcat via stderr on Android)
#[tauri::command]
pub async fn log_js(
    tag: String,
    level: Option<String>,
    message: String,
    data: Option<Value>,
) -> Result<(), String> {
    let tag = tag.trim();
    if tag.is_empty() {
        return Ok(());
    }
    let lvl = level.unwrap_or_else(|| "info".to_string());
    let mut msg = message;
    // Avoid huge logcat entries (e.g. prompt blobs)
    const MAX_LEN: usize = 2000;
    if msg.len() > MAX_LEN {
        msg.truncate(MAX_LEN);
        msg.push_str("…");
    }
    if let Some(d) = data {
        let dv = serde_json::to_string(&d).unwrap_or_else(|_| "\"<unserializable>\"".to_string());
        let mut ds = dv;
        if ds.len() > MAX_LEN {
            ds.truncate(MAX_LEN);
            ds.push_str("…");
        }
        eprintln!("[js][{}][{}] {} {}", tag, lvl, msg, ds);
    } else {
        eprintln!("[js][{}][{}] {}", tag, lvl, msg);
    }
    Ok(())
}

#[tauri::command]
pub async fn init_database(
    db: State<'_, MemoryDb>,
    scope_id: Option<String>,
) -> Result<(), String> {
    db.init_database(scope_id)
}

#[tauri::command]
pub async fn create_memory(
    db: State<'_, MemoryDb>,
    scope_id: Option<String>,
    input: MemoryCreateInput,
) -> Result<String, String> {
    db.create_memory(scope_id, input)
}

#[tauri::command]
pub async fn update_memory(
    db: State<'_, MemoryDb>,
    scope_id: Option<String>,
    input: MemoryUpdateInput,
) -> Result<(), String> {
    db.update_memory(scope_id, input)
}

#[tauri::command]
pub async fn delete_memory(
    db: State<'_, MemoryDb>,
    scope_id: Option<String>,
    id: String,
) -> Result<(), String> {
    db.delete_memory(scope_id, id)
}

#[tauri::command]
pub async fn get_memories(
    db: State<'_, MemoryDb>,
    scope_id: Option<String>,
    query: MemoryQuery,
) -> Result<Vec<MemoryRecord>, String> {
    db.get_memories(scope_id, query)
}

#[tauri::command]
pub async fn batch_create_memories(
    db: State<'_, MemoryDb>,
    scope_id: Option<String>,
    memories: Vec<MemoryCreateInput>,
) -> Result<usize, String> {
    db.batch_create_memories(scope_id, memories)
}

#[tauri::command]
pub async fn batch_delete_memories(
    db: State<'_, MemoryDb>,
    scope_id: Option<String>,
    ids: Vec<String>,
) -> Result<usize, String> {
    db.batch_delete_memories(scope_id, ids)
}

#[tauri::command]
pub async fn save_template(
    db: State<'_, MemoryDb>,
    scope_id: Option<String>,
    input: TemplateInput,
) -> Result<(), String> {
    db.save_template(scope_id, input)
}

#[tauri::command]
pub async fn get_templates(
    db: State<'_, MemoryDb>,
    scope_id: Option<String>,
    query: TemplateQuery,
) -> Result<Vec<TemplateRecord>, String> {
    db.get_templates(scope_id, query)
}

#[tauri::command]
pub async fn delete_template(
    db: State<'_, MemoryDb>,
    scope_id: Option<String>,
    id: String,
) -> Result<(), String> {
    db.delete_template(scope_id, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn opencode_user_agent_uses_app_version_only_for_marked_requests() {
        use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("OmniTavern"));
        complete_opencode_user_agent(&mut headers);
        assert_eq!(headers[USER_AGENT], "OmniTavern");
        headers.insert("x-opencode-session", HeaderValue::from_static("ot_fixture"));
        complete_opencode_user_agent(&mut headers);
        assert_eq!(headers[USER_AGENT], concat!("OmniTavern/", env!("CARGO_PKG_VERSION")));
        headers.insert(USER_AGENT, HeaderValue::from_static("another-client/1"));
        complete_opencode_user_agent(&mut headers);
        assert_eq!(headers[USER_AGENT], "another-client/1");
        assert_eq!(headers["x-opencode-session"], "ot_fixture");
    }

    #[test]
    fn openai_realtime_call_contract_accepts_only_official_valid_inputs() {
        let valid_session = r#"{"type":"realtime","model":"gpt-realtime-2.1"}"#;
        let valid = validate_openai_realtime_call_input(
            "https://api.openai.com/v1/",
            "sk-test",
            "v=0\r\no=- 0 0 IN IP4 127.0.0.1",
            valid_session,
        )
        .unwrap();
        assert_eq!(valid.0, "https://api.openai.com/v1/realtime/calls");
        assert_eq!(valid.1, "sk-test");

        assert!(validate_openai_realtime_call_input(
            "https://example.com/v1",
            "sk-test",
            "v=0\r\n",
            valid_session,
        )
        .is_err());
        assert!(validate_openai_realtime_call_input(
            "https://api.openai.com/v1",
            "",
            "v=0\r\n",
            valid_session,
        )
        .is_err());
        assert!(validate_openai_realtime_call_input(
            "https://api.openai.com/v1",
            "sk-test",
            "not-sdp",
            valid_session,
        )
        .is_err());
        assert!(validate_openai_realtime_call_input(
            "https://api.openai.com/v1",
            "sk-test",
            "v=0\r\n",
            r#"{"type":"transcription","model":"gpt-realtime-2.1"}"#,
        )
        .is_err());
    }

    #[test]
    fn openai_realtime_multipart_preserves_sdp_and_part_content_types() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
                let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                });
                if content_length.is_some_and(|length| request.len() >= header_end + 4 + length) {
                    break;
                }
            }
            stream
                .write_all(
                    b"HTTP/1.1 201 Created\r\nContent-Type: application/sdp\r\nContent-Length: 5\r\nConnection: close\r\n\r\nv=0\r\n",
                )
                .unwrap();
            String::from_utf8(request).unwrap()
        });

        let sdp = "v=0\r\no=fake-offer\r\n";
        let session_json = r#"{"type":"realtime","model":"gpt-realtime-2.1"}"#;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            reqwest::Client::new()
                .post(format!("http://{address}"))
                .multipart(
                    build_openai_realtime_call_form(sdp.to_string(), session_json.to_string())
                        .unwrap(),
                )
                .send()
                .await
                .unwrap();
        });

        let request = server.join().unwrap();
        assert!(request.contains(
            "Content-Disposition: form-data; name=\"sdp\"\r\nContent-Type: application/sdp\r\n\r\nv=0\r\no=fake-offer\r\n"
        ));
        assert!(request.contains(
            "Content-Disposition: form-data; name=\"session\"\r\nContent-Type: application/json\r\n\r\n{\"type\":\"realtime\",\"model\":\"gpt-realtime-2.1\"}"
        ));
    }

    #[test]
    fn openai_realtime_response_uses_sdp_body_as_the_success_contract() {
        let body = "v=0\r\no=fake-answer\r\n".to_string();
        assert_eq!(
            validate_openai_realtime_sdp_answer(body.clone()).unwrap(),
            body
        );
        assert!(validate_openai_realtime_sdp_answer(r#"{"ok":true}"#.to_string()).is_err());
    }

    #[test]
    fn openai_realtime_error_parser_is_bounded() {
        assert_eq!(
            sanitize_openai_realtime_error(r#"{"error":{"message":"bad request"}}"#),
            "bad request"
        );
        assert_eq!(sanitize_openai_realtime_error("   "), "");
        assert_eq!(sanitize_openai_realtime_error(&"x".repeat(800)).len(), 400);
    }

    #[test]
    fn openai_realtime_broker_enforces_request_timeout() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(150));
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime.block_on(execute_openai_realtime_call(
            format!("http://{address}"),
            "sk-test".to_string(),
            "v=0\r\no=fake-offer\r\n".to_string(),
            r#"{"type":"realtime","model":"gpt-realtime-2.1"}"#.to_string(),
            std::time::Duration::from_millis(25),
        ));
        assert_eq!(result.unwrap_err(), "OpenAI Realtime connection timed out");
        server.join().unwrap();
    }

    #[test]
    fn openai_realtime_broker_task_can_be_cancelled_and_is_removed() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let abort_handles = Arc::new(Mutex::new(HashMap::new()));
            let task = tokio::spawn(async {
                std::future::pending::<()>().await;
                Ok::<String, String>("unreachable".to_string())
            });
            let waiter = tokio::spawn(await_abortable_realtime_task(
                task,
                Some("realtime-cancel-test".to_string()),
                abort_handles.clone(),
            ));
            tokio::task::yield_now().await;
            let handle = abort_handles
                .lock()
                .unwrap()
                .remove("realtime-cancel-test")
                .expect("Realtime task must register its abort handle");
            handle.abort();
            assert_eq!(waiter.await.unwrap().unwrap_err(), "aborted");
            assert!(abort_handles.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn completed_http_stream_only_reports_done_after_queued_chunks_are_drained() {
        let mut entry = HttpStreamEntry {
            status: Some(200),
            ok: Some(true),
            chunks: (0..33).map(|index| index.to_string()).collect(),
            done: true,
            ..HttpStreamEntry::default()
        };

        let (first, first_should_remove) = read_http_stream_entry(&mut entry, 32);
        assert_eq!(first.chunks.len(), 32);
        assert!(!first.done);
        assert!(!first_should_remove);

        let (last, last_should_remove) = read_http_stream_entry(&mut entry, 32);
        assert_eq!(last.chunks, vec!["32".to_string()]);
        assert!(last.done);
        assert!(last_should_remove);
    }

    fn unique_temp_data_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("chatapp-{label}-{}-{nanos}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_json(path: &Path, value: Value) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    #[test]
    fn public_http_ip_filter_rejects_local_and_special_ranges() {
        for blocked in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "198.18.0.1",
            "224.0.0.1",
            "::",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::127.0.0.1",
        ] {
            assert!(
                !is_public_ip(blocked.parse().unwrap()),
                "{blocked} must be blocked"
            );
        }
        for allowed in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(
                is_public_ip(allowed.parse().unwrap()),
                "{allowed} must be allowed"
            );
        }
    }

    #[test]
    fn backup_sanitizers_remove_web_credentials_and_disable_imported_networking() {
        let settings = sanitize_app_settings_store_value(serde_json::json!({
            "uiThemePresetId": "paper-ink",
            "webSearchApiKey": "secret",
            "braveSearchApiKey": "other-secret"
        }));
        assert_eq!(
            settings.get("uiThemePresetId").and_then(Value::as_str),
            Some("paper-ink")
        );
        assert!(settings.get("webSearchApiKey").is_none());
        assert!(settings.get("braveSearchApiKey").is_none());

        let profiles = sanitize_profile_store_value(serde_json::json!({
            "profiles": {
                "p1": { "activeKeyId": "key-1", "webSearchEnabled": true }
            }
        }));
        let profile = &profiles["profiles"]["p1"];
        assert!(profile.get("activeKeyId").unwrap().is_null());
        assert_eq!(
            profile.get("webSearchEnabled").and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn data_bundle_zip_redacts_search_credentials_from_app_settings() {
        let data_dir = unique_temp_data_dir("bundle-search-secret-redaction");
        write_json(
            &data_dir.join("app_settings_v1.json"),
            serde_json::json!({
                "uiThemePresetId": "paper-ink",
                "webSearchApiKey": "must-not-export"
            }),
        );
        let cursor = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(cursor);
        let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
        assert_eq!(
            add_dir_to_zip(&mut writer, &data_dir, &data_dir, options, None).unwrap(),
            1
        );
        let bytes = writer.finish().unwrap().into_inner();
        let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut entry = archive.by_name("app_settings_v1.json").unwrap();
        let mut json = String::new();
        entry.read_to_string(&mut json).unwrap();
        assert!(json.contains("paper-ink"));
        assert!(!json.contains("must-not-export"));
        assert!(!json.contains("webSearchApiKey"));
        let _ = fs::remove_dir_all(data_dir);
    }

    #[test]
    fn atomic_kv_write_replaces_existing_file_and_removes_temp_file() {
        let data_dir = unique_temp_data_dir("atomic-kv-write");
        let file = data_dir.join("state.json");
        fs::write(&file, br#"{"version":"old"}"#).unwrap();

        write_file_atomically(&file, br#"{"version":"new","complete":true}"#).unwrap();

        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            r#"{"version":"new","complete":true}"#,
        );
        let leftovers = fs::read_dir(&data_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".state.json.kv-write-")
            })
            .count();
        assert_eq!(leftovers, 0);
        let _ = fs::remove_dir_all(data_dir);
    }

    fn build_test_zip(entries: &[(&str, Option<&[u8]>)]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(cursor);
        let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, payload) in entries {
            if let Some(bytes) = payload {
                writer.start_file(*name, options).unwrap();
                writer.write_all(bytes).unwrap();
            } else {
                writer.add_directory(*name, options).unwrap();
            }
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn read_plugin_zip_uses_sillytavern_js_entry_when_main_is_missing() {
        let zip_bytes = build_test_zip(&[
            (
                "JS-Slash-Runner-main/manifest.json",
                Some(br#"{"display_name":"Slash Runner","js":"dist/index.js","version":"4.6.4"}"#),
            ),
            (
                "JS-Slash-Runner-main/dist/index.js",
                Some(b"console.log('slash runner');"),
            ),
        ]);

        let result = read_plugin_zip_bytes(zip_bytes).unwrap();

        assert_eq!(
            result.get("mainPath").and_then(|value| value.as_str()),
            Some("JS-Slash-Runner-main/dist/index.js")
        );
        assert_eq!(
            result.get("mainText").and_then(|value| value.as_str()),
            Some("console.log('slash runner');")
        );
    }

    #[test]
    fn protected_session_ids_include_sessions_from_non_deleted_scopes() {
        let data_dir = unique_temp_data_dir("protected-sessions");
        let chat_v2_base = data_dir.join("chat_store_v2");
        fs::create_dir_all(&chat_v2_base).unwrap();

        write_json(
            &data_dir.join("contacts_store_v1__persona_deleted.json"),
            serde_json::json!({
                "contacts": {
                    "own": { "id": "rp:persona_deleted" },
                    "foreign": { "id": "rp:persona_keep" }
                }
            }),
        );
        write_json(
            &data_dir.join("contacts_store_v1__persona_keep.json"),
            serde_json::json!({
                "contacts": {
                    "self": { "id": "rp:persona_keep" }
                }
            }),
        );

        let mut scopes_to_delete = HashSet::new();
        scopes_to_delete.insert("persona_deleted".to_string());
        let protected = collect_protected_session_ids(&data_dir, &chat_v2_base, &scopes_to_delete);

        assert!(protected.contains("rp:persona_keep"));
        assert!(!protected.contains("rp:persona_deleted"));
        let _ = fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn persona_cleanup_selects_only_explicit_unretained_scopes() {
        let keep = HashSet::from(["persona_keep".to_string()]);
        let delete = HashSet::from(["persona_target".to_string(), "persona_keep".to_string()]);

        assert_eq!(
            select_explicit_persona_scopes(&keep, delete),
            vec!["persona_target".to_string()],
        );
    }

    #[test]
    fn session_asset_segment_is_collision_resistant_and_ascii_stable() {
        assert_eq!(
            sanitize_session_asset_segment("session-safe_123"),
            "session-safe_123"
        );
        assert_ne!(
            sanitize_session_asset_segment("比企谷八幡"),
            sanitize_session_asset_segment("雪之下雪乃")
        );
        assert_ne!(
            sanitize_session_asset_segment("group:shared"),
            sanitize_session_asset_segment("group?shared")
        );
        assert!(sanitize_session_asset_segment(&"会".repeat(120)).len() <= 80);
    }

    #[test]
    fn deleting_unicode_scope_does_not_remove_retained_legacy_sidecars() {
        let data_dir = unique_temp_data_dir("unicode-sidecar-protection");
        let legacy_shared = sanitize_segment("旧测试聊天室");
        let deleted_current = sanitize_session_asset_segment("旧测试聊天室");
        let retained_current = sanitize_session_asset_segment("比企谷八幡");
        assert_eq!(legacy_shared, sanitize_segment("比企谷八幡"));
        assert_ne!(deleted_current, retained_current);
        for base in ["attachments", "raw_replies", "wallpapers"] {
            let legacy_dir = data_dir.join(base).join(&legacy_shared);
            fs::create_dir_all(&legacy_dir).unwrap();
            fs::write(legacy_dir.join("retained-legacy.dat"), b"keep").unwrap();
            let retained_dir = data_dir.join(base).join(&retained_current);
            fs::create_dir_all(&retained_dir).unwrap();
            fs::write(retained_dir.join("retained-current.dat"), b"keep").unwrap();
            let deleted_dir = data_dir.join(base).join(&deleted_current);
            fs::create_dir_all(&deleted_dir).unwrap();
            fs::write(deleted_dir.join("deleted-current.dat"), b"delete").unwrap();
        }

        let mut session_ids = HashSet::new();
        session_ids.insert("旧测试聊天室".to_string());
        let mut protected = HashSet::new();
        protected.insert("比企谷八幡".to_string());
        let mut deleted_paths = Vec::new();

        delete_unprotected_session_sidecars(&data_dir, session_ids, &protected, &mut deleted_paths)
            .unwrap();

        for base in ["attachments", "raw_replies", "wallpapers"] {
            assert!(data_dir
                .join(base)
                .join(&legacy_shared)
                .join("retained-legacy.dat")
                .exists());
            assert!(data_dir
                .join(base)
                .join(&retained_current)
                .join("retained-current.dat")
                .exists());
            assert!(!data_dir.join(base).join(&deleted_current).exists());
        }
        assert_eq!(deleted_paths.len(), 3);
        let _ = fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn delete_unprotected_session_sidecars_preserves_protected_session_assets() {
        let data_dir = unique_temp_data_dir("sidecar-delete");
        let keep_safe = sanitize_segment("rp:persona_keep");
        let delete_safe = sanitize_segment("rp:persona_deleted");
        for base in ["attachments", "raw_replies", "wallpapers"] {
            fs::create_dir_all(data_dir.join(base).join(&keep_safe)).unwrap();
            fs::create_dir_all(data_dir.join(base).join(&delete_safe)).unwrap();
        }

        let mut session_ids = HashSet::new();
        session_ids.insert("rp:persona_keep".to_string());
        session_ids.insert("rp:persona_deleted".to_string());
        let mut protected = HashSet::new();
        protected.insert("rp:persona_keep".to_string());
        let mut deleted_paths = Vec::new();

        delete_unprotected_session_sidecars(&data_dir, session_ids, &protected, &mut deleted_paths)
            .unwrap();

        assert!(data_dir.join("attachments").join(&keep_safe).exists());
        assert!(data_dir.join("raw_replies").join(&keep_safe).exists());
        assert!(data_dir.join("wallpapers").join(&keep_safe).exists());
        assert!(!data_dir.join("attachments").join(&delete_safe).exists());
        assert!(!data_dir.join("raw_replies").join(&delete_safe).exists());
        assert!(!data_dir.join("wallpapers").join(&delete_safe).exists());
        assert_eq!(deleted_paths.len(), 3);
        let _ = fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn sanitize_zip_entry_name_removes_traversal_and_windows_unsafe_chars() {
        assert_eq!(
            sanitize_zip_entry_name(r#" ../folder\bad:name?.json "#),
            "folder/bad_name_.json"
        );
        assert_eq!(sanitize_zip_entry_name("../.."), "entry");
        assert_eq!(sanitize_zip_entry_name(".../   /ok.txt"), "entry/ok.txt");
    }

    #[test]
    fn world_info_file_lifecycle_is_idempotent_and_lists_only_direct_json_files() {
        let data_dir = unique_temp_data_dir("world-info-lifecycle");
        let world_dir = data_dir.join("worldinfo");
        write_json(
            &world_dir.join("世界书-A.json"),
            serde_json::json!({ "name": "世界书-A", "entries": [] }),
        );
        fs::write(world_dir.join("notes.txt"), b"not a worldbook").unwrap();
        write_json(
            &world_dir.join("nested").join("hidden.json"),
            serde_json::json!({ "name": "hidden" }),
        );

        assert!(world_info_file_path(&data_dir, "世界书-A")
            .unwrap()
            .exists());
        assert_eq!(
            list_world_info_file_ids(&data_dir).unwrap(),
            vec!["世界书-A".to_string()]
        );
        assert!(delete_world_info_file(&data_dir, "世界书-A").unwrap());
        assert!(!delete_world_info_file(&data_dir, "世界书-A").unwrap());
        assert!(list_world_info_file_ids(&data_dir).unwrap().is_empty());
        assert!(world_info_file_path(&data_dir, "../outside").is_err());
        assert!(world_info_file_path(&data_dir, r"nested\hidden").is_err());

        let _ = fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn read_zip_entry_payloads_reads_real_zip_bytes_and_normalizes_contract() {
        let zip_bytes = build_test_zip(&[
            ("folder/", None),
            (
                "manifest.json",
                Some(br#"{"format":"chatapp.custom-bundle.v1"}"#),
            ),
            (r"nested\notes.md", Some("中文 notes".as_bytes())),
            ("assets/avatar.png", Some(&[0, 1, 2, 255])),
        ]);

        let entries = read_zip_entry_payloads(Cursor::new(zip_bytes)).unwrap();

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, "manifest.json");
        assert!(entries[0].is_text);
        assert_eq!(
            entries[0].text.as_deref(),
            Some(r#"{"format":"chatapp.custom-bundle.v1"}"#)
        );
        assert!(entries[0].base64.is_none());

        assert_eq!(entries[1].name, "nested/notes.md");
        assert!(entries[1].is_text);
        assert_eq!(entries[1].text.as_deref(), Some("中文 notes"));

        assert_eq!(entries[2].name, "assets/avatar.png");
        assert!(!entries[2].is_text);
        assert_eq!(entries[2].size, 4);
        let expected_avatar = BASE64_ENGINE.encode([0, 1, 2, 255]);
        assert_eq!(entries[2].base64.as_deref(), Some(expected_avatar.as_str()));
    }

    #[test]
    fn read_zip_entry_payloads_keeps_invalid_utf8_text_extensions_as_base64() {
        let zip_bytes = build_test_zip(&[("broken.json", Some(&[0xff, 0xfe, 0xfd]))]);
        let entries = read_zip_entry_payloads(Cursor::new(zip_bytes)).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "broken.json");
        assert!(!entries[0].is_text);
        assert!(entries[0].text.is_none());
        let expected_broken = BASE64_ENGINE.encode([0xff, 0xfe, 0xfd]);
        assert_eq!(entries[0].base64.as_deref(), Some(expected_broken.as_str()));
    }
}
