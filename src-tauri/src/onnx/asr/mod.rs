//! 本地语音转文本（SenseVoice Small，ONNX）。
//!
//! 模型来自 `OpenVoiceOS/sensevoice-small-onnx`，是 `FunAudioLLM/SenseVoiceSmall` 的
//! int8 量化导出（约 230 MB）。它的计算图已经把 LFR 叠帧、CMVN 和 4 帧 prompt 折进去了，
//! 图外只需要喂 80 维 log-mel 特征，输出直接是 CTC 的 log 概率。
//!
//! 图契约（`config.json` / 模型卡）：
//! - 输入 `features` f32 (B, T, 80)、`features_lens` i64 (B,)、`language` i64 (B,)、`textnorm` i64 (B,)
//! - 输出 `logprobs` f32 (B, ceil(T/6) + 4, 25055)
//! - 折叠后的前 4 个 token 是 prompt（语言 / 情绪 / 音频事件 / 是否 ITN），不是正文
//!
//! 推理在 `--onnx-worker` 子进程里跑，主进程只负责参数校验和进程管理，与超分、抠图一致。

mod audio;
mod features;
mod vocab;

pub use audio::{decode_to_mono_16k, TARGET_SAMPLE_RATE};
pub use vocab::Vocab;

/// 语言 id，与 `config.json` 的 `languages` 一致。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct LanguageId(i64);

impl LanguageId {
    pub const AUTO: LanguageId = LanguageId(0);
    pub const ZH: LanguageId = LanguageId(3);
    pub const EN: LanguageId = LanguageId(4);
    pub const YUE: LanguageId = LanguageId(7);
    pub const JA: LanguageId = LanguageId(11);
    pub const KO: LanguageId = LanguageId(12);

    /// 把用户可见的语言名转成模型 id；无法识别时按自动检测处理。
    pub fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim).unwrap_or_default().to_ascii_lowercase().as_str() {
            "zh" | "zh-cn" | "cmn" => Self::ZH,
            "en" | "en-us" => Self::EN,
            "yue" => Self::YUE,
            "ja" | "jp" => Self::JA,
            "ko" | "kr" => Self::KO,
            _ => Self::AUTO,
        }
    }

    pub fn value(self) -> i64 {
        self.0
    }
}

/// 是否做逆文本归一化，与 `config.json` 的 `textnorm` 一致。
/// 默认 `woitn`：模型的 parity 测试用的就是它，中文场景下不需要 ITN。
const TEXTNORM_WOITN: i64 = 15;

/// 单次送入模型的音频长度。
///
/// SenseVoice 编码器是自注意力结构，复杂度约 O(T²)。25 秒对应约 417 帧特征，
/// 一张图上百毫秒量级；再长就会明显变慢且显存吃紧，所以按窗口切片后逐段识别。
const CHUNK_SAMPLES: usize = 25 * TARGET_SAMPLE_RATE as usize;

/// 识别结果。
pub struct Transcription {
    pub text: String,
    /// 音频时长（秒），用于回传给前端展示
    pub duration_seconds: f32,
}

/// 解码本地音频 → 分块推理 → 拼接文本。
///
/// `on_progress(done, total)` 在每个分块结束后回调，供 Worker 发进度事件。
pub fn transcribe(
    session: &mut ort::session::Session,
    vocab: &Vocab,
    input_path: &std::path::Path,
    language: LanguageId,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<Transcription, String> {
    let wave = decode_to_mono_16k(input_path)?;
    let duration_seconds = wave.len() as f32 / TARGET_SAMPLE_RATE as f32;
    if wave.is_empty() {
        return Ok(Transcription {
            text: String::new(),
            duration_seconds: 0.0,
        });
    }

    let fbank = features::Fbank::new();
    let chunk_count = wave.len().div_ceil(CHUNK_SAMPLES).max(1);
    let mut text = String::new();

    for (index, chunk) in wave.chunks(CHUNK_SAMPLES).enumerate() {
        let frames = fbank.compute(chunk)?;
        let ids = recognize_chunk(session, &frames, language)?;
        let piece = vocab.decode(&ids);
        append_piece(&mut text, &piece);

        on_progress(index + 1, chunk_count);
        eprintln!(
            "[onnx-worker] 语音转文本 {}/{}（{} 帧特征，累计 {} 字）",
            index + 1,
            chunk_count,
            frames.len(),
            text.chars().count()
        );
    }

    Ok(Transcription {
        text: text.trim().to_string(),
        duration_seconds,
    })
}

/// 跑一段特征的 CTC 前向，返回逐帧 argmax 的 token id。
fn recognize_chunk(
    session: &mut ort::session::Session,
    frames: &[Vec<f32>],
    language: LanguageId,
) -> Result<Vec<i64>, String> {
    ensure_input_names(session)?;

    let frame_count = frames.len();
    let mel_count = frames.first().map(Vec::len).unwrap_or(features::N_MELS);
    let mut flat = Vec::with_capacity(frame_count * mel_count);
    for frame in frames {
        flat.extend_from_slice(frame);
    }

    let features_tensor = ort::value::Tensor::from_array((
        vec![1i64, frame_count as i64, mel_count as i64],
        flat,
    ))
    .map_err(|error| format!("构造 features 张量失败: {error}"))?;
    let lengths_tensor =
        ort::value::Tensor::from_array((vec![1i64], vec![frame_count as i64]))
            .map_err(|error| format!("构造 features_lens 张量失败: {error}"))?;
    let language_tensor = ort::value::Tensor::from_array((vec![1i64], vec![language.value()]))
        .map_err(|error| format!("构造 language 张量失败: {error}"))?;
    let textnorm_tensor = ort::value::Tensor::from_array((vec![1i64], vec![TEXTNORM_WOITN]))
        .map_err(|error| format!("构造 textnorm 张量失败: {error}"))?;

    let outputs = session
        .run(ort::inputs![
            "features" => features_tensor,
            "features_lens" => lengths_tensor,
            "language" => language_tensor,
            "textnorm" => textnorm_tensor
        ])
        .map_err(|error| format!("SenseVoice 推理失败: {error}"))?;

    let logprobs = outputs
        .get("logprobs")
        .ok_or_else(|| "推理结果缺少 logprobs 输出".to_string())?;
    let (shape, data) = logprobs
        .try_extract_tensor::<f32>()
        .map_err(|error| format!("提取 logprobs 失败: {error}"))?;

    if shape.len() != 3 {
        return Err(format!("logprobs 形状异常: {shape:?}"));
    }
    let time_steps = shape[1] as usize;
    let vocab_size = shape[2] as usize;
    if time_steps == 0 || vocab_size == 0 {
        return Ok(Vec::new());
    }
    if data.len() != time_steps * vocab_size {
        return Err(format!(
            "logprobs 数据长度 {} 与形状 {time_steps}×{vocab_size} 不符",
            data.len()
        ));
    }

    Ok(argmax(data, time_steps, vocab_size))
}

/// 逐帧取概率最大的 token id。logprobs 已经过 log_softmax，直接比大小即可。
fn argmax(data: &[f32], time_steps: usize, vocab_size: usize) -> Vec<i64> {
    (0..time_steps)
        .map(|step| {
            let offset = step * vocab_size;
            let mut best_index = 0usize;
            let mut best_value = data[offset];
            for index in 1..vocab_size {
                let value = data[offset + index];
                if value > best_value {
                    best_value = value;
                    best_index = index;
                }
            }
            best_index as i64
        })
        .collect()
}

/// 模型图的输入名是导出时钉死的，名字对不上说明拿错了模型文件。
fn ensure_input_names(session: &ort::session::Session) -> Result<(), String> {
    let names: Vec<String> = session
        .inputs()
        .iter()
        .map(|input| input.name().to_string())
        .collect();
    for required in ["features", "features_lens", "language", "textnorm"] {
        if !names.iter().any(|name| name == required) {
            return Err(format!(
                "模型输入缺少 '{required}'，这不是 SenseVoice 的 ONNX 导出（实际输入: {}）",
                names.join(", ")
            ));
        }
    }
    Ok(())
}

/// 拼接分块结果：两侧都是西文单词时补一个空格，中文直接相连。
fn append_piece(text: &mut String, piece: &str) {
    let piece = piece.trim();
    if piece.is_empty() {
        return;
    }
    if text.is_empty() {
        text.push_str(piece);
        return;
    }
    let left = text.chars().next_back().map(is_word_char).unwrap_or(false);
    let right = piece.chars().next().map(is_word_char).unwrap_or(false);
    if left && right {
        text.push(' ');
    }
    text.push_str(piece);
}

fn is_word_char(character: char) -> bool {
    character.is_ascii_alphanumeric()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_parsing_falls_back_to_auto() {
        assert_eq!(LanguageId::parse(Some("zh")), LanguageId::ZH);
        assert_eq!(LanguageId::parse(Some(" CMN ")), LanguageId::ZH);
        assert_eq!(LanguageId::parse(Some("ja")), LanguageId::JA);
        assert_eq!(LanguageId::parse(Some("ko")), LanguageId::KO);
        assert_eq!(LanguageId::parse(Some("yue")), LanguageId::YUE);
        assert_eq!(LanguageId::parse(Some("en-US")), LanguageId::EN);
        assert_eq!(LanguageId::parse(None), LanguageId::AUTO);
        assert_eq!(LanguageId::parse(Some("klingon")), LanguageId::AUTO);
    }

    #[test]
    fn argmax_picks_largest_value_per_frame() {
        // 2 帧 × 3 类
        let data = [0.1f32, 0.9, 0.2, -1.0, -0.5, -0.4];
        assert_eq!(argmax(&data, 2, 3), vec![1, 2]);
    }

    #[test]
    fn appending_pieces_keeps_chinese_tight_and_english_spaced() {
        let mut text = String::new();
        append_piece(&mut text, "这是第一块");
        append_piece(&mut text, "这是第二块");
        assert_eq!(text, "这是第一块这是第二块");

        let mut english = String::new();
        append_piece(&mut english, "hello world");
        append_piece(&mut english, "again");
        assert_eq!(english, "hello world again");

        let mut mixed = String::new();
        append_piece(&mut mixed, "中文");
        append_piece(&mut mixed, "abc");
        assert_eq!(mixed, "中文abc");
    }

    #[test]
    fn chunk_size_covers_25_seconds() {
        assert_eq!(CHUNK_SAMPLES, 25 * 16_000);
    }
}
