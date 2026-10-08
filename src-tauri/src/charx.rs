// .charx（CCv3 角色卡 ZIP 容器）安全读取：只读出根目录 card.json 与头像（icon）资源，其余资源只列清单。
// 写入前先检查整个压缩包：加密、绝对路径／..／盘符／反斜杠、软链接、大小写重复路径、条目数与声明解压总量。
use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine;
use crate::commands::{get_data_dir, sanitize_segment};
use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Read, Write};
use tauri::AppHandle;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const CHARX_MAX_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
const CHARX_MAX_ENTRIES: usize = 1000;
const CHARX_MAX_DECLARED_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
const CHARX_MAX_CARD_JSON_BYTES: u64 = 8 * 1024 * 1024;
const CHARX_MAX_ICON_BYTES: u64 = 16 * 1024 * 1024;
const CHARX_MAX_ASSETS: usize = 300;
const CHARX_MAX_ASSET_BYTES: u64 = 8 * 1024 * 1024;
const CHARX_MAX_ASSETS_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const S_IFMT: u32 = 0o170000;
const S_IFLNK: u32 = 0o120000;

fn is_unsafe_entry_path(name: &str) -> bool {
    if name.is_empty() || name.contains('\\') || name.starts_with('/') {
        return true;
    }
    let first = name.split('/').next().unwrap_or("");
    if first.contains(':') {
        return true;
    }
    name.split('/').any(|part| part == "..")
}

// embeded://（规范）、embedded:// 与 __asset: 变体都解析成 ZIP 内的相对路径
fn resolve_embedded_uri(uri: &str) -> Option<String> {
    let trimmed = uri.trim();
    let rest = trimmed
        .strip_prefix("embeded://")
        .or_else(|| trimmed.strip_prefix("embedded://"))
        .or_else(|| trimmed.strip_prefix("__asset:"))?;
    let path = rest.trim_start_matches('/').to_string();
    if path.is_empty() || is_unsafe_entry_path(&path) {
        return None;
    }
    Some(path)
}

fn icon_mime(path: &str) -> Option<&'static str> {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        Some("image/png")
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if lower.ends_with(".webp") {
        Some("image/webp")
    } else if lower.ends_with(".gif") {
        Some("image/gif")
    } else if lower.ends_with(".avif") {
        Some("image/avif")
    } else if lower.ends_with(".apng") {
        Some("image/apng")
    } else if lower.ends_with(".bmp") {
        Some("image/bmp")
    } else {
        None
    }
}

// 头像：assets 中 type=icon 的资源，优先 name=main
fn pick_icon_uri(card: &serde_json::Value) -> Option<String> {
    let assets = card.get("data")?.get("assets")?.as_array()?;
    let icons: Vec<&serde_json::Value> = assets
        .iter()
        .filter(|asset| asset.get("type").and_then(|v| v.as_str()) == Some("icon"))
        .collect();
    let chosen = icons
        .iter()
        .find(|asset| asset.get("name").and_then(|v| v.as_str()) == Some("main"))
        .or_else(|| icons.first())?;
    chosen.get("uri").and_then(|v| v.as_str()).map(|v| v.to_string())
}

fn read_limited<R: Read>(reader: R, limit: u64, label: &str) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    reader
        .take(limit + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.len() as u64 > limit {
        return Err(format!("charx_entry_too_large:{label}"));
    }
    Ok(buf)
}

// asset_paths：额外读取的图片资源（包内相对路径）；只返回存在的图片，超出数量／体积上限即停止
pub fn read_charx_bytes(bytes: &[u8], asset_paths: &[String]) -> Result<serde_json::Value, String> {
    if bytes.is_empty() {
        return Err("charx_empty".to_string());
    }
    if bytes.len() > CHARX_MAX_ARCHIVE_BYTES {
        return Err("charx_too_large".to_string());
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("charx_invalid_zip:{e}"))?;
    if archive.len() > CHARX_MAX_ENTRIES {
        return Err("charx_too_many_entries".to_string());
    }

    let mut entries: Vec<serde_json::Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut declared_total: u64 = 0;
    for index in 0..archive.len() {
        // zip 0.6 打开加密条目会报 UnsupportedArchive("Password required ...")
        let file = match archive.by_index(index) {
            Ok(file) => file,
            Err(zip::result::ZipError::UnsupportedArchive(message)) if message.contains("Password") => {
                return Err("charx_encrypted".to_string());
            }
            Err(e) => return Err(format!("charx_invalid_zip:{e}")),
        };
        let name = file.name().to_string();
        if is_unsafe_entry_path(&name) || file.enclosed_name().is_none() {
            return Err(format!("charx_unsafe_path:{name}"));
        }
        if let Some(mode) = file.unix_mode() {
            if mode & S_IFMT == S_IFLNK {
                return Err(format!("charx_symlink:{name}"));
            }
        }
        if !seen.insert(name.to_lowercase()) {
            return Err(format!("charx_duplicate_path:{name}"));
        }
        declared_total = declared_total.saturating_add(file.size());
        if declared_total > CHARX_MAX_DECLARED_TOTAL_BYTES {
            return Err("charx_too_large".to_string());
        }
        if !file.is_dir() {
            entries.push(serde_json::json!({ "path": name, "size": file.size() }));
        }
    }

    let card_text = {
        let file = archive
            .by_name("card.json")
            .map_err(|_| "charx_missing_card_json".to_string())?;
        if file.size() > CHARX_MAX_CARD_JSON_BYTES {
            return Err("charx_entry_too_large:card.json".to_string());
        }
        let buf = read_limited(file, CHARX_MAX_CARD_JSON_BYTES, "card.json")?;
        String::from_utf8(buf).map_err(|_| "charx_card_json_not_utf8".to_string())?
    };
    let card: serde_json::Value =
        serde_json::from_str(card_text.trim_start_matches('\u{feff}')).map_err(|e| format!("charx_card_json_invalid:{e}"))?;

    let mut icon = serde_json::Value::Null;
    if let Some(path) = pick_icon_uri(&card).and_then(|uri| resolve_embedded_uri(&uri)) {
        if let (Some(mime), Ok(file)) = (icon_mime(&path), archive.by_name(&path)) {
            if file.size() <= CHARX_MAX_ICON_BYTES {
                let buf = read_limited(file, CHARX_MAX_ICON_BYTES, &path)?;
                icon = serde_json::json!({ "path": path, "mime": mime, "base64": BASE64_ENGINE.encode(&buf) });
            }
        }
    }

    let mut assets: Vec<serde_json::Value> = Vec::new();
    let mut assets_total: u64 = 0;
    let mut wanted: HashSet<String> = HashSet::new();
    for raw in asset_paths {
        let path = raw.trim().trim_start_matches('/').to_string();
        if path.is_empty() || is_unsafe_entry_path(&path) || !wanted.insert(path.clone()) {
            continue;
        }
        if assets.len() >= CHARX_MAX_ASSETS {
            return Err("charx_too_many_entries".to_string());
        }
        let mime = match icon_mime(&path) {
            Some(mime) => mime,
            None => continue,
        };
        let file = match archive.by_name(&path) {
            Ok(file) => file,
            Err(_) => continue,
        };
        if file.size() > CHARX_MAX_ASSET_BYTES {
            return Err(format!("charx_entry_too_large:{path}"));
        }
        let buf = read_limited(file, CHARX_MAX_ASSET_BYTES, &path)?;
        assets_total = assets_total.saturating_add(buf.len() as u64);
        if assets_total > CHARX_MAX_ASSETS_TOTAL_BYTES {
            return Err("charx_too_large".to_string());
        }
        assets.push(serde_json::json!({ "path": path, "mime": mime, "base64": BASE64_ENGINE.encode(&buf) }));
    }

    Ok(serde_json::json!({
        "cardText": card_text,
        "entries": entries,
        "icon": icon,
        "assets": assets,
    }))
}

#[tauri::command]
pub async fn read_charx(bytes: Vec<u8>, asset_paths: Option<Vec<String>>) -> Result<serde_json::Value, String> {
    read_charx_bytes(&bytes, &asset_paths.unwrap_or_default())
}

// 从 .charx 导入的角色卡：另存原始包，导出 .charx 时用来写回其余资源
#[tauri::command]
pub async fn save_persona_charx(app: AppHandle, id: String, bytes: Vec<u8>) -> Result<serde_json::Value, String> {
    if bytes.len() > CHARX_MAX_ARCHIVE_BYTES {
        return Err("charx_too_large".to_string());
    }
    read_charx_bytes(&bytes, &[])?;
    let card_dir = get_data_dir(&app)?.join("persona_cards");
    fs::create_dir_all(&card_dir).map_err(|e| e.to_string())?;
    let file = card_dir.join(format!("{}.charx", sanitize_segment(&id)));
    fs::write(&file, &bytes).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "path": file.to_string_lossy().to_string(), "bytes": bytes.len() }))
}

// 生成 .charx：根目录 card.json + 头像；有原始包时把其余条目原样拷回（跳过旧 card.json、新头像路径与 skip_paths）
pub fn build_charx_bytes(
    card_text: &str,
    icon: Option<(&str, &[u8])>,
    source: Option<&[u8]>,
    skip_paths: &[String],
) -> Result<Vec<u8>, String> {
    let card: serde_json::Value =
        serde_json::from_str(card_text).map_err(|e| format!("charx_card_json_invalid:{e}"))?;
    if card.get("spec").and_then(|v| v.as_str()) != Some("chara_card_v3") {
        return Err("charx_card_json_invalid:spec must be chara_card_v3".to_string());
    }
    let mut skip: HashSet<String> = skip_paths.iter().map(|p| p.trim_start_matches('/').to_string()).collect();
    skip.insert("card.json".to_string());
    if let Some((path, _)) = icon {
        if is_unsafe_entry_path(path) {
            return Err(format!("charx_unsafe_path:{path}"));
        }
        skip.insert(path.to_string());
    }
    let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut cursor);
        writer.start_file("card.json", options).map_err(|e| e.to_string())?;
        writer.write_all(card_text.as_bytes()).map_err(|e| e.to_string())?;
        if let Some((path, data)) = icon {
            writer.start_file(path, options).map_err(|e| e.to_string())?;
            writer.write_all(data).map_err(|e| e.to_string())?;
        }
        if let Some(source_bytes) = source {
            read_charx_bytes(source_bytes, &[])?;
            let mut archive = ZipArchive::new(Cursor::new(source_bytes)).map_err(|e| format!("charx_invalid_zip:{e}"))?;
            for index in 0..archive.len() {
                let file = archive.by_index(index).map_err(|e| format!("charx_invalid_zip:{e}"))?;
                let name = file.name().to_string();
                if file.is_dir() || skip.contains(&name) {
                    continue;
                }
                let data = read_limited(file, CHARX_MAX_ASSET_BYTES.max(CHARX_MAX_ICON_BYTES), &name)?;
                writer.start_file(name.as_str(), options).map_err(|e| e.to_string())?;
                writer.write_all(&data).map_err(|e| e.to_string())?;
            }
        }
        writer.finish().map_err(|e| e.to_string())?;
    }
    let bytes = cursor.into_inner();
    if bytes.len() > CHARX_MAX_ARCHIVE_BYTES {
        return Err("charx_too_large".to_string());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn export_charx(
    app: AppHandle,
    card_text: String,
    icon_path: Option<String>,
    icon_base64: Option<String>,
    persona_id: Option<String>,
    skip_paths: Option<Vec<String>>,
) -> Result<String, String> {
    let icon_bytes = match &icon_base64 {
        Some(b64) => Some(BASE64_ENGINE.decode(b64.as_bytes()).map_err(|e| e.to_string())?),
        None => None,
    };
    let icon = match (&icon_path, &icon_bytes) {
        (Some(path), Some(data)) => Some((path.as_str(), data.as_slice())),
        _ => None,
    };
    let source = match persona_id.as_deref().map(sanitize_segment) {
        Some(id) if !id.is_empty() => {
            let file = get_data_dir(&app)?.join("persona_cards").join(format!("{id}.charx"));
            if file.exists() { Some(fs::read(&file).map_err(|e| e.to_string())?) } else { None }
        }
        _ => None,
    };
    let bytes = build_charx_bytes(&card_text, icon, source.as_deref(), &skip_paths.unwrap_or_default())?;
    Ok(BASE64_ENGINE.encode(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::FileOptions;

    fn build_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            for (name, data) in files {
                writer.start_file(*name, FileOptions::default()).unwrap();
                writer.write_all(data).unwrap();
            }
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    const CARD: &str = r#"{"spec":"chara_card_v3","spec_version":"3.0","data":{"name":"测试","assets":[{"type":"icon","uri":"embeded://assets/icon/main.png","name":"main","ext":"png"},{"type":"emotion","uri":"embeded://assets/emotion/joy.png","name":"joy","ext":"png"}]}}"#;

    #[test]
    fn reads_card_json_and_main_icon() {
        let zip = build_zip(&[
            ("card.json", CARD.as_bytes()),
            ("assets/icon/main.png", b"PNGDATA"),
            ("assets/emotion/joy.png", b"JOY"),
        ]);
        let result = read_charx_bytes(&zip, &[]).unwrap();
        assert!(result["cardText"].as_str().unwrap().contains("chara_card_v3"));
        assert_eq!(result["icon"]["path"], "assets/icon/main.png");
        assert_eq!(result["icon"]["mime"], "image/png");
        assert_eq!(result["icon"]["base64"], BASE64_ENGINE.encode(b"PNGDATA"));
        assert_eq!(result["entries"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn accepts_embedded_uri_variants() {
        assert_eq!(resolve_embedded_uri("embedded://assets/a.png").as_deref(), Some("assets/a.png"));
        assert_eq!(resolve_embedded_uri("__asset:/assets/a.png").as_deref(), Some("assets/a.png"));
        assert_eq!(resolve_embedded_uri("https://example.com/a.png"), None);
        assert_eq!(resolve_embedded_uri("embeded://../secret"), None);
    }

    #[test]
    fn rejects_missing_card_json_and_unsafe_or_duplicate_paths() {
        assert_eq!(read_charx_bytes(&build_zip(&[("other.json", b"{}")]), &[]).unwrap_err(), "charx_missing_card_json");
        assert!(read_charx_bytes(&build_zip(&[("card.json", CARD.as_bytes()), ("../evil.png", b"x")]), &[])
            .unwrap_err()
            .starts_with("charx_unsafe_path"));
        assert!(read_charx_bytes(&build_zip(&[("card.json", CARD.as_bytes()), ("C:/evil.png", b"x")]), &[])
            .unwrap_err()
            .starts_with("charx_unsafe_path"));
        assert!(read_charx_bytes(&build_zip(&[("card.json", CARD.as_bytes()), ("Card.JSON", b"{}")]), &[])
            .unwrap_err()
            .starts_with("charx_duplicate_path"));
        assert_eq!(read_charx_bytes(b"not a zip", &[]).unwrap_err().split(':').next(), Some("charx_invalid_zip"));
    }

    #[test]
    fn rejects_invalid_card_json() {
        assert!(read_charx_bytes(&build_zip(&[("card.json", b"{oops")]), &[])
            .unwrap_err()
            .starts_with("charx_card_json_invalid"));
    }

    #[test]
    fn reads_requested_image_assets_only() {
        let zip = build_zip(&[
            ("card.json", CARD.as_bytes()),
            ("assets/icon/main.png", b"PNGDATA"),
            ("assets/emotion/joy.png", b"JOY"),
            ("assets/other/readme.txt", b"TXT"),
        ]);
        let wanted = vec!["assets/emotion/joy.png".to_string(), "assets/other/readme.txt".to_string(), "missing.png".to_string(), "../x.png".to_string()];
        let result = read_charx_bytes(&zip, &wanted).unwrap();
        let assets = result["assets"].as_array().unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0]["path"], "assets/emotion/joy.png");
        assert_eq!(assets[0]["base64"], BASE64_ENGINE.encode(b"JOY"));
    }

    #[test]
    fn writes_charx_with_new_icon_and_original_assets() {
        let source = build_zip(&[
            ("card.json", CARD.as_bytes()),
            ("assets/icon/main.png", b"OLDICON"),
            ("assets/emotion/joy.png", b"JOY"),
        ]);
        let bytes = build_charx_bytes(CARD, Some(("assets/icon/main.png", b"NEWICON")), Some(&source), &[]).unwrap();
        let result = read_charx_bytes(&bytes, &["assets/emotion/joy.png".to_string()]).unwrap();
        assert_eq!(result["icon"]["base64"], BASE64_ENGINE.encode(b"NEWICON"), "the current avatar replaces the old icon");
        assert_eq!(result["assets"][0]["base64"], BASE64_ENGINE.encode(b"JOY"), "other original assets are kept");
        assert_eq!(result["entries"].as_array().unwrap().len(), 3);
        assert!(build_charx_bytes(r#"{"spec":"chara_card_v2","data":{}}"#, None, None, &[]).unwrap_err().starts_with("charx_card_json_invalid"));
    }
}
