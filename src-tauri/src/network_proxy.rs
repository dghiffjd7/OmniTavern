// 网络代理设置（通用设置 → 网络 → 网络代理），三档：
// - system：跟随系统代理。reqwest 先看 HTTPS_PROXY／HTTP_PROXY／ALL_PROXY 环境变量，没有再读 Windows 的系统代理。
// - direct：不用代理，全部直连。
// - custom：用户填的 http(s):// 或 socks5(h):// 地址。
// 本机和局域网地址（Ollama、ComfyUI 等）三档都直连。
// 前端启动和修改设置时调用 set_network_proxy；建 reqwest 客户端的地方经 apply_network_proxy 套用。
// 实时语音的 WebSocket 和 Bedrock 不经 reqwest，不受这个设置影响。
use std::net::IpAddr;
use std::sync::RwLock;

#[derive(Clone, Debug)]
enum NetworkProxy {
    System,
    Direct,
    Custom(reqwest::Proxy),
}

static CURRENT: RwLock<NetworkProxy> = RwLock::new(NetworkProxy::System);

#[tauri::command]
pub fn set_network_proxy(mode: String, url: Option<String>) -> Result<(), String> {
    let next = parse_network_proxy(&mode, url.as_deref())?;
    *CURRENT.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = next;
    Ok(())
}

/// `target` 是这次要请求的地址；为 None 时视为外网地址（如自动更新）。
pub fn apply_network_proxy(
    builder: reqwest::ClientBuilder,
    target: Option<&str>,
) -> reqwest::ClientBuilder {
    let mode = CURRENT
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    apply_proxy_mode(builder, &mode, target)
}

fn apply_proxy_mode(
    builder: reqwest::ClientBuilder,
    mode: &NetworkProxy,
    target: Option<&str>,
) -> reqwest::ClientBuilder {
    if target.is_some_and(is_local_target) {
        return builder.no_proxy();
    }
    match mode {
        NetworkProxy::System => builder,
        NetworkProxy::Direct => builder.no_proxy(),
        NetworkProxy::Custom(proxy) => builder.proxy(proxy.clone()),
    }
}

fn parse_network_proxy(mode: &str, url: Option<&str>) -> Result<NetworkProxy, String> {
    match mode.trim() {
        "system" => Ok(NetworkProxy::System),
        "direct" => Ok(NetworkProxy::Direct),
        "custom" => {
            let address = normalize_proxy_url(url.unwrap_or(""))?;
            reqwest::Proxy::all(address.as_str())
                .map(NetworkProxy::Custom)
                .map_err(|error| format!("invalid proxy address: {error}"))
        }
        other => Err(format!("unknown proxy mode: {other}")),
    }
}

/// 没写协议的当作 http://（代理工具里抄来的常是 127.0.0.1:7890）。
fn normalize_proxy_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("proxy address is empty".into());
    }
    let address = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let parsed = reqwest::Url::parse(&address)
        .map_err(|_| format!("invalid proxy address: {raw}"))?;
    if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h") {
        return Err(format!("unsupported proxy scheme: {}", parsed.scheme()));
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err(format!("invalid proxy address: {raw}"));
    }
    Ok(address)
}

fn is_local_target(target: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(target) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(ip) => {
                ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified()
            }
            IpAddr::V6(ip) => {
                let first = ip.segments()[0];
                ip.is_loopback()
                    || ip.is_unspecified()
                    || (first & 0xfe00) == 0xfc00
                    || (first & 0xffc0) == 0xfe80
            }
        };
    }
    let name = host.trim_end_matches('.').to_ascii_lowercase();
    // 不带点的主机名只会是局域网里的机器名，与 Windows 代理设置的 <local> 相同
    name == "localhost" || name.ends_with(".localhost") || name.ends_with(".local") || !name.contains('.')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    /// 起一个只回一次固定内容的 HTTP 服务，收到的请求头送回给测试。
    fn serve_once(body: &'static str) -> (u16, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake server");
        let port = listener.local_addr().expect("fake server address").port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let Ok((mut socket, _)) = listener.accept() else {
                return;
            };
            let mut buffer = [0u8; 4096];
            let read = socket.read(&mut buffer).unwrap_or(0);
            let _ = tx.send(String::from_utf8_lossy(&buffer[..read]).to_string());
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes());
        });
        (port, rx)
    }

    fn custom_proxy(port: u16) -> NetworkProxy {
        parse_network_proxy("custom", Some(&format!("127.0.0.1:{port}"))).expect("custom proxy")
    }

    async fn fetch(builder: reqwest::ClientBuilder, url: &str) -> String {
        builder
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("build client")
            .get(url)
            .send()
            .await
            .expect("send request")
            .text()
            .await
            .expect("read body")
    }

    #[test]
    fn proxy_addresses_are_checked_and_default_to_http() {
        let ok = |url: &str| normalize_proxy_url(url).expect(url);
        assert_eq!(ok("127.0.0.1:7890"), "http://127.0.0.1:7890");
        assert_eq!(ok(" socks5://127.0.0.1:7891 "), "socks5://127.0.0.1:7891");
        assert_eq!(ok("https://proxy.example.com:443"), "https://proxy.example.com:443");
        assert!(normalize_proxy_url("").is_err());
        assert!(normalize_proxy_url("ftp://127.0.0.1:21").is_err());
        assert!(normalize_proxy_url("http://").is_err());
        assert!(parse_network_proxy("custom", None).is_err());
        assert!(parse_network_proxy("vpn", None).is_err());
        assert!(matches!(parse_network_proxy("system", None), Ok(NetworkProxy::System)));
        assert!(matches!(parse_network_proxy("direct", Some("ignored")), Ok(NetworkProxy::Direct)));
    }

    #[test]
    fn local_and_lan_addresses_count_as_local() {
        for url in [
            "http://localhost:11434/api/chat",
            "http://127.0.0.1:8188/prompt",
            "http://192.168.1.20:11434",
            "http://10.0.0.5",
            "http://172.20.1.1",
            "http://169.254.10.1",
            "http://[::1]:11434",
            "http://[fd00::1]",
            "http://nas:5000",
            "http://my-pc.local:7860",
        ] {
            assert!(is_local_target(url), "{url}");
        }
        for url in [
            "https://api.openai.com/v1/chat/completions",
            "https://odyfree.spinsnow.fun/v1",
            "http://8.8.8.8",
            "http://172.32.0.1",
            "not a url",
        ] {
            assert!(!is_local_target(url), "{url}");
        }
    }

    #[tokio::test]
    async fn custom_proxy_carries_remote_requests() {
        let (proxy_port, proxy_seen) = serve_once("via-proxy");
        let target = "http://api.example.test/v1/models";
        let builder = apply_proxy_mode(reqwest::Client::builder(), &custom_proxy(proxy_port), Some(target));
        assert_eq!(fetch(builder, target).await, "via-proxy");
        let head = proxy_seen.recv().expect("proxy saw the request");
        assert!(head.starts_with("GET http://api.example.test/v1/models "), "{head}");
    }

    #[tokio::test]
    async fn local_targets_skip_a_custom_proxy() {
        let (proxy_port, proxy_seen) = serve_once("via-proxy");
        let (local_port, _) = serve_once("direct");
        let target = format!("http://127.0.0.1:{local_port}/api/tags");
        let builder = apply_proxy_mode(reqwest::Client::builder(), &custom_proxy(proxy_port), Some(&target));
        assert_eq!(fetch(builder, &target).await, "direct");
        assert!(proxy_seen.try_recv().is_err());
    }

    #[tokio::test]
    async fn direct_mode_drops_proxies_set_earlier() {
        let (proxy_port, proxy_seen) = serve_once("via-proxy");
        let (server_port, _) = serve_once("direct");
        let server: std::net::SocketAddr = ([127, 0, 0, 1], server_port).into();
        let target = format!("http://api.example.test:{server_port}/v1/models");
        let proxied = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{proxy_port}")).expect("proxy"))
            .resolve("api.example.test", server);
        let builder = apply_proxy_mode(proxied, &NetworkProxy::Direct, Some(&target));
        assert_eq!(fetch(builder, &target).await, "direct");
        assert!(proxy_seen.try_recv().is_err());
    }
}
