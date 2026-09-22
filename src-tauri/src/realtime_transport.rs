//! Dedicated, bounded realtime connections. Credentials never appear in emitted events.
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{ipc::Channel, State, WebviewWindow};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::{HeaderName, HeaderValue}, Message};

const FRAME_LIMIT: usize = 512 * 1024;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    kind: String,
    data: String,
}
fn frame(kind: &str, data: impl Into<String>) -> Frame {
    Frame {
        kind: kind.into(),
        data: data.into(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    app_id: String,
    #[serde(default)]
    access_key_id: String,
    #[serde(default)]
    secret_access_key: String,
    #[serde(default)]
    session_token: String,
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    extra_headers: HashMap<String, String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    provider: String,
    model: String,
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    custom_protocol: String,
    #[serde(default)]
    auth_mode: String,
    #[serde(default)]
    auth_header: String,
    #[serde(default)]
    region: String,
    #[serde(default)]
    workspace_id: String,
    #[serde(default)]
    gemini_backend: String,
    #[serde(default)]
    vertexai_auth_mode: String,
    credentials: Credentials,
}
#[derive(Deserialize)]
pub struct Outgoing {
    kind: String,
    data: String,
}
struct Session {
    sender: mpsc::Sender<Outgoing>,
    abort: tauri::async_runtime::JoinHandle<()>,
    owner: String,
}
#[derive(Clone, Default)]
pub struct RealtimeTransportState(Arc<Mutex<HashMap<String, Session>>>);

fn check_owner(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Realtime requires the main application window".into());
    }
    Ok(())
}
fn validate(input: &Connection) -> Result<(), String> {
    if input.model.is_empty()
        || input.model.len() > 200
        || input.model.chars().any(char::is_control)
    {
        return Err("Invalid realtime model".into());
    }
    match input.provider.as_str() {
        "custom" => { custom_websocket_request(input)?; }
        "gemini_live" if input.gemini_backend == "vertex" => {
            match input.vertexai_auth_mode.as_str() {
                "service_account" => {
                    if input.credentials.access_token.is_empty()
                        || input.credentials.access_token.len() > 16384
                    {
                        return Err("Missing Vertex access token".into());
                    }
                    if ![
                        "us-central1",
                        "us-east1",
                        "us-east4",
                        "us-east5",
                        "us-south1",
                        "us-west1",
                        "us-west4",
                        "europe-central2",
                        "europe-north1",
                        "europe-southwest1",
                        "europe-west1",
                        "europe-west4",
                        "europe-west8",
                    ]
                    .contains(&input.region.as_str())
                    {
                        return Err("Unsupported Vertex Live region".into());
                    }
                }
                "express" => {
                    if input.credentials.api_key.is_empty()
                        || input.credentials.api_key.len() > 4096
                    {
                        return Err("Missing Vertex Express API key".into());
                    }
                }
                _ => return Err("Invalid Vertex authentication mode".into()),
            }
        }
        "gemini_live"
        | "qwen_audio_realtime"
        | "step_realtime"
        | "xai_voice"
        | "doubao_realtime" => {
            if input.provider == "gemini_live"
                && !["", "developer"].contains(&input.gemini_backend.as_str())
            {
                return Err("Invalid Gemini backend".into());
            }
            if input.credentials.api_key.is_empty() || input.credentials.api_key.len() > 4096 {
                return Err("Missing realtime credentials".into());
            }
            if input.provider == "doubao_realtime"
                && (input.credentials.app_id.is_empty()
                    || !input.credentials.app_id.bytes().all(|c| c.is_ascii_digit()))
            {
                return Err("Invalid Doubao App ID".into());
            }
            if input.provider == "qwen_audio_realtime" {
                if !["cn-beijing", "ap-southeast-1"].contains(&input.region.as_str()) {
                    return Err("Unsupported Qwen region".into());
                }
                if !input
                    .workspace_id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
                {
                    return Err("Invalid Qwen workspace".into());
                }
            }
            if input.provider == "step_realtime"
                && !["", "cn", "global"].contains(&input.region.as_str())
            {
                return Err("Unsupported Step site".into());
            }
        }
        "nova_sonic" => {
            if !input.model.starts_with("amazon.nova") || !input.model.contains("-sonic") {
                return Err("Unsupported Nova model".into());
            }
            if !["us-east-1", "us-west-2", "ap-northeast-1"].contains(&input.region.as_str()) {
                return Err("Unsupported Nova region".into());
            }
            if input.credentials.access_key_id.is_empty()
                || input.credentials.secret_access_key.is_empty()
            {
                return Err("Missing AWS credentials".into());
            }
        }
        _ => return Err("Unsupported realtime provider".into()),
    }
    Ok(())
}
fn websocket_request(
    input: &Connection,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
    validate(input)?;
    if input.provider == "custom" { return custom_websocket_request(input); }
    let vertex = input.provider == "gemini_live" && input.gemini_backend == "vertex";
    let endpoint = match input.provider.as_str() {
        "gemini_live" if vertex => {
            let host = if input.vertexai_auth_mode == "express" { "aiplatform.googleapis.com".to_string() } else { format!("{}-aiplatform.googleapis.com", input.region) };
            format!("wss://{host}/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent")
        }
        "gemini_live" => "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent".into(),
        "step_realtime" if input.region == "global" => "wss://api.stepfun.ai/v1/realtime".into(),
        "step_realtime" => "wss://api.stepfun.com/v1/realtime".into(),
        "xai_voice" => "wss://api.x.ai/v1/realtime".into(),
        "doubao_realtime" => "wss://openspeech.bytedance.com/api/v3/realtime/dialogue".into(),
        "qwen_audio_realtime" if input.workspace_id.is_empty() => {
            if input.region == "cn-beijing" { "wss://dashscope.aliyuncs.com/api-ws/v1/realtime".into() }
            else { "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime".into() }
        }
        "qwen_audio_realtime" => format!("wss://{}.{}.maas.aliyuncs.com/api-ws/v1/realtime", input.workspace_id, input.region),
        _ => return Err("Unsupported WebSocket provider".into()),
    };
    let mut url = reqwest::Url::parse(&endpoint).map_err(|_| "Invalid realtime endpoint")?;
    if input.provider == "gemini_live" && !vertex {
        url.query_pairs_mut()
            .append_pair("key", &input.credentials.api_key);
    } else if input.provider != "doubao_realtime" && !vertex {
        url.query_pairs_mut().append_pair("model", &input.model);
    }
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "Invalid realtime request")?;
    let mut insert = |name: &'static str, value: &str| -> Result<(), String> {
        request.headers_mut().insert(
            name,
            HeaderValue::from_str(value).map_err(|_| "Invalid realtime credential format")?,
        );
        Ok(())
    };
    if vertex {
        if input.vertexai_auth_mode == "express" {
            insert("x-goog-api-key", &input.credentials.api_key)?;
        } else {
            insert(
                "authorization",
                &format!("Bearer {}", input.credentials.access_token),
            )?;
        }
    } else if input.provider == "doubao_realtime" {
        insert("x-api-app-id", &input.credentials.app_id)?;
        insert("x-api-access-key", &input.credentials.api_key)?;
        insert("x-api-resource-id", "volc.speech.dialog")?;
        insert("x-api-app-key", "PlgvMymc7f3tQnJ6")?;
    } else if input.provider != "gemini_live" {
        insert(
            "authorization",
            &format!("Bearer {}", input.credentials.api_key),
        )?;
    }
    Ok(request)
}
fn custom_header_name(value: &str) -> Result<HeaderName, String> {
    let name = HeaderName::from_bytes(value.as_bytes()).map_err(|_| "Invalid custom realtime header")?;
    if matches!(name.as_str(), "host" | "connection" | "upgrade" | "content-length" | "transfer-encoding")
        || name.as_str().starts_with("proxy-") || name.as_str().starts_with("sec-websocket-") {
        return Err("Reserved custom realtime header".into());
    }
    Ok(name)
}
fn custom_websocket_request(input: &Connection) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
    if input.custom_protocol != "openai_realtime" { return Err("Unsupported custom realtime protocol".into()); }
    let mut url = reqwest::Url::parse(&input.endpoint).map_err(|_| "Invalid custom realtime endpoint")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if input.endpoint.len() > 4096 || !(url.scheme() == "wss" || (url.scheme() == "ws" && local))
        || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("Custom realtime requires WSS, or WS on localhost".into());
    }
    // Keep vendor routing parameters, with exactly one authoritative model ID.
    let params: Vec<(String, String)> = url.query_pairs().filter(|(name, _)| name != "model").map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    url.set_query(None);
    url.query_pairs_mut().extend_pairs(params).append_pair("model", &input.model);
    let mut request = url.as_str().into_client_request().map_err(|_| "Invalid custom realtime request")?;
    let extra = &input.credentials.extra_headers;
    if extra.len() > 32 || extra.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() > 16384 { return Err("Custom realtime headers too large".into()); }
    let mut seen = std::collections::HashSet::new();
    for (name, value) in extra {
        let name = custom_header_name(name)?;
        if !seen.insert(name.clone()) || value.len() > 4096 || value.bytes().any(|b| b < 32 || b == 127) { return Err("Invalid custom realtime header value".into()); }
        request.headers_mut().insert(name, HeaderValue::from_str(value).map_err(|_| "Invalid custom realtime header value")?);
    }
    let name = match input.auth_mode.as_str() {
        "none" => return Ok(request),
        "bearer" => custom_header_name("authorization")?,
        "header" => custom_header_name(&input.auth_header)?,
        _ => return Err("Invalid custom realtime authentication mode".into()),
    };
    if seen.contains(&name) { return Err("Duplicate custom realtime authentication header".into()); }
    let key = input.credentials.api_key.trim();
    if key.is_empty() || key.len() > 4096 || key.bytes().any(|b| b < 32 || b == 127) { return Err("Missing or invalid custom realtime API key".into()); }
    let value = if input.auth_mode == "bearer" { format!("Bearer {key}") } else { key.to_string() };
    request.headers_mut().insert(name, HeaderValue::from_str(&value).map_err(|_| "Invalid custom realtime credential")?);
    Ok(request)
}
async fn run_ws(
    input: Connection,
    mut rx: mpsc::Receiver<Outgoing>,
    channel: &Channel<Frame>,
) -> Result<(), String> {
    // The AWS SDK and reqwest enable different rustls crypto backends. Select one
    // explicitly for tungstenite instead of relying on ambiguous feature defaults.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let request = websocket_request(&input)?;
    let ws_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(FRAME_LIMIT))
        .max_frame_size(Some(FRAME_LIMIT));
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async_with_config(request, Some(ws_config), false),
    )
    .await
    .map_err(|_| "Realtime connection timed out")?
    .map_err(|error| match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            format!("Realtime handshake HTTP {}", response.status().as_u16())
        }
        _ => "Realtime WebSocket connection failed".into(),
    })?;
    channel
        .send(frame("open", ""))
        .map_err(|_| "Realtime window closed")?;
    let idle = tokio::time::sleep(Duration::from_secs(45));
    tokio::pin!(idle);
    loop {
        tokio::select! {
            _ = &mut idle => return Err("Realtime microphone stream stopped".into()),
            outgoing = rx.recv() => match outgoing {
                Some(item) => {
                    idle.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(45));
                    let message = if item.kind == "binary" {
                        Message::Binary(base64::engine::general_purpose::STANDARD.decode(&item.data).map_err(|_| "Invalid realtime binary frame")?.into())
                    } else { Message::Text(item.data.into()) };
                    socket.send(message).await.map_err(|_| "Realtime send failed")?;
                }
                None => { let _ = socket.close(None).await; return Ok(()); }
            },
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Text(data))) => {
                    if data.len() > FRAME_LIMIT { return Err("Realtime frame too large".into()); }
                    channel.send(frame("text", data.to_string())).map_err(|_| "Realtime window closed")?;
                }
                Some(Ok(Message::Binary(data))) => {
                    if data.len() > FRAME_LIMIT { return Err("Realtime frame too large".into()); }
                    channel.send(frame("binary", base64::engine::general_purpose::STANDARD.encode(data))).map_err(|_| "Realtime window closed")?;
                }
                Some(Ok(Message::Close(_))) | None => return Ok(()),
                Some(Err(_)) => return Err("Realtime receive failed".into()),
                _ => {}
            }
        }
    }
}
async fn run_nova(
    input: Connection,
    rx: mpsc::Receiver<Outgoing>,
    channel: &Channel<Frame>,
) -> Result<(), String> {
    use aws_sdk_bedrockruntime::{
        config::{BehaviorVersion, Credentials as AwsCredentials, Region},
        primitives::Blob,
        types::{
            error::InvokeModelWithBidirectionalStreamInputError, BidirectionalInputPayloadPart,
            InvokeModelWithBidirectionalStreamInput as Input,
        },
    };
    let credentials = AwsCredentials::new(
        input.credentials.access_key_id,
        input.credentials.secret_access_key,
        if input.credentials.session_token.is_empty() {
            None
        } else {
            Some(input.credentials.session_token)
        },
        None,
        "realtime-profile",
    );
    let config = aws_sdk_bedrockruntime::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new(input.region))
        .credentials_provider(credentials)
        .retry_config(aws_sdk_bedrockruntime::config::retry::RetryConfig::disabled())
        .build();
    let body = tokio_stream::wrappers::ReceiverStream::new(rx).map(|item| {
        Ok::<_, InvokeModelWithBidirectionalStreamInputError>(Input::Chunk(
            BidirectionalInputPayloadPart::builder()
                .bytes(Blob::new(item.data))
                .build(),
        ))
    });
    // The service reads sessionStart/promptStart before completing response headers.
    channel
        .send(frame("open", ""))
        .map_err(|_| "Realtime window closed")?;
    let client = aws_sdk_bedrockruntime::Client::from_conf(config);
    let mut output = tokio::time::timeout(
        Duration::from_secs(20),
        client
            .invoke_model_with_bidirectional_stream()
            .model_id(input.model)
            .body(body.into())
            .send(),
    )
    .await
    .map_err(|_| "Nova connection timed out")?
    .map_err(|_| "Nova connection failed; check AWS credentials, region and Bedrock access")?;
    channel
        .send(frame("ready", ""))
        .map_err(|_| "Realtime window closed")?;
    while let Some(event) = output.body.recv().await.map_err(|_| "Nova stream failed")? {
        match event {
            aws_sdk_bedrockruntime::types::InvokeModelWithBidirectionalStreamOutput::Chunk(
                part,
            ) => {
                if let Some(bytes) = part.bytes {
                    if bytes.as_ref().len() > FRAME_LIMIT {
                        return Err("Nova frame too large".into());
                    }
                    let text =
                        String::from_utf8(bytes.into_inner()).map_err(|_| "Invalid Nova frame")?;
                    channel
                        .send(frame("text", text))
                        .map_err(|_| "Realtime window closed")?;
                }
            }
            _ => return Err("Nova returned an unsupported stream event".into()),
        }
    }
    Ok(())
}

#[tauri::command]
pub fn realtime_transport_open(
    window: WebviewWindow,
    state: State<'_, RealtimeTransportState>,
    id: String,
    connection: Connection,
    on_event: Channel<Frame>,
) -> Result<(), String> {
    check_owner(&window)?;
    validate(&connection)?;
    if id.len() < 8 || id.len() > 128 {
        return Err("Invalid realtime connection ID".into());
    }
    let (sender, receiver) = mpsc::channel(128);
    let sessions = state.0.clone();
    let mut map = sessions.lock().map_err(|_| "Realtime lock failed")?;
    if map.contains_key(&id) {
        return Err("Realtime connection already active".into());
    }
    // A main-window reload can outlive its JS cleanup. Opening a new call replaces
    // the previous native connection belonging to that window.
    map.retain(|_, session| {
        if session.owner == window.label() {
            session.abort.abort();
            false
        } else {
            true
        }
    });
    if map.len() >= 2 {
        return Err("Realtime connection limit reached".into());
    }
    let task_sessions = sessions.clone();
    let task_id = id.clone();
    let task = tauri::async_runtime::spawn(async move {
        let result = if connection.provider == "nova_sonic" {
            tokio::time::timeout(
                Duration::from_secs(9 * 60),
                run_nova(connection, receiver, &on_event),
            )
            .await
            .unwrap_or_else(|_| Err("Nova session expired".into()))
        } else {
            run_ws(connection, receiver, &on_event).await
        };
        if let Err(error) = result {
            let _ = on_event.send(frame("error", error));
        }
        let _ = on_event.send(frame("closed", ""));
        if let Ok(mut map) = task_sessions.lock() {
            map.remove(&task_id);
        }
    });
    map.insert(
        id,
        Session {
            sender,
            abort: task,
            owner: window.label().into(),
        },
    );
    Ok(())
}

#[tauri::command]
pub fn realtime_transport_send(
    window: WebviewWindow,
    state: State<'_, RealtimeTransportState>,
    id: String,
    messages: Vec<Outgoing>,
) -> Result<(), String> {
    check_owner(&window)?;
    if messages.len() > 32
        || messages
            .iter()
            .any(|m| m.data.len() > FRAME_LIMIT || !["text", "binary"].contains(&m.kind.as_str()))
    {
        return Err("Invalid realtime frame batch".into());
    }
    let map = state.0.lock().map_err(|_| "Realtime lock failed")?;
    let session = map
        .get(&id)
        .filter(|s| s.owner == window.label())
        .ok_or("Realtime connection closed")?;
    if session.sender.capacity() < messages.len() {
        return Err("Realtime send queue full".into());
    }
    for message in messages {
        session
            .sender
            .try_send(message)
            .map_err(|_| "Realtime send queue full")?;
    }
    Ok(())
}
#[tauri::command]
pub fn realtime_transport_close(
    window: WebviewWindow,
    state: State<'_, RealtimeTransportState>,
    id: String,
) -> Result<(), String> {
    check_owner(&window)?;
    let mut map = state.0.lock().map_err(|_| "Realtime lock failed")?;
    if map.get(&id).is_some_and(|s| s.owner != window.label()) {
        return Err("Invalid realtime owner".into());
    }
    if let Some(session) = map.remove(&id) {
        session.abort.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(provider: &str) -> Connection {
        serde_json::from_value(serde_json::json!({"provider":provider,"model":"test","region":"cn-beijing","credentials":{"apiKey":"fake-secret","appId":"123"}})).unwrap()
    }
    fn custom_input() -> Connection {
        serde_json::from_value(serde_json::json!({
            "provider":"custom", "customProtocol":"openai_realtime", "model":"vendor/voice",
            "endpoint":"wss://voice.example.test/proxy/v1/realtime?route=west&model=old&model=duplicate",
            "authMode":"bearer", "authHeader":"api-key", "credentials":{"apiKey":"test-key", "extraHeaders":{"X-Route":"regional"}}
        })).unwrap()
    }
    #[test]
    fn custom_realtime_preserves_endpoint_parameters_and_uses_one_model() {
        let request = websocket_request(&custom_input()).unwrap();
        let url = reqwest::Url::parse(&request.uri().to_string()).unwrap();
        assert_eq!(url.path(), "/proxy/v1/realtime");
        assert_eq!(url.query_pairs().filter(|(key, _)| key == "model").collect::<Vec<_>>(), vec![("model".into(), "vendor/voice".into())]);
        assert!(url.query_pairs().any(|(key, value)| key == "route" && value == "west"));
        assert_eq!(request.headers()["authorization"], "Bearer test-key");
        assert_eq!(request.headers()["x-route"], "regional");
        assert!(!request.uri().to_string().contains("test-key"));
    }
    #[test]
    fn custom_realtime_authentication_is_explicit() {
        let mut item = custom_input(); item.auth_mode = "header".into();
        let request = websocket_request(&item).unwrap();
        assert_eq!(request.headers()["api-key"], "test-key"); assert!(!request.headers().contains_key("authorization"));
        item.auth_mode = "none".into(); item.credentials.api_key.clear();
        assert!(!websocket_request(&item).unwrap().headers().contains_key("authorization"));
        item.auth_mode = "bearer".into(); assert!(websocket_request(&item).is_err());
    }
    #[test]
    fn custom_realtime_rejects_connection_header_overrides_and_insecure_remote_urls() {
        for endpoint in ["ws://voice.example.test/", "file:///C:/secret", "wss://user:pass@voice.example.test/", "wss://voice.example.test/#fragment"] {
            let mut item = custom_input(); item.endpoint = endpoint.into(); assert!(websocket_request(&item).is_err());
        }
        for endpoint in ["ws://127.0.0.1:1234/v1/realtime", "ws://[::1]:1234/v1/realtime"] {
            let mut item = custom_input(); item.endpoint = endpoint.into(); assert!(websocket_request(&item).is_ok());
        }
        for (name, value) in [("Host", "other.test"), ("Sec-WebSocket-Key", "override"), ("Authorization", "duplicate"), ("x-newline", "one\r\ntwo")] {
            let mut item = custom_input(); item.credentials.extra_headers.insert(name.into(), value.into()); assert!(websocket_request(&item).is_err());
        }
        let mut item = custom_input(); item.credentials.extra_headers.insert("x-route".into(), "duplicate".into()); assert!(websocket_request(&item).is_err());
        let mut item = custom_input(); item.custom_protocol = "unknown".into(); assert!(websocket_request(&item).is_err());
    }
    #[test]
    fn restricts_provider_and_workspace() {
        assert!(validate(&input("custom")).is_err());
        let mut item = input("qwen_audio_realtime");
        item.workspace_id = "a.evil.test/path".into();
        assert!(validate(&item).is_err());
        let mut nova = input("nova_sonic");
        nova.region = "us-east-1".into();
        nova.model = "amazon.nova-2-sonic-v1:1".into();
        nova.credentials.access_key_id = "test-access".into();
        nova.credentials.secret_access_key = "test-secret".into();
        assert!(validate(&nova).is_ok());
        nova.model = "amazon.nova-pro-v1:0".into();
        assert!(validate(&nova).is_err());
    }
    #[test]
    fn provider_auth_does_not_leak_into_other_hosts() {
        let qwen = websocket_request(&input("qwen_audio_realtime")).unwrap();
        assert_eq!(qwen.uri().host(), Some("dashscope.aliyuncs.com"));
        assert_eq!(qwen.headers()["authorization"], "Bearer fake-secret");
        let doubao = websocket_request(&input("doubao_realtime")).unwrap();
        assert_eq!(doubao.headers()["x-api-resource-id"], "volc.speech.dialog");
        assert!(doubao.headers().get("authorization").is_none());
    }
    #[test]
    fn step_sites_use_their_own_endpoint_with_bearer_auth() {
        let mut step = input("step_realtime");
        step.model = "stepaudio-2.5-realtime".into();
        for (region, host) in [("", "api.stepfun.com"), ("cn", "api.stepfun.com"), ("global", "api.stepfun.ai")] {
            step.region = region.into();
            let request = websocket_request(&step).unwrap();
            assert_eq!(request.uri().host(), Some(host));
            assert_eq!(request.uri().path(), "/v1/realtime");
            assert_eq!(request.uri().query(), Some("model=stepaudio-2.5-realtime"));
            assert_eq!(request.headers()["authorization"], "Bearer fake-secret");
        }
        for region in ["cn-beijing", "global.evil.test", "https://api.stepfun.ai"] {
            step.region = region.into();
            assert!(websocket_request(&step).is_err());
        }
    }
    #[test]
    fn gemini_backends_use_separate_hosts_and_authentication() {
        let developer = websocket_request(&input("gemini_live")).unwrap();
        assert_eq!(
            developer.uri().host(),
            Some("generativelanguage.googleapis.com")
        );
        assert!(developer.uri().query().unwrap().contains("key=fake-secret"));
        let mut vertex = input("gemini_live");
        vertex.gemini_backend = "vertex".into();
        vertex.vertexai_auth_mode = "service_account".into();
        vertex.region = "us-central1".into();
        vertex.credentials.access_token = "oauth-token".into();
        let full = websocket_request(&vertex).unwrap();
        assert_eq!(
            full.uri().host(),
            Some("us-central1-aiplatform.googleapis.com")
        );
        assert_eq!(
            full.uri().path(),
            "/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent"
        );
        assert!(full.uri().query().is_none());
        assert_eq!(full.headers()["authorization"], "Bearer oauth-token");
        assert!(full.headers().get("x-goog-api-key").is_none());
        vertex.region = "us-central1.evil.test".into();
        assert!(websocket_request(&vertex).is_err());
        vertex.vertexai_auth_mode = "express".into();
        let express = websocket_request(&vertex).unwrap();
        assert_eq!(express.uri().host(), Some("aiplatform.googleapis.com"));
        assert_eq!(express.headers()["x-goog-api-key"], "fake-secret");
        assert!(express.uri().query().is_none());
        assert!(express.headers().get("authorization").is_none());
        vertex.gemini_backend = "unrecognized".into();
        assert!(websocket_request(&vertex).is_err());
    }
    #[test]
    fn tls_backend_is_unambiguous_with_aws_and_websocket_features() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let _ = rustls::ClientConfig::builder();
    }
    #[tokio::test]
    async fn cancelling_session_aborts_the_actual_connection_task() {
        let (sender, _receiver) = mpsc::channel(1);
        let (started, ready) = tokio::sync::oneshot::channel();
        let task = tauri::async_runtime::spawn(async move {
            let _ = started.send(());
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        let session = Session {
            sender,
            abort: task,
            owner: "main".into(),
        };
        session.abort.abort();
        assert!(session.abort.await.is_err());
    }
}
