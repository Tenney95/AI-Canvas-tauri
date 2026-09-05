//! HuggingFace 模型下载源择优。
//!
//! 国内直连 HuggingFace 时好时坏，第三方镜像也不是永远可用，所以不在代码里写死某个源：
//! 首次下载模型时并发探测两个源的真实吞吐，选快的那个并缓存到进程退出；
//! 下载失败时翻转到另一个源重试一次。
//!
//! 关键点：官方和镜像最终都会 302 到 `us.aws.cdn.hf.co` 这类 CDN，所以
//! 「能不能连上 huggingface.co 这个域名」根本说明不了问题——实测过，域名能通但
//! 真正的分片请求会卡 20 秒。必须真的下一段字节来计时才准。
//!
//! 缓存故意不放进持久化配置：镜像站随时可能失效，每次启动重新探测一次（约 1–6 秒）
//! 比留下一个过期偏好更稳妥。

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use url::Url;

/// HuggingFace 官方域名
const OFFICIAL_HOST: &str = "huggingface.co";
/// 第三方国内镜像。失效时改这一个常量即可，其余逻辑不用动。
const MIRROR_HOST: &str = "hf-mirror.com";

/// 只改写这些域名，其余地址一律原样返回——绝不能把任意下载重定向到镜像。
const REWRITABLE_HOSTS: [&str; 2] = [OFFICIAL_HOST, "cdn-lfs.huggingface.co"];

/// 探针文件：体积略大于探测窗口、且两个源上都稳定存在的小文件。
/// 万一仓库哪天没了，两个源都会探测失败，会安全回退到官方源。
const PROBE_PATH: &str = "OpenVoiceOS/sensevoice-small-onnx/resolve/main/vocab.txt";
/// 每个源只取前 256 KB，够算吞吐又不会拖慢首次下载
const PROBE_BYTES: usize = 256 * 1024;
/// 单源探测超时；超时即视为不可用
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);
/// 官方源需要快过这个倍率才继续用官方。留一点余量，避免网络抖动时来回切换。
const OFFICIAL_BIAS: f64 = 1.15;

/// 下载源
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Source {
    /// 非 HuggingFace 地址：原样放行，不做改写也不做重试
    Passthrough,
    Official,
    Mirror,
}

impl Source {
    fn host(self) -> &'static str {
        match self {
            Source::Passthrough => OFFICIAL_HOST,
            Source::Official => OFFICIAL_HOST,
            Source::Mirror => MIRROR_HOST,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Source::Passthrough => "original",
            Source::Official => "official",
            Source::Mirror => "mirror",
        }
    }
}

/// 解析结果
pub struct Resolved {
    pub url: String,
    pub source: Source,
}

fn cache_slot() -> &'static Mutex<Option<Source>> {
    static CACHE: OnceLock<Mutex<Option<Source>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn read_cache() -> Option<Source> {
    let guard = cache_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard
}

fn write_cache(source: Source) {
    let mut guard = cache_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some(source);
}

/// 决定一个下载地址该走哪个源。
///
/// `prefer` 显式指定源时跳过探测并写入缓存，用于下载失败后翻转重试。
pub async fn resolve(raw_url: &str, prefer: Option<Source>) -> Resolved {
    let managed = Url::parse(raw_url).ok().is_some_and(|parsed| {
        let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
        // 只接管 https 的 HuggingFace 域名；http 与非 HF 域名一律不碰
        parsed.scheme() == "https" && REWRITABLE_HOSTS.contains(&host.as_str())
    });
    if !managed {
        return rewrite_for(raw_url, Source::Passthrough);
    }

    let source = match prefer {
        Some(Source::Passthrough) | None => match read_cache() {
            Some(cached) => cached,
            None => {
                let chosen = select_source().await;
                write_cache(chosen);
                chosen
            }
        },
        Some(forced) => {
            write_cache(forced);
            forced
        }
    };

    rewrite_for(raw_url, source)
}

/// 下载失败后取另一个源重试；源不可切换（非 HuggingFace 地址）时返回 None。
pub fn alternate(used: Source) -> Option<Source> {
    match used {
        Source::Passthrough => None,
        Source::Official => Some(Source::Mirror),
        Source::Mirror => Some(Source::Official),
    }
}

/// 纯改写，不读写缓存。非受管地址直接返回原文。
fn rewrite_for(raw_url: &str, source: Source) -> Resolved {
    let parsed = match Url::parse(raw_url) {
        Ok(parsed) => parsed,
        Err(_) => {
            return Resolved {
                url: raw_url.to_string(),
                source: Source::Passthrough,
            }
        }
    };
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if parsed.scheme() != "https" || !REWRITABLE_HOSTS.contains(&host.as_str()) {
        return Resolved {
            url: raw_url.to_string(),
            source: Source::Passthrough,
        };
    }
    Resolved {
        url: rewrite(&parsed, source.host()),
        source,
    }
}

/// 并发探测两个源，返回吞吐更高的那个；都失败时回退官方。
async fn select_source() -> Source {
    let (official, mirror) = tokio::join!(measure(OFFICIAL_HOST), measure(MIRROR_HOST));
    eprintln!(
        "[model-mirror] 探测 官方={:?} 镜像={:?}",
        official.map(|(_, elapsed)| elapsed),
        mirror.map(|(_, elapsed)| elapsed)
    );

    let chosen = match (official, mirror) {
        (Some(official), Some(mirror)) => {
            if throughput(official) >= throughput(mirror) * OFFICIAL_BIAS {
                Source::Official
            } else {
                Source::Mirror
            }
        }
        (Some(_), None) => Source::Official,
        (None, Some(_)) => Source::Mirror,
        (None, None) => Source::Official,
    };
    eprintln!("[model-mirror] 选用 {:?}（{}）", chosen, chosen.label());
    chosen
}

fn throughput(sample: (usize, Duration)) -> f64 {
    let (bytes, elapsed) = sample;
    bytes as f64 / elapsed.as_secs_f64().max(1e-6)
}

/// 对单个源发一个分片 GET，返回 (收到字节数, 耗时)。不可用返回 None。
async fn measure(host: &str) -> Option<(usize, Duration)> {
    let client = reqwest::Client::builder()
        .user_agent("AI-Canvas/0.4")
        .timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .ok()?;

    let started = Instant::now();
    let response = client
        .get(format!("https://{host}/{PROBE_PATH}"))
        .header(
            reqwest::header::RANGE,
            format!("bytes=0-{}", PROBE_BYTES - 1),
        )
        .send()
        .await
        .ok()?;
    let status = response.status();
    if !(status.is_success() || status == reqwest::StatusCode::PARTIAL_CONTENT) {
        eprintln!("[model-mirror] {host} 探测返回 {status}");
        return None;
    }
    let body = response.bytes().await.ok()?;
    if body.is_empty() {
        return None;
    }
    Some((body.len(), started.elapsed()))
}

/// 只替换域名，路径与查询串原样保留。
fn rewrite(original: &Url, host: &str) -> String {
    let mut rewritten = original.clone();
    // 受管地址进来时已经是 https，这里的失败只会被忽略并保持原样
    let _ = rewritten.set_host(Some(host));
    rewritten.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_only_pinned_huggingface_hosts() {
        let mirrored = rewrite_for(
            "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx",
            Source::Mirror,
        );
        assert_eq!(mirrored.source, Source::Mirror);
        assert_eq!(
            mirrored.url,
            "https://hf-mirror.com/briaai/RMBG-1.4/resolve/main/onnx/model.onnx"
        );

        let lfs = rewrite_for(
            "https://cdn-lfs.huggingface.co/repos/xx/yy/model.onnx",
            Source::Mirror,
        );
        assert_eq!(lfs.source, Source::Mirror);
        assert!(lfs.url.starts_with("https://hf-mirror.com/"));

        // 同一个地址选官方源时应保持不变
        let official = rewrite_for(
            "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx",
            Source::Official,
        );
        assert_eq!(official.source, Source::Official);
        assert_eq!(
            official.url,
            "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx"
        );
    }

    #[test]
    fn leaves_everything_else_untouched() {
        // 非 HF 域名、HF 的子域与伪装的父域、非 https、非 http(s) 协议，都不能被改写
        let untouched = [
            "https://example.com/model.onnx",
            "https://hf.huggingface.co/x/model.onnx",
            "https://huggingface.co.evil.test/x/model.onnx",
            "http://huggingface.co/x/model.onnx",
            "javascript:alert(1)",
            "file:///C:/secret/token",
        ];
        for raw in untouched {
            let resolved = rewrite_for(raw, Source::Mirror);
            assert_eq!(resolved.source, Source::Passthrough, "不应改写 {raw}");
            assert_eq!(resolved.url, raw, "URL 应原样返回: {raw}");
        }
    }

    #[test]
    fn keeps_path_query_and_normalizes_host_case() {
        let resolved = rewrite_for(
            "https://HuggingFace.co/OpenVoiceOS/sensevoice-small-onnx/resolve/main/vocab.txt?download=1",
            Source::Official,
        );
        assert_eq!(resolved.source, Source::Official);
        assert_eq!(
            resolved.url,
            "https://huggingface.co/OpenVoiceOS/sensevoice-small-onnx/resolve/main/vocab.txt?download=1"
        );
    }

    #[test]
    fn invalid_urls_are_passed_through_instead_of_rejected() {
        let resolved = rewrite_for("not a url at all", Source::Mirror);
        assert_eq!(resolved.source, Source::Passthrough);
        assert_eq!(resolved.url, "not a url at all");
    }

    #[test]
    fn alternate_only_flips_managed_sources() {
        assert_eq!(alternate(Source::Official), Some(Source::Mirror));
        assert_eq!(alternate(Source::Mirror), Some(Source::Official));
        assert_eq!(alternate(Source::Passthrough), None);
    }

    #[test]
    fn throughput_prefers_faster_sample() {
        let fast = (256 * 1024, Duration::from_millis(200));
        let slow = (256 * 1024, Duration::from_millis(2000));
        assert!(throughput(fast) > throughput(slow) * OFFICIAL_BIAS);
    }

    /// 唯一触碰全局缓存的用例：先探测并缓存，再确认后续调用直接命中缓存。
    /// 其余用例走 `rewrite_for`，不读写缓存，避免并行测试互相干扰。
    #[tokio::test]
    async fn resolve_probes_once_then_reuses_the_cache() {
        let runtime_url =
            "https://huggingface.co/OpenVoiceOS/sensevoice-small-onnx/resolve/main/vocab.txt";

        // 首次：走探测（可能访问网络，但只取 256KB 且有两个源的兜底）
        let first = resolve(runtime_url, None).await;
        let cached = read_cache().expect("首次解析后应写入缓存");

        // 第二次：命中缓存，URL 与首次一致
        let second = resolve(runtime_url, None).await;
        assert_eq!(second.source, cached);
        assert_eq!(second.url, first.url);

        // 显式翻转后，缓存与 URL 同步变化
        let flipped = alternate(cached).expect("受管源应可翻转");
        let retried = resolve(runtime_url, Some(flipped)).await;
        assert_eq!(retried.source, flipped);
        assert_ne!(retried.url, first.url);
        assert_eq!(read_cache(), Some(flipped));
    }

    #[tokio::test]
    async fn resolve_leaves_foreign_urls_alone_even_without_cache() {
        let resolved = resolve("https://example.com/model.onnx", None).await;
        assert_eq!(resolved.source, Source::Passthrough);
        assert_eq!(resolved.url, "https://example.com/model.onnx");
    }
}
