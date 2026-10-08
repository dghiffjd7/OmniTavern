use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

const ALLOWED_EXTERNAL_URLS: [&str; 2] = [
    "https://ko-fi.com/illusion7",
    "https://github.com/dghiffjd7/OmniTavern",
];

// 应用更新：发布页与安装包下载都在本项目 releases 路径下（Android 交给系统浏览器下载 APK）
const RELEASES_URL_PREFIX: &str = "https://github.com/dghiffjd7/OmniTavern/releases/";

fn is_allowed_release_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix(RELEASES_URL_PREFIX) else {
        return false;
    };
    if rest.is_empty()
        || rest.contains("..")
        || !rest
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "/-_.%+".contains(ch))
    {
        return false;
    }
    // 浏览器会在打开前消除 %2e%2e 等点路径；白名单必须同时匹配规范化后的地址。
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.as_str() != url || !parsed.as_str().starts_with(RELEASES_URL_PREFIX) {
        return false;
    }
    // 保留合法编码的文件名，但拒绝编码分隔符及二次解码产生路径的 %25。
    let mut bytes = rest.bytes();
    while let Some(byte) = bytes.next() {
        if byte != b'%' {
            continue;
        }
        let high = bytes.next().and_then(|b| (b as char).to_digit(16));
        let low = bytes.next().and_then(|b| (b as char).to_digit(16));
        let (Some(high), Some(low)) = (high, low) else {
            return false;
        };
        let decoded = (high * 16 + low) as u8;
        if decoded.is_ascii_control() || matches!(decoded, b'/' | b'\\' | b'%') {
            return false;
        }
    }
    true
}

fn is_allowed_external_url(url: &str) -> bool {
    ALLOWED_EXTERNAL_URLS.contains(&url) || is_allowed_release_url(url)
}

#[tauri::command]
pub fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let normalized_url = url.trim();
    if !is_allowed_external_url(normalized_url) {
        return Err("external_url_not_allowed".to_string());
    }

    app.opener()
        .open_url(normalized_url, None::<&str>)
        .map_err(|error| format!("failed_to_open_external_url:{error}"))
}

#[cfg(test)]
mod tests {
    use super::is_allowed_external_url;

    #[test]
    fn allows_only_the_developer_kofi_and_project_pages() {
        assert!(is_allowed_external_url("https://ko-fi.com/illusion7"));
        assert!(is_allowed_external_url(
            "https://github.com/dghiffjd7/OmniTavern"
        ));
        assert!(!is_allowed_external_url("https://github.com/dghiffjd7"));
        assert!(!is_allowed_external_url("http://ko-fi.com/illusion7"));
        assert!(!is_allowed_external_url(
            "https://github.com/dghiffjd7/OmniTavern/issues"
        ));
        assert!(!is_allowed_external_url("https://example.com/dghiffjd7"));
    }

    #[test]
    fn allows_project_release_pages_and_downloads_only() {
        assert!(is_allowed_external_url(
            "https://github.com/dghiffjd7/OmniTavern/releases/tag/v0.7.4"
        ));
        assert!(is_allowed_external_url(
            "https://github.com/dghiffjd7/OmniTavern/releases/download/v0.7.4/OmniTavern_0.7.4.apk"
        ));
        assert!(!is_allowed_external_url(
            "https://github.com/dghiffjd7/OmniTavern/releases/"
        ));
        assert!(!is_allowed_external_url(
            "https://github.com/dghiffjd7/OmniTavern/releases/../../other/repo"
        ));
        assert!(!is_allowed_external_url(
            "https://github.com/dghiffjd7/OmniTavern/releases/tag/v1?x=<script>"
        ));
        assert!(!is_allowed_external_url(
            "https://github.com/dghiffjd7/OmniTavernX/releases/tag/v1"
        ));
    }

    #[test]
    fn release_paths_reject_encoded_traversal_and_keep_encoded_filenames() {
        for suffix in [
            "%2e%2e/%2e%2e/%2e%2e/untrusted/repo/releases/download/v1/setup.exe",
            "%2E./outside",
            ".%2e/outside",
            "%252e%252e/outside",
            "download/v1/%2fother",
            "download/v1/%5cother",
            "download/v1/file%00.exe",
            "download/v1/file%GG.exe",
            "download/v1/file%2",
        ] {
            assert!(
                !is_allowed_external_url(&format!("{}{suffix}", super::RELEASES_URL_PREFIX)),
                "must reject {suffix}"
            );
        }
        assert!(is_allowed_external_url(
            "https://github.com/dghiffjd7/OmniTavern/releases/latest"
        ));
        assert!(is_allowed_external_url(
            "https://github.com/dghiffjd7/OmniTavern/releases/download/v1/%E4%B8%AD%E6%96%87%20setup.exe"
        ));
    }
}
