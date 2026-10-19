// 女仆文件库：附件与女仆产出的原文件按 SHA-256 存在数据目录 maid_files/ 下（同内容只存一份）。
// 索引、配额与清理在 JS 端；这里只负责按哈希存取，哈希必须是 64 位小写十六进制（同时保证路径安全）。
// 数据包备份不包含这个目录（见 commands::add_dir_to_zip）。
use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine;
use crate::commands::{get_data_dir, write_file_atomically};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub(crate) const MAID_FILES_DIR_NAME: &str = "maid_files";
const MAID_FILE_MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(serde::Serialize)]
pub struct MaidFileStat {
    pub hash: String,
    pub bytes: u64,
}

fn validate_hash(hash: &str) -> Result<&str, String> {
    let value = hash.trim();
    if value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        Ok(value)
    } else {
        Err("maid_file_invalid_hash".to_string())
    }
}

fn blob_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(MAID_FILES_DIR_NAME).join("blobs")
}

fn put_blob(data_dir: &Path, hash: &str, bytes: &[u8]) -> Result<bool, String> {
    let hash = validate_hash(hash)?;
    if bytes.len() > MAID_FILE_MAX_BYTES {
        return Err("maid_file_too_large".to_string());
    }
    let file = blob_dir(data_dir).join(hash);
    if let Ok(meta) = fs::metadata(&file) {
        if meta.len() == bytes.len() as u64 {
            return Ok(true);
        }
    }
    write_file_atomically(&file, bytes)?;
    Ok(false)
}

fn get_blob(data_dir: &Path, hash: &str) -> Result<Vec<u8>, String> {
    let hash = validate_hash(hash)?;
    fs::read(blob_dir(data_dir).join(hash)).map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            "maid_file_not_found".to_string()
        } else {
            err.to_string()
        }
    })
}

fn delete_blobs(data_dir: &Path, hashes: &[String]) -> Result<usize, String> {
    let dir = blob_dir(data_dir);
    let mut removed = 0;
    for hash in hashes {
        let hash = validate_hash(hash)?;
        match fs::remove_file(dir.join(hash)) {
            Ok(()) => removed += 1,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.to_string()),
        }
    }
    Ok(removed)
}

fn list_blobs(data_dir: &Path) -> Result<Vec<MaidFileStat>, String> {
    let dir = blob_dir(data_dir);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.to_string()),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        // 只认哈希命名的文件；原子写入留下的临时文件等一律忽略
        if validate_hash(&name).is_err() {
            continue;
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if meta.is_file() {
            out.push(MaidFileStat { hash: name, bytes: meta.len() });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn maid_file_put(app: AppHandle, hash: String, base64: String) -> Result<bool, String> {
    let data_dir = get_data_dir(&app)?;
    let bytes = BASE64_ENGINE
        .decode(base64.trim())
        .map_err(|e| e.to_string())?;
    put_blob(&data_dir, &hash, &bytes)
}

#[tauri::command]
pub async fn maid_file_get(app: AppHandle, hash: String) -> Result<String, String> {
    let data_dir = get_data_dir(&app)?;
    Ok(BASE64_ENGINE.encode(get_blob(&data_dir, &hash)?))
}

#[tauri::command]
pub async fn maid_file_delete(app: AppHandle, hashes: Vec<String>) -> Result<usize, String> {
    let data_dir = get_data_dir(&app)?;
    delete_blobs(&data_dir, &hashes)
}

#[tauri::command]
pub async fn maid_file_list(app: AppHandle) -> Result<Vec<MaidFileStat>, String> {
    let data_dir = get_data_dir(&app)?;
    list_blobs(&data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("maid-files-{label}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const HASH: &str = "a3f5c1d2e4b6a7980112233445566778899aabbccddeeff00112233445566778";

    #[test]
    fn maid_file_blobs_round_trip_list_and_delete() {
        let dir = temp_dir("round-trip");
        assert_eq!(put_blob(&dir, HASH, b"hello").unwrap(), false);
        assert_eq!(put_blob(&dir, HASH, b"hello").unwrap(), true, "same content is stored once");
        assert_eq!(get_blob(&dir, HASH).unwrap(), b"hello");
        fs::write(blob_dir(&dir).join(".tmp-leftover"), b"x").unwrap();
        let listed = list_blobs(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].hash.as_str(), listed[0].bytes), (HASH, 5));
        assert_eq!(delete_blobs(&dir, &[HASH.to_string(), HASH.to_string()]).unwrap(), 1);
        assert_eq!(get_blob(&dir, HASH).err().unwrap(), "maid_file_not_found");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn maid_file_hashes_must_be_plain_lowercase_hex() {
        let dir = temp_dir("hash-guard");
        for bad in ["../../config.json", "ABCDEF", "", &HASH.to_uppercase(), &format!("{HASH}0")] {
            assert_eq!(put_blob(&dir, bad, b"x").err().unwrap(), "maid_file_invalid_hash", "{bad}");
            assert_eq!(get_blob(&dir, bad).err().unwrap(), "maid_file_invalid_hash", "{bad}");
        }
        assert!(delete_blobs(&dir, &["../x".to_string()]).is_err());
        assert_eq!(list_blobs(&dir).unwrap().len(), 0);
        let _ = fs::remove_dir_all(dir);
    }
}
