//! 即梦 (Dreamina) OAuth 登录 —— 移植自 AI-CanvasPro 的 dreamina_cli 方案。
//!
//! 通过官方 `dreamina_cli` 命令行二进制（运行时从 ByteDance CDN 下载并缓存）完成
//! OAuth 设备授权登录：
//!   1. `dreamina login --headless`  → 输出 verification_uri_complete / user_code / device_code
//!   2. 前端展示「授权链接 + 验证码」，用户在浏览器完成授权
//!   3. `dreamina login checklogin --device_code=<dc> --poll=N` 轮询直至 [DREAMINA:LOGIN_SUCCESS]
//!   4. `dreamina user_credit` 读取账号额度
//!
//! 登录态由 CLI 自身持久化，后续生成命令复用。前端只镜像 loggedIn 状态用于 UI。

use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

// 各平台二进制按 cfg 选用，未选中的常量在该平台上不会被引用
#[allow(dead_code)]
const WINDOWS_URL: &str = "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/dreamina_cli_windows_amd64.exe";
#[allow(dead_code)]
const DARWIN_ARM64_URL: &str = "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/dreamina_cli_darwin_arm64";
#[allow(dead_code)]
const DARWIN_AMD64_URL: &str = "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/dreamina_cli_darwin_amd64";

const LOGIN_SUCCESS_MARKER: &str = "[DREAMINA:LOGIN_SUCCESS]";
const LOGIN_REUSED_MARKER: &str = "[DREAMINA:LOGIN_REUSED]";
const RUNTIME_EVENT: &str = "dreamina-login-runtime";

/// 暴露给前端的登录运行态快照
#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRuntime {
    active: bool,
    /// idle / preparing / starting / oauth_ready / polling / success / failed
    phase: String,
    message: String,
    error: String,
    /// 授权链接（verification_uri_complete）
    verification_url: String,
    /// 验证码（user_code）
    user_code: String,
    logged_in: bool,
    username: String,
    credit: String,
}

fn state() -> &'static Mutex<LoginRuntime> {
    static S: OnceLock<Mutex<LoginRuntime>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(LoginRuntime::default()))
}

fn snapshot() -> LoginRuntime {
    state().lock().unwrap().clone()
}

/// 修改运行态并向前端广播事件
fn update<F: FnOnce(&mut LoginRuntime)>(app: &AppHandle, f: F) -> LoginRuntime {
    let snap = {
        let mut g = state().lock().unwrap();
        f(&mut g);
        g.clone()
    };
    let _ = app.emit(RUNTIME_EVENT, snap.clone());
    snap
}

fn fail(app: &AppHandle, message: &str) {
    update(app, |r| {
        r.active = false;
        r.phase = "failed".into();
        r.error = message.to_string();
        r.message = message.to_string();
    });
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

// ──────────────────────────────────────────────
// CLI 二进制管理（下载 / 缓存 / 探活）
// ──────────────────────────────────────────────

fn binary_url() -> Result<&'static str, String> {
    #[cfg(windows)]
    {
        return Ok(WINDOWS_URL);
    }
    #[cfg(target_os = "macos")]
    {
        if cfg!(target_arch = "aarch64") {
            return Ok(DARWIN_ARM64_URL);
        }
        return Ok(DARWIN_AMD64_URL);
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        Err("当前平台暂不支持自动准备即梦组件".into())
    }
}

fn managed_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?
        .join("tools")
        .join("dreamina");
    let name = if cfg!(windows) { "dreamina.exe" } else { "dreamina" };
    Ok(dir.join(name))
}

/// CLI 工作目录 —— 即梦把登录态/会话写在 cwd 下，必须固定且可写，
/// 否则 login 与 checklogin / user_credit 之间无法共享登录态。
fn workdir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("dreamina-cli"))
        .unwrap_or_else(|_| std::env::temp_dir().join("dreamina-cli"));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// 记录 CLI 输出尾部（用于失败诊断）
fn push_tail(tail: &mut Vec<String>, line: &str) {
    if line.trim().is_empty() {
        return;
    }
    tail.push(line.to_string());
    let len = tail.len();
    if len > 60 {
        tail.drain(0..len - 60);
    }
}

fn tail_summary(tail: &[String]) -> String {
    let start = tail.len().saturating_sub(8);
    tail[start..].join("\n")
}

/// 用 `version` 子命令探活
fn probe(path: &PathBuf, cwd: &PathBuf) -> bool {
    let mut cmd = Command::new(path);
    cmd.current_dir(cwd)
        .arg("version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut cmd);
    matches!(cmd.status(), Ok(s) if s.success())
}

/// 确保 CLI 存在，必要时下载到应用数据目录
fn ensure_cli(app: &AppHandle) -> Result<PathBuf, String> {
    let path = managed_path(app)?;
    let cwd = workdir(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    if path.is_file() && probe(&path, &cwd) {
        return Ok(path);
    }

    let url = binary_url()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("创建下载客户端失败: {e}"))?;
    let bytes = client
        .get(url)
        .send()
        .map_err(|e| format!("下载即梦组件失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("下载即梦组件失败: {e}"))?
        .bytes()
        .map_err(|e| format!("读取即梦组件失败: {e}"))?;

    let tmp = path.with_extension("download");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写入即梦组件失败: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }

    std::fs::rename(&tmp, &path).map_err(|e| format!("安装即梦组件失败: {e}"))?;

    if !probe(&path, &cwd) {
        let _ = std::fs::remove_file(&path);
        return Err("即梦组件校验失败，请检查网络后重试".into());
    }
    Ok(path)
}

// ──────────────────────────────────────────────
// 文本解析（去 ANSI / 提取 OAuth 字段 / 抽取 JSON）
// ──────────────────────────────────────────────

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // 跳过 CSI 序列直到终止字节 @-~
            while let Some(&n) = chars.peek() {
                chars.next();
                if ('@'..='~').contains(&n) {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// 从一行文本里按 `key: value` / `key=value` 形式抓取标注值
fn labeled_value(text: &str, keys: &[&str]) -> Option<String> {
    let lower = text.to_lowercase();
    for key in keys {
        let kl = key.to_lowercase();
        let mut from = 0usize;
        while let Some(pos) = lower[from..].find(&kl) {
            let idx = from + pos;
            let after = &text[idx + key.len()..];
            let bytes = after.as_bytes();
            let mut i = 0usize;
            while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
                i += 1;
            }
            if i < bytes.len() && (bytes[i] == b':' || bytes[i] == b'=') {
                i += 1;
                while i < bytes.len()
                    && (bytes[i] == b' ' || bytes[i] == b'\t' || bytes[i] == b'"' || bytes[i] == b'\'')
                {
                    i += 1;
                }
                let rest = &after[i..];
                let end = rest
                    .find(|c: char| {
                        c == '\'' || c == '"' || c.is_whitespace() || c == ',' || c == ';' || c == '}'
                    })
                    .unwrap_or(rest.len());
                let val = rest[..end].trim();
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
            from = idx + key.len();
        }
    }
    None
}

/// 从可能夹杂日志的文本里截取第一个 JSON 对象
fn extract_json_object(text: &str) -> Option<serde_json::Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&text[start..=end]).ok()
}

struct OAuthMaterial {
    verification_url: String,
    user_code: String,
    device_code: String,
}

fn extract_material(text: &str) -> Option<OAuthMaterial> {
    let raw = strip_ansi(text);
    let mut m = OAuthMaterial {
        verification_url: String::new(),
        user_code: String::new(),
        device_code: String::new(),
    };

    if let Some(v) = extract_json_object(&raw) {
        for k in ["verification_uri_complete", "verification_url", "verification_uri"] {
            if let Some(s) = v.get(k).and_then(|x| x.as_str()) {
                m.verification_url = s.trim().to_string();
                break;
            }
        }
        for k in ["user_code", "userCode"] {
            if let Some(s) = v.get(k).and_then(|x| x.as_str()) {
                m.user_code = s.trim().to_string();
                break;
            }
        }
        for k in ["device_code", "deviceCode"] {
            if let Some(s) = v.get(k).and_then(|x| x.as_str()) {
                m.device_code = s.trim().to_string();
                break;
            }
        }
    }

    if m.verification_url.is_empty() {
        if let Some(s) =
            labeled_value(&raw, &["verification_uri_complete", "verification_url", "verification_uri"])
        {
            if s.starts_with("http") {
                m.verification_url = s;
            }
        }
    }
    if m.user_code.is_empty() {
        if let Some(s) = labeled_value(&raw, &["user_code", "userCode"]) {
            m.user_code = s;
        }
    }
    if m.device_code.is_empty() {
        if let Some(s) = labeled_value(&raw, &["device_code", "deviceCode"]) {
            m.device_code = s;
        }
    }

    if m.verification_url.is_empty() && m.user_code.is_empty() && m.device_code.is_empty() {
        None
    } else {
        Some(m)
    }
}

// ──────────────────────────────────────────────
// 账号额度
// ──────────────────────────────────────────────

/// 运行 `user_credit`，返回 (loggedIn, username, credit 文本)
fn fetch_credit(path: &PathBuf, cwd: &PathBuf) -> (bool, String, String) {
    let mut cmd = Command::new(path);
    cmd.current_dir(cwd)
        .arg("user_credit")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);
    let out = match cmd.output() {
        Ok(o) => o,
        Err(_) => return (false, String::new(), String::new()),
    };
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let v = match extract_json_object(&strip_ansi(&text)) {
        Some(v) if v.is_object() => v,
        _ => return (false, String::new(), String::new()),
    };

    let username = ["name", "nickname", "username", "user_name"]
        .iter()
        .find_map(|k| {
            v.get(*k)
                .and_then(|x| x.as_str())
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or("即梦用户")
        .to_string();

    let credit_raw = [
        "total_credit", "totalCredit", "credit", "credits", "balance", "points", "total",
        "left", "remaining", "remain_credit",
    ]
    .iter()
    .find_map(|k| match v.get(*k) {
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        Some(serde_json::Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    })
    .unwrap_or_default();
    // 纯数字额度展示为「N 积分」
    let credit = if !credit_raw.is_empty() && credit_raw.chars().all(|c| c.is_ascii_digit()) {
        format!("{credit_raw} 积分")
    } else {
        credit_raw
    };

    (true, username, credit)
}

// ──────────────────────────────────────────────
// 登录流程（后台线程）
// ──────────────────────────────────────────────

/// 流式读取子进程 stdout，逐行回调；阻塞直至进程结束
fn read_lines<F: FnMut(String)>(child: &mut std::process::Child, mut on_line: F) {
    if let Some(stdout) = child.stdout.take() {
        let mut reader = BufReader::new(stdout);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf)
                        .trim_end_matches(['\r', '\n'])
                        .to_string();
                    on_line(line);
                }
                Err(_) => break,
            }
        }
    }
}

/// 读取子进程 stderr 尾部到 tail（用于诊断）
fn drain_stderr(child: &mut std::process::Child, tail: &mut Vec<String>) {
    if let Some(err) = child.stderr.take() {
        let mut reader = BufReader::new(err);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf)
                        .trim_end_matches(['\r', '\n'])
                        .to_string();
                    push_tail(tail, &strip_ansi(&line));
                }
                Err(_) => break,
            }
        }
    }
}

fn run_login_sequence(app: AppHandle, force: bool) {
    update(&app, |r| {
        r.phase = "preparing".into();
        r.message = "正在准备即梦组件…".into();
    });

    let path = match ensure_cli(&app) {
        Ok(p) => p,
        Err(e) => {
            fail(&app, &e);
            return;
        }
    };
    let work = workdir(&app);

    update(&app, |r| {
        r.phase = "starting".into();
        r.message = "正在启动即梦 OAuth 登录…".into();
    });

    let mut device_code = String::new();
    let mut success = false;
    let mut tail: Vec<String> = Vec::new();

    // 1) login --headless：拿到授权链接 + 验证码 + device_code
    let sub = if force { "relogin" } else { "login" };
    let mut cmd = Command::new(&path);
    cmd.current_dir(&work)
        .arg(sub)
        .arg("--headless")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);
    match cmd.spawn() {
        Ok(mut child) => {
            read_lines(&mut child, |line| {
                let clean = strip_ansi(&line);
                push_tail(&mut tail, &clean);
                if clean.contains(LOGIN_SUCCESS_MARKER) || clean.contains(LOGIN_REUSED_MARKER) {
                    success = true;
                }
                if let Some(m) = extract_material(&clean) {
                    update(&app, |r| {
                        if !m.verification_url.is_empty() {
                            r.verification_url = m.verification_url.clone();
                        }
                        if !m.user_code.is_empty() {
                            r.user_code = m.user_code.clone();
                        }
                        if r.phase == "preparing" || r.phase == "starting" {
                            r.phase = "oauth_ready".into();
                        }
                        let code = r.user_code.clone();
                        r.message = if code.is_empty() {
                            "请打开即梦授权链接完成授权".into()
                        } else {
                            format!("请打开授权链接，在页面输入验证码：{code}")
                        };
                    });
                    if !m.device_code.is_empty() {
                        device_code = m.device_code;
                    }
                }
            });
            drain_stderr(&mut child, &mut tail);
            let _ = child.wait();
        }
        Err(e) => {
            fail(&app, &format!("启动即梦登录失败: {e}"));
            return;
        }
    }

    // 2) checklogin 轮询（最多 ~5 分钟），等待用户在浏览器完成授权。
    //    success 以「marker / exit 0 / user_credit 实际登录态」三者任一为准。
    if !success && !device_code.is_empty() {
        update(&app, |r| {
            if r.phase != "success" {
                r.phase = "polling".into();
            }
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        while !success && std::time::Instant::now() < deadline {
            let mut cmd = Command::new(&path);
            cmd.current_dir(&work)
                .arg("login")
                .arg("checklogin")
                .arg(format!("--device_code={device_code}"))
                .arg("--poll=60")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            no_window(&mut cmd);
            let started = std::time::Instant::now();
            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(_) => break,
            };
            let mut expired = false;
            read_lines(&mut child, |line| {
                let clean = strip_ansi(&line);
                push_tail(&mut tail, &clean);
                if clean.contains(LOGIN_SUCCESS_MARKER) || clean.contains(LOGIN_REUSED_MARKER) {
                    success = true;
                }
                if clean.contains("expired") || clean.contains("过期") || clean.contains("已失效") {
                    expired = true;
                }
            });
            drain_stderr(&mut child, &mut tail);
            let status = child.wait();
            if success || matches!(status, Ok(ref s) if s.success()) {
                success = true;
                break;
            }
            // 权威判定：CLI 是否已持有有效登录态（兜底 checklogin 的退出码语义差异）
            if fetch_credit(&path, &work).0 {
                success = true;
                break;
            }
            if expired {
                break;
            }
            // checklogin 若非长轮询而是立即返回，稍等再试，避免空转把时间窗耗尽
            if started.elapsed() < std::time::Duration::from_secs(3) {
                std::thread::sleep(std::time::Duration::from_secs(3));
            }
        }
    }

    // 3) 收尾：以 user_credit 实际登录态为权威
    let (logged, username, credit) = fetch_credit(&path, &work);
    if success || logged {
        update(&app, |r| {
            r.active = false;
            r.phase = "success".into();
            r.error = String::new();
            r.message = "即梦已登录成功".into();
            r.logged_in = true;
            r.username = if username.is_empty() { "即梦用户".into() } else { username };
            r.credit = credit;
        });
    } else {
        // 落日志 + 回显尾部，便于排查
        let _ = std::fs::write(work.join("dreamina-login.log"), tail.join("\n"));
        let detail = tail_summary(&tail);
        let msg = if detail.is_empty() {
            "即梦登录失败或超时，请重试".to_string()
        } else {
            format!("即梦登录失败或超时，请重试。\nCLI 输出：\n{detail}")
        };
        fail(&app, &msg);
    }
}

// ──────────────────────────────────────────────
// Tauri 命令
// ──────────────────────────────────────────────

#[tauri::command]
pub fn dreamina_login_start(app: AppHandle, force: Option<bool>) -> LoginRuntime {
    {
        let mut g = state().lock().unwrap();
        if g.active {
            return g.clone();
        }
        *g = LoginRuntime {
            active: true,
            phase: "preparing".into(),
            message: "正在准备即梦 OAuth 登录…".into(),
            ..Default::default()
        };
    }
    let app2 = app.clone();
    let force = force.unwrap_or(false);
    std::thread::spawn(move || run_login_sequence(app2, force));
    snapshot()
}

#[tauri::command]
pub fn dreamina_login_runtime() -> LoginRuntime {
    snapshot()
}

#[tauri::command]
pub async fn dreamina_logout(app: AppHandle) -> Result<LoginRuntime, String> {
    {
        if state().lock().unwrap().active {
            return Err("请先完成当前登录流程，再退出登录".into());
        }
    }
    let app2 = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if let Ok(path) = managed_path(&app2) {
            if path.is_file() {
                let mut cmd = Command::new(&path);
                cmd.current_dir(workdir(&app2))
                    .arg("logout")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                no_window(&mut cmd);
                let _ = cmd.status();
            }
        }
    })
    .await;
    Ok(update(&app, |r| {
        *r = LoginRuntime {
            phase: "idle".into(),
            message: "已退出登录".into(),
            ..Default::default()
        };
    }))
}

/// 主动查询登录态（用于打开设置时刷新已保存的登录）
fn status_blocking(app: AppHandle) {
    if let Ok(path) = managed_path(&app) {
        if path.is_file() {
            let (logged, username, credit) = fetch_credit(&path, &workdir(&app));
            update(&app, |r| {
                if !r.active {
                    r.logged_in = logged;
                    if logged {
                        r.username = if username.is_empty() { "即梦用户".into() } else { username };
                        r.credit = credit;
                        if r.phase.is_empty() || r.phase == "idle" {
                            r.phase = "success".into();
                        }
                    }
                }
            });
        }
    }
}

#[tauri::command]
pub async fn dreamina_status(app: AppHandle) -> LoginRuntime {
    let _ = tauri::async_runtime::spawn_blocking(move || status_blocking(app)).await;
    snapshot()
}

// ════════════════════════════════════════════════
// 生成（text2image / image2image / text2video / image2video）
// ════════════════════════════════════════════════

const URL_KEYS: &[&str] = &[
    "url", "uri", "download_url", "downloadUrl", "file_url", "fileUrl", "media_url", "mediaUrl",
    "image_url", "imageUrl", "result_image_url", "resultImageUrl", "video_url", "videoUrl",
    "cover_url", "coverUrl", "src",
];
const LOCAL_KEYS: &[&str] = &[
    "local_path", "localPath", "path", "file_path", "filePath", "download_path", "downloadPath",
];

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateParams {
    /// text2image | image2image | text2video | image2video
    kind: String,
    prompt: String,
    #[serde(default)]
    ratio: String,
    #[serde(default)]
    resolution_type: String,
    #[serde(default)]
    model_version: String,
    #[serde(default)]
    video_resolution: String,
    #[serde(default)]
    duration: Option<i64>,
    /// image2image 的输入图（URL / asset.localhost / data: / 本地路径，1-10 张）
    #[serde(default)]
    images: Vec<String>,
    /// image2video 的首帧图
    #[serde(default)]
    image: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OutputItem {
    url: String,
    local_path: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateResult {
    submit_id: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    status: String, // pending | success | failed
    outputs: Vec<OutputItem>,
    fail_reason: String,
}

/// 运行 CLI 并返回 (成功, 合并输出文本)
fn run_capture(path: &PathBuf, cwd: &PathBuf, args: &[String]) -> (bool, String) {
    let mut cmd = Command::new(path);
    cmd.current_dir(cwd);
    for a in args {
        cmd.arg(a);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);
    match cmd.output() {
        Ok(o) => {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            (o.status.success(), text)
        }
        Err(e) => (false, e.to_string()),
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 把 convertFileSrc 生成的 asset.localhost URL 还原为本地路径
fn asset_url_to_path(u: &str) -> Option<String> {
    let marker = "asset.localhost/";
    let idx = u.find(marker)? + marker.len();
    let rest = &u[idx..];
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let decoded = percent_decode(rest);
    if decoded.is_empty() {
        None
    } else {
        Some(decoded)
    }
}

fn guess_ext(url: &str, content_type: &str) -> String {
    let ct = content_type.to_lowercase();
    if ct.contains("png") {
        return "png".into();
    }
    if ct.contains("jpeg") || ct.contains("jpg") {
        return "jpg".into();
    }
    if ct.contains("webp") {
        return "webp".into();
    }
    let lower = url.to_lowercase();
    for ext in ["png", "jpg", "jpeg", "webp", "gif", "bmp"] {
        if lower.contains(&format!(".{ext}")) {
            return ext.into();
        }
    }
    "png".into()
}

/// 把各种形式的图片输入归一化为 CLI 可用的本地文件路径
fn normalize_media(input: &str, inputs_dir: &PathBuf) -> Result<String, String> {
    let u = input.trim();
    if u.is_empty() {
        return Err("空图片输入".into());
    }
    // asset.localhost → 本地路径
    if u.contains("asset.localhost/") {
        if let Some(p) = asset_url_to_path(u) {
            if Path::new(&p).is_file() {
                return Ok(p);
            }
        }
    }
    // 本地路径
    if Path::new(u).is_file() {
        return Ok(u.to_string());
    }
    std::fs::create_dir_all(inputs_dir).ok();
    let stamp = format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    // data: URL
    if let Some(rest) = u.strip_prefix("data:") {
        let comma = rest.find(',').ok_or("非法 data URL")?;
        let meta = &rest[..comma];
        let payload = &rest[comma + 1..];
        let ext = guess_ext("", meta);
        let bytes = if meta.contains("base64") {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .decode(payload)
                .map_err(|e| format!("解码图片失败: {e}"))?
        } else {
            percent_decode(payload).into_bytes()
        };
        let target = inputs_dir.join(format!("input-{stamp}.{ext}"));
        std::fs::write(&target, &bytes).map_err(|e| format!("写入图片失败: {e}"))?;
        return Ok(target.to_string_lossy().to_string());
    }
    // http(s) → 下载
    if u.starts_with("http://") || u.starts_with("https://") {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| format!("创建下载客户端失败: {e}"))?;
        let resp = client
            .get(u)
            .send()
            .map_err(|e| format!("下载图片失败: {e}"))?
            .error_for_status()
            .map_err(|e| format!("下载图片失败: {e}"))?;
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let ext = guess_ext(u, &ct);
        let bytes = resp.bytes().map_err(|e| format!("读取图片失败: {e}"))?;
        let target = inputs_dir.join(format!("input-{stamp}.{ext}"));
        std::fs::write(&target, &bytes).map_err(|e| format!("写入图片失败: {e}"))?;
        return Ok(target.to_string_lossy().to_string());
    }
    Err(format!("无法识别的图片输入: {}", &u[..u.len().min(80)]))
}

fn first_str(map: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> String {
    for k in keys {
        if let Some(s) = map.get(*k).and_then(|v| v.as_str()) {
            if !s.trim().is_empty() {
                return s.trim().to_string();
            }
        }
    }
    String::new()
}

/// 递归收集 JSON 中的产物（url + 本地路径），跳过 input/reference/prompt 字段
fn collect_outputs(v: &serde_json::Value, out: &mut Vec<OutputItem>, seen: &mut HashSet<String>) {
    match v {
        serde_json::Value::Object(map) => {
            let url = first_str(map, URL_KEYS);
            let local_path = first_str(map, LOCAL_KEYS);
            if !url.is_empty() || !local_path.is_empty() {
                let key = format!("{url}|{local_path}");
                if seen.insert(key) {
                    out.push(OutputItem { url, local_path });
                }
            }
            for (k, val) in map {
                let lk = k.to_lowercase();
                if lk.contains("input") || lk.contains("reference") || lk.contains("prompt") {
                    continue;
                }
                collect_outputs(val, out, seen);
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                collect_outputs(item, out, seen);
            }
        }
        _ => {}
    }
}

fn gen_status_phase(status: &str, has_outputs: bool) -> &'static str {
    match status.to_lowercase().as_str() {
        "success" | "succeeded" | "completed" | "done" => "success",
        "fail" | "failed" | "error" => "failed",
        _ if has_outputs => "success",
        _ => "pending",
    }
}

/// 从 CLI 输出里取第一段 JSON 对象并递归找某些键
fn find_first_key(v: &serde_json::Value, keys: &[&str]) -> String {
    match v {
        serde_json::Value::Object(map) => {
            for k in keys {
                if let Some(s) = map.get(*k).and_then(|x| x.as_str()) {
                    if !s.trim().is_empty() {
                        return s.trim().to_string();
                    }
                }
            }
            for (_, val) in map {
                let r = find_first_key(val, keys);
                if !r.is_empty() {
                    return r;
                }
            }
            String::new()
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                let r = find_first_key(item, keys);
                if !r.is_empty() {
                    return r;
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

#[tauri::command]
pub async fn dreamina_generate(
    app: AppHandle,
    params: GenerateParams,
) -> Result<GenerateResult, String> {
    tauri::async_runtime::spawn_blocking(move || dreamina_generate_blocking(app, params))
        .await
        .map_err(|e| format!("生成任务调度失败: {e}"))?
}

fn dreamina_generate_blocking(
    app: AppHandle,
    params: GenerateParams,
) -> Result<GenerateResult, String> {
    let path = managed_path(&app)?;
    if !path.is_file() {
        return Err("即梦尚未登录，请先在「设置 → 即梦」完成 OAuth 登录".into());
    }
    let work = workdir(&app);
    let inputs_dir = work.join("inputs");

    let mut args: Vec<String> = Vec::new();
    match params.kind.as_str() {
        "text2image" => {
            args.push("text2image".into());
            args.push("--prompt".into());
            args.push(params.prompt.clone());
            if !params.ratio.is_empty() {
                args.push("--ratio".into());
                args.push(params.ratio.clone());
            }
            if !params.resolution_type.is_empty() {
                args.push("--resolution_type".into());
                args.push(params.resolution_type.clone());
            }
            if !params.model_version.is_empty() {
                args.push("--model_version".into());
                args.push(params.model_version.clone());
            }
        }
        "image2image" => {
            if params.images.is_empty() {
                return Err("image2image 需要至少一张输入图".into());
            }
            let mut local: Vec<String> = Vec::new();
            for u in params.images.iter().take(10) {
                local.push(normalize_media(u, &inputs_dir)?);
            }
            args.push("image2image".into());
            args.push("--images".into());
            args.push(local.join(","));
            args.push("--prompt".into());
            args.push(params.prompt.clone());
            if !params.ratio.is_empty() {
                args.push("--ratio".into());
                args.push(params.ratio.clone());
            }
            if !params.resolution_type.is_empty() {
                args.push("--resolution_type".into());
                args.push(params.resolution_type.clone());
            }
            if !params.model_version.is_empty() {
                args.push("--model_version".into());
                args.push(params.model_version.clone());
            }
        }
        "text2video" => {
            args.push("text2video".into());
            args.push("--prompt".into());
            args.push(params.prompt.clone());
            if let Some(d) = params.duration {
                args.push("--duration".into());
                args.push(d.to_string());
            }
            if !params.ratio.is_empty() {
                args.push("--ratio".into());
                args.push(params.ratio.clone());
            }
            if !params.video_resolution.is_empty() {
                args.push("--video_resolution".into());
                args.push(params.video_resolution.clone());
            }
            if !params.model_version.is_empty() {
                args.push("--model_version".into());
                args.push(params.model_version.clone());
            }
        }
        "image2video" => {
            if params.image.trim().is_empty() {
                return Err("image2video 需要一张首帧图".into());
            }
            let local = normalize_media(&params.image, &inputs_dir)?;
            args.push("image2video".into());
            args.push("--image".into());
            args.push(local);
            args.push("--prompt".into());
            args.push(params.prompt.clone());
            if let Some(d) = params.duration {
                args.push("--duration".into());
                args.push(d.to_string());
            }
            if !params.video_resolution.is_empty() {
                args.push("--video_resolution".into());
                args.push(params.video_resolution.clone());
            }
            if !params.model_version.is_empty() {
                args.push("--model_version".into());
                args.push(params.model_version.clone());
            }
        }
        other => return Err(format!("不支持的生成类型: {other}")),
    }
    args.push("--poll".into());
    args.push("0".into());

    let (ok, output) = run_capture(&path, &work, &args);
    let value = extract_json_object(&strip_ansi(&output));
    let submit_id = value
        .as_ref()
        .map(|v| find_first_key(v, &["submit_id", "submitId"]))
        .unwrap_or_default();

    if submit_id.is_empty() {
        let detail = find_first_key(
            value.as_ref().unwrap_or(&serde_json::Value::Null),
            &["fail_reason", "failReason", "message", "msg", "error"],
        );
        let msg = if !detail.is_empty() {
            detail
        } else if !ok && !output.trim().is_empty() {
            tail_summary(&output.lines().map(|s| s.to_string()).collect::<Vec<_>>())
        } else {
            "即梦提交失败，未返回任务 ID".into()
        };
        return Err(msg);
    }
    Ok(GenerateResult { submit_id })
}

#[tauri::command]
pub async fn dreamina_query_result(
    app: AppHandle,
    submit_id: String,
) -> Result<QueryResult, String> {
    tauri::async_runtime::spawn_blocking(move || dreamina_query_result_blocking(app, submit_id))
        .await
        .map_err(|e| format!("查询任务调度失败: {e}"))?
}

fn dreamina_query_result_blocking(app: AppHandle, submit_id: String) -> Result<QueryResult, String> {
    let path = managed_path(&app)?;
    if !path.is_file() {
        return Err("即梦尚未登录".into());
    }
    let work = workdir(&app);
    let download_dir = work.join("output").join(&submit_id);
    std::fs::create_dir_all(&download_dir).ok();

    let args = vec![
        "query_result".to_string(),
        "--submit_id".to_string(),
        submit_id.clone(),
        "--download_dir".to_string(),
        download_dir.to_string_lossy().to_string(),
    ];
    let (ok, output) = run_capture(&path, &work, &args);
    let value = match extract_json_object(&strip_ansi(&output)) {
        Some(v) => v,
        None => {
            if ok {
                return Ok(QueryResult {
                    status: "pending".into(),
                    outputs: vec![],
                    fail_reason: String::new(),
                });
            }
            return Err(if output.trim().is_empty() {
                "查询失败".into()
            } else {
                tail_summary(&output.lines().map(|s| s.to_string()).collect::<Vec<_>>())
            });
        }
    };

    let mut outputs: Vec<OutputItem> = Vec::new();
    let mut seen = HashSet::new();
    collect_outputs(&value, &mut outputs, &mut seen);

    // 兜底：若 JSON 未给本地路径，扫描下载目录
    if outputs.iter().all(|o| o.local_path.is_empty()) {
        if let Ok(entries) = std::fs::read_dir(&download_dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_file() {
                    let lp = p.to_string_lossy().to_string();
                    if !outputs.is_empty() {
                        outputs[0].local_path = lp;
                    } else {
                        outputs.push(OutputItem { url: String::new(), local_path: lp });
                    }
                    break;
                }
            }
        }
    }

    let gen_status = find_first_key(&value, &["gen_status", "genStatus", "status"]);
    let status = gen_status_phase(&gen_status, !outputs.is_empty()).to_string();
    let fail_reason = if status == "failed" {
        find_first_key(&value, &["fail_reason", "failReason", "message", "msg", "error"])
    } else {
        String::new()
    };

    Ok(QueryResult { status, outputs, fail_reason })
}
