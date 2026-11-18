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

// 女仆「地图」能力：只放行 Google 地图的搜索／路线与高德的搜索网址；地点名都在查询参数里（前端已编码），
// 网址规范化后必须与原样一致，不带账号、端口与片段。
fn is_allowed_map_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.as_str() != url
        || parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.fragment().is_some()
        || parsed.query().map_or(true, str::is_empty)
    {
        return false;
    }
    matches!(
        (parsed.host_str(), parsed.path()),
        (Some("www.google.com"), "/maps/search/" | "/maps/dir/") | (Some("uri.amap.com"), "/search")
    )
}

fn is_allowed_external_url(url: &str) -> bool {
    ALLOWED_EXTERNAL_URLS.contains(&url) || is_allowed_release_url(url) || is_allowed_map_url(url)
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
    fn allows_only_map_search_and_route_links() {
        assert!(is_allowed_external_url(
            "https://www.google.com/maps/search/?api=1&query=%E5%8F%B0%E5%8C%97%20101"
        ));
        assert!(is_allowed_external_url(
            "https://www.google.com/maps/dir/?api=1&destination=Macy%27s&travelmode=walking"
        ));
        assert!(is_allowed_external_url(
            "https://uri.amap.com/search?keyword=%E6%95%85%E5%AE%AB&view=map&src=omnitavern&callnative=1"
        ));
        for url in [
            "https://www.google.com/maps/search/",
            "https://www.google.com/maps/search/?",
            "http://www.google.com/maps/search/?api=1&query=x",
            "https://www.google.com/maps/place/?api=1&query=x",
            "https://www.google.com/search?q=x",
            "https://maps.google.com/maps/search/?api=1&query=x",
            "https://www.google.com.evil.com/maps/search/?api=1&query=x",
            "https://user@www.google.com/maps/search/?api=1&query=x",
            "https://www.google.com:8443/maps/search/?api=1&query=x",
            "https://www.google.com/maps/search/?api=1&query=x#frag",
            "https://www.google.com/maps/search/../../url?q=x",
            "https://www.google.com/maps/search/?api=1&query=it's",
            "https://uri.amap.com/navigation?to=1,2",
            "https://amap.com/search?keyword=x",
        ] {
            assert!(!is_allowed_external_url(url), "{url}");
        }
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
