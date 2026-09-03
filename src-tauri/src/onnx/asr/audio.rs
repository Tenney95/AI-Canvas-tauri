//! 本地语音转文本：音频解码、声道合并与重采样。
//!
//! SenseVoice 只吃 16 kHz 单声道波形，本地素材却是 mp3 / wav / m4a / flac / ogg 都有可能，
//! 采样率也从 8 kHz 到 48 kHz 不等，因此解码后必须统一成 16 kHz 单声道。
//!
//! 重采样用的是带抗混叠的窗函数 sinc，不是线性插值：48 kHz → 16 kHz 直接线性插值会把
//! 16 kHz 以上的能量折回 0–8 kHz，正好压在 mel 频段里，识别率会明显下降。

use std::fs::File;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// 模型要求的采样率。
pub const TARGET_SAMPLE_RATE: u32 = 16_000;

/// 单次解码的时长上限。
///
/// 波形是 f32，20 分钟已经是 76 MB；再长下去内存没有意义，而且 SenseVoice 编码器是
/// 自注意力结构，长音频本来也必须切片后再逐段推理。
pub const MAX_AUDIO_SECONDS: f32 = 20.0 * 60.0;

/// 把本地音频文件解码成 16 kHz 单声道 f32 波形（归一化到 [-1, 1]）。
pub fn decode_to_mono_16k(path: &Path) -> Result<Vec<f32>, String> {
    let file = File::open(path).map_err(|e| format!("打开音频文件失败: {e}"))?;
    let source = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("无法识别音频格式，仅支持 mp3 / wav / m4a / flac / ogg: {e}"))?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .cloned()
        .ok_or_else(|| "音频文件里没有可解码的音轨".to_string())?;
    let track_id = track.id;

    let source_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| "音频缺少采样率信息".to_string())?;
    if source_rate == 0 {
        return Err("音频采样率为 0".to_string());
    }
    let channels = track
        .codec_params
        .channels
        .map(|channels| channels.count())
        .unwrap_or(1)
        .max(1);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("无法创建音频解码器: {e}"))?;

    let max_source_frames = (MAX_AUDIO_SECONDS * source_rate as f32) as u64;
    let mut mono: Vec<f32> = Vec::new();
    let mut decoded_frames = 0u64;
    let mut sample_buffer: Option<SampleBuffer<f32>> = None;
    let mut buffer_spec = (0u32, 0usize);

    loop {
        if decoded_frames >= max_source_frames {
            break;
        }

        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(error) => return Err(format!("读取音频数据包失败: {error}")),
        };
        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            // 单个坏帧不该让整段音频失败，跳过即可
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(error) => return Err(format!("解码音频失败: {error}")),
        };

        let spec = *decoded.spec();
        let frames = decoded.frames();
        if frames == 0 {
            continue;
        }
        let spec_key = (spec.rate, spec.channels.count());
        let reusable = sample_buffer
            .as_ref()
            .is_some_and(|buffer| buffer.capacity() >= frames && buffer_spec == spec_key);
        if !reusable {
            sample_buffer = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
            buffer_spec = spec_key;
        }
        let buffer = sample_buffer
            .as_mut()
            .ok_or_else(|| "音频采样缓冲区不可用".to_string())?;
        buffer.copy_interleaved_ref(decoded);
        let interleaved = buffer.samples();

        let remaining = (max_source_frames - decoded_frames) as usize;
        let take = frames.min(remaining);
        for frame in 0..take {
            let offset = frame * channels;
            let mut sum = 0f32;
            for channel in 0..channels {
                sum += interleaved[offset + channel];
            }
            mono.push(sum / channels as f32);
        }
        decoded_frames += take as u64;
    }

    if mono.is_empty() {
        return Err("没有从音频文件中解出任何采样".to_string());
    }

    if source_rate == TARGET_SAMPLE_RATE {
        Ok(mono)
    } else {
        Ok(resample(&mono, source_rate, TARGET_SAMPLE_RATE))
    }
}

/// 重采样到目标采样率；采样率相同时直接复制。
pub fn resample(input: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if source_rate == target_rate || input.is_empty() {
        return input.to_vec();
    }

    let ratio = source_rate as f64 / target_rate as f64;
    // 截止频率按输入采样率归一化：输出奈奎斯特频率对应 0.5 / ratio 周/输入采样
    let cutoff = (0.5 / ratio).min(0.5);
    // 抽取倍数越大，需要的核越长；16 是常用的折中档位
    let half_width = ((16.0 * ratio.max(1.0)).round() as usize).clamp(8, 64);

    let output_len = ((input.len() as f64 - 1.0) / ratio).floor() as usize + 1;
    let mut output = Vec::with_capacity(output_len);

    for index in 0..output_len {
        let center = index as f64 * ratio;
        let from = (center - half_width as f64).ceil().max(0.0) as usize;
        let to = (center + half_width as f64).floor() as usize + 1;
        let to = to.min(input.len());

        let mut weighted = 0f64;
        let mut total_weight = 0f64;
        for position in from..to {
            let distance = position as f64 - center;
            let normalized = distance / half_width as f64;
            if normalized.abs() > 1.0 {
                continue;
            }
            let weight = 2.0 * cutoff * sinc(2.0 * cutoff * distance)
                * blackman((normalized + 1.0) * 0.5);
            weighted += weight * f64::from(input[position]);
            total_weight += weight;
        }

        output.push(if total_weight.abs() > 1e-12 {
            (weighted / total_weight) as f32
        } else {
            0.0
        });
    }

    output
}

fn sinc(value: f64) -> f64 {
    if value.abs() < 1e-12 {
        1.0
    } else {
        let scaled = std::f64::consts::PI * value;
        scaled.sin() / scaled
    }
}

/// Blackman 窗，`position` 取值 0..=1（0 和 1 处为 0）。
fn blackman(position: f64) -> f64 {
    let tau = 2.0 * std::f64::consts::PI * position;
    0.42 - 0.5 * tau.cos() + 0.08 * (2.0 * tau).cos()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(sample_rate: u32, frequency: f32, seconds: f32) -> Vec<f32> {
        let len = (sample_rate as f32 * seconds) as usize;
        (0..len)
            .map(|i| (2.0 * std::f32::consts::PI * frequency * i as f32 / sample_rate as f32).sin())
            .collect()
    }

    #[test]
    fn resample_is_identity_when_rates_match() {
        let input = sine(16_000, 440.0, 0.1);
        let output = resample(&input, 16_000, 16_000);
        assert_eq!(output, input);
    }

    #[test]
    fn resample_preserves_signal_length_and_frequency() {
        // 48 kHz 的 1 kHz 正弦降到 16 kHz：长度变 1/3，仍是 1 kHz 正弦
        let input = sine(48_000, 1_000.0, 0.5);
        let output = resample(&input, 48_000, 16_000);
        assert!(
            (output.len() as i64 - (input.len() / 3) as i64).abs() <= 1,
            "重采样长度应为 1/3，实际 {} vs {}",
            output.len(),
            input.len()
        );

        // 与理想 1 kHz 正弦逐点比对；首尾各留 32 点避开窗截断
        let skip = 32;
        let mut worst = 0f32;
        for index in skip..(output.len() - skip) {
            let ideal =
                (2.0 * std::f32::consts::PI * 1_000.0 * index as f32 / 16_000.0).sin();
            worst = worst.max((output[index] - ideal).abs());
        }
        assert!(worst < 0.02, "重采样后波形偏差过大: {worst}");
    }

    #[test]
    fn resample_keeps_dc_level() {
        let input = vec![0.5f32; 4_800];
        let output = resample(&input, 48_000, 16_000);
        assert_eq!(output.len(), 1_600);
        for value in output.iter().skip(4).take(output.len() - 8) {
            assert!((value - 0.5).abs() < 0.01, "直流电平被破坏: {value}");
        }
    }

    #[test]
    fn blackman_window_is_zero_at_edges() {
        assert!(blackman(0.0).abs() < 1e-12);
        assert!(blackman(1.0).abs() < 1e-12);
        assert!((blackman(0.5) - 1.0).abs() < 1e-12);
    }
}
