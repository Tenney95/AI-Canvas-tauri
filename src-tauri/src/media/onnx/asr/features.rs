//! SenseVoice 的 wespeaker log-mel 滤波器组特征提取。
//!
//! onnx-asr 导出的 SenseVoiceSmall（`OpenVoiceOS/sensevoice-small-onnx`）把 LFR 叠帧与
//! CMVN 都折进了计算图，图外只需要算 kaldi 风格的 fbank，因此这里的实现必须和
//! `WespeakerPreprocessor` 逐位对齐：
//!
//! - 帧长 400、帧移 160、FFT 512，snip_edges=true（不补边）
//! - Hamming 窗（`np.hamming`，不是 povey 窗）
//! - 逐帧去直流 → 预加重 0.97 → 加窗
//! - mel 刻度用 kaldi 公式 `1127 * ln(1 + f/700)`，20 Hz – 8000 Hz，80 个滤波器
//! - 能量取 `log(max(x, f32::EPSILON))`，没有 slaney 归一化
//!
//! 参数改动会直接让识别结果变成乱码，改之前先看 `config.json` 里的 `preprocessor` 字段。

pub const SAMPLE_RATE: u32 = 16_000;
pub const N_MELS: usize = 80;

const N_FFT: usize = 512;
const WIN_LENGTH: usize = 400;
const HOP_LENGTH: usize = 160;
const F_MIN: f32 = 20.0;
const PREEMPHASIS: f32 = 0.97;
/// `float(np.finfo(np.float32).eps)`，log 前的下限
const FLOAT_EPS: f32 = f32::EPSILON;

/// 预计算好的 Hamming 窗 + mel 滤波器组，跨帧复用。
pub struct Fbank {
    window: Vec<f32>,
    filters: Vec<MelFilter>,
}

struct MelFilter {
    /// 能量谱 bin 的下界（含）
    start: usize,
    /// mel 滤波器权重，对应 `power[start..start + weights.len()]`
    weights: Vec<f32>,
}

impl Default for Fbank {
    fn default() -> Self {
        Self::new()
    }
}

impl Fbank {
    pub fn new() -> Self {
        Self {
            window: hamming(WIN_LENGTH),
            filters: build_mel_filters(),
        }
    }

    /// 计算 log-mel 滤波器组特征，返回 `[帧数][80]`。
    pub fn compute(&self, samples: &[f32]) -> Result<Vec<Vec<f32>>, String> {
        if samples.len() < WIN_LENGTH {
            return Err(format!(
                "音频太短（{} 采样），至少需要 {} 采样（25 毫秒）",
                samples.len(),
                WIN_LENGTH
            ));
        }

        let frames = 1 + (samples.len() - WIN_LENGTH) / HOP_LENGTH;
        let mut real = vec![0f32; N_FFT];
        let mut imag = vec![0f32; N_FFT];
        let mut output = Vec::with_capacity(frames);

        for frame in 0..frames {
            let start = frame * HOP_LENGTH;
            self.fill_spectrum(&samples[start..start + WIN_LENGTH], &mut real, &mut imag)?;
            output.push(self.apply_filters(&real, &imag));
        }

        Ok(output)
    }

    /// 去直流 → 预加重 → 加窗 → 512 点实数 FFT，结果写入功率谱的实部/虚部。
    fn fill_spectrum(
        &self,
        frame: &[f32],
        real: &mut [f32],
        imag: &mut [f32],
    ) -> Result<(), String> {
        let mean = frame.iter().map(|value| f64::from(*value)).sum::<f64>() / WIN_LENGTH as f64;

        let mut previous = f64::from(frame[0]) - mean;
        let mut windowed = [0f32; WIN_LENGTH];
        windowed[0] = (previous * (1.0 - f64::from(PREEMPHASIS))) as f32;
        for index in 1..WIN_LENGTH {
            let current = f64::from(frame[index]) - mean;
            windowed[index] = (current - f64::from(PREEMPHASIS) * previous) as f32;
            previous = current;
        }
        for (value, weight) in windowed.iter_mut().zip(self.window.iter()) {
            *value *= *weight;
        }

        real.fill(0.0);
        imag.fill(0.0);
        real[..WIN_LENGTH].copy_from_slice(&windowed);
        fft(real, imag)
    }

    fn apply_filters(&self, real: &[f32], imag: &[f32]) -> Vec<f32> {
        let mut mels = vec![0f32; N_MELS];
        for (index, filter) in self.filters.iter().enumerate() {
            let mut energy = 0f64;
            for (offset, weight) in filter.weights.iter().enumerate() {
                if *weight == 0.0 {
                    continue;
                }
                let bin = filter.start + offset;
                let re = f64::from(real[bin]);
                let im = f64::from(imag[bin]);
                energy += (re * re + im * im) * f64::from(*weight);
            }
            mels[index] = (energy as f32).max(FLOAT_EPS).ln();
        }
        mels
    }
}

/// `np.hamming(n)`：0.54 - 0.46 * cos(2πi/(n-1))，按 float64 计算后转 f32。
pub fn hamming(length: usize) -> Vec<f32> {
    if length == 0 {
        return Vec::new();
    }
    if length == 1 {
        return vec![1.0];
    }
    let denominator = (length - 1) as f64;
    (0..length)
        .map(|index| {
            let radians = 2.0 * std::f64::consts::PI * index as f64 / denominator;
            (0.54 - 0.46 * radians.cos()) as f32
        })
        .collect()
}

/// kaldi mel 刻度：1127 * ln(1 + f / 700)
fn hz_to_mel(frequency: f64) -> f64 {
    1127.0 * (1.0 + frequency / 700.0).ln()
}

/// 三角 mel 滤波器组，对应 `melscale_fbanks(257, 20, 0, 80, 16000, mel_scale="kaldi")`。
///
/// `f_max = 0` 在 onnx-asr 里等价于 `+ sample_rate / 2`，也就是 8000 Hz。
fn build_mel_filters() -> Vec<MelFilter> {
    let bins = N_FFT / 2 + 1;
    let f_max = f64::from(SAMPLE_RATE) / 2.0;

    // np.linspace(0, sample_rate // 2, bins)
    let all_freqs: Vec<f64> = (0..bins)
        .map(|index| f_max * index as f64 / (bins - 1) as f64)
        .collect();

    let m_min = hz_to_mel(f64::from(F_MIN));
    let m_max = hz_to_mel(f_max);
    let points: Vec<f64> = (0..=(N_MELS + 1))
        .map(|index| m_min + (m_max - m_min) * index as f64 / (N_MELS + 1) as f64)
        .collect();

    let mut matrix = vec![0f64; bins * N_MELS];
    for (bin, frequency) in all_freqs.iter().enumerate() {
        let mel = hz_to_mel(*frequency);
        for index in 0..N_MELS {
            let up = (mel - points[index]) / (points[index + 1] - points[index]);
            let down = (points[index + 2] - mel) / (points[index + 2] - points[index + 1]);
            matrix[bin * N_MELS + index] = up.min(down).max(0.0);
        }
    }

    (0..N_MELS)
        .map(|index| {
            let weights: Vec<f32> = (0..bins)
                .map(|bin| matrix[bin * N_MELS + index] as f32)
                .collect();
            let start = weights.iter().position(|w| *w > 0.0).unwrap_or(0);
            let end = weights
                .iter()
                .rposition(|w| *w > 0.0)
                .map(|position| position + 1)
                .unwrap_or(0);
            MelFilter {
                start,
                weights: weights[start..end].to_vec(),
            }
        })
        .collect()
}

/// 原地基 2 Cooley–Tukey FFT，长度必须是 2 的幂。
pub fn fft(real: &mut [f32], imag: &mut [f32]) -> Result<(), String> {
    let length = real.len();
    if !length.is_power_of_two() {
        return Err(format!("FFT 长度必须是 2 的幂，实际 {length}"));
    }
    if imag.len() != length {
        return Err("FFT 实部与虚部长度不一致".to_string());
    }
    if length <= 1 {
        return Ok(());
    }

    let mut reversed = 0usize;
    for index in 1..length {
        let mut bit = length >> 1;
        while reversed & bit != 0 {
            reversed ^= bit;
            bit >>= 1;
        }
        reversed |= bit;
        if index < reversed {
            real.swap(index, reversed);
            imag.swap(index, reversed);
        }
    }

    let mut size = 2usize;
    while size <= length {
        let half = size / 2;
        let step = -2.0 * std::f64::consts::PI / size as f64;
        let mut base = 0usize;
        while base < length {
            for k in 0..half {
                let angle = step * k as f64;
                let cos = angle.cos() as f32;
                let sin = angle.sin() as f32;

                let (left_re, left_im) = (real[base + k], imag[base + k]);
                let (right_re, right_im) = (real[base + k + half], imag[base + k + half]);
                let twiddled_re = right_re * cos - right_im * sin;
                let twiddled_im = right_re * sin + right_im * cos;

                real[base + k] = left_re + twiddled_re;
                imag[base + k] = left_im + twiddled_im;
                real[base + k + half] = left_re - twiddled_re;
                imag[base + k + half] = left_im - twiddled_im;
            }
            base += size;
        }
        size <<= 1;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// numpy 参考值：`np.abs(np.fft.rfft(x, 512)) ** 2` 的前 4 个 bin。
    /// 输入是 `0.001 * (i % 7)` 的确定性序列，长度 512（不足补零）。
    const REFERENCE_POWER: [f32; 4] = [1.432_809_1e0, 9.767_316_3e-2, 5.782_425_4e-2, 2.029_831e-2];

    /// 与 numpy 参考脚本逐位一致的确定性波形，用于端到端比对 fbank。
    fn reference_wave(length: usize) -> Vec<f32> {
        (0..length)
            .map(|index| {
                let value = (index as u64 * 1_103_515_245 + 12_345) % 100_003;
                (value as f64 / 100_003.0 - 0.5) as f32
            })
            .collect()
    }

    #[test]
    fn fft_matches_numpy_rfft_power() {
        let mut real = vec![0f32; N_FFT];
        let mut imag = vec![0f32; N_FFT];
        for index in 0..WIN_LENGTH {
            real[index] = 0.001 * ((index % 7) as f32);
        }
        fft(&mut real, &mut imag).expect("FFT 应成功");

        for (bin, expected) in REFERENCE_POWER.iter().enumerate() {
            let power = real[bin] * real[bin] + imag[bin] * imag[bin];
            // f32 FFT 相对误差约 1e-7，按数量级放宽
            let tolerance = 1e-6_f32.max(expected.abs() * 1e-5);
            assert!(
                (power - expected).abs() < tolerance,
                "bin {bin} 功率谱 {power} 与 numpy 参考 {expected} 不一致"
            );
        }
    }

    #[test]
    fn fft_obeys_parseval_theorem() {
        let mut real = vec![0f32; 64];
        let mut imag = vec![0f32; 64];
        for index in 0..64 {
            real[index] = ((index * 37 % 13) as f32) / 13.0 - 0.5;
        }
        let time_energy: f64 = real.iter().map(|value| f64::from(*value).powi(2)).sum();
        fft(&mut real, &mut imag).expect("FFT 应成功");

        let spectral_energy: f64 = real
            .iter()
            .zip(imag.iter())
            .map(|(re, im)| f64::from(*re).powi(2) + f64::from(*im).powi(2))
            .sum();
        let expected = time_energy * 64.0;
        assert!(
            (spectral_energy - expected).abs() / expected < 1e-4,
            "Parseval 不成立: {spectral_energy} vs {expected}"
        );
    }

    #[test]
    fn fft_rejects_non_power_of_two() {
        let mut real = vec![0f32; 6];
        let mut imag = vec![0f32; 6];
        assert!(fft(&mut real, &mut imag).is_err());
    }

    #[test]
    fn hamming_matches_numpy() {
        let window = hamming(5);
        // np.hamming(5) = [0.08, 0.54, 1.0, 0.54, 0.08]
        let expected = [0.08f32, 0.54, 1.0, 0.54, 0.08];
        for (index, value) in expected.iter().enumerate() {
            assert!(
                (window[index] - value).abs() < 1e-6,
                "hamming[{index}]={} 期望 {value}",
                window[index]
            );
        }
        assert_eq!(hamming(1), vec![1.0]);
        assert!(hamming(0).is_empty());
    }

    /// 与 numpy `melscale_fbanks(257, 20, 0, 80, 16000, mel_scale="kaldi")` 对齐。
    #[test]
    fn mel_filters_match_numpy_reference() {
        let filters = build_mel_filters();
        assert_eq!(filters.len(), N_MELS);

        // 整个 257×80 矩阵的元素和
        let total: f64 = filters
            .iter()
            .flat_map(|filter| filter.weights.iter())
            .map(|weight| f64::from(*weight))
            .sum();
        assert!(
            (total - 250.750_821_537_338_2).abs() < 1e-3,
            "mel 滤波器组总和 {total} 与 numpy 参考不一致"
        );

        // (mel 下标, 起始 bin, 权重个数, 前三/全部权重)
        let expected: [(usize, usize, usize, &[f32]); 5] = [
            (0, 1, 2, &[0.503_983_3, 0.135_723_37]),
            (1, 2, 1, &[0.864_276_65]),
            (39, 55, 4, &[0.389_631_33, 0.806_919_1, 0.781_082_15]),
            (78, 232, 16, &[0.069_524_26, 0.197_049_99, 0.324_077_37]),
            (79, 240, 16, &[0.075_990_67, 0.199_635_8, 0.322_812_4]),
        ];
        for (index, start, len, head) in expected {
            let filter = &filters[index];
            assert_eq!(filter.start, start, "滤波器 {index} 起始 bin 不符");
            assert_eq!(filter.weights.len(), len, "滤波器 {index} 长度不符");
            for (offset, value) in head.iter().enumerate() {
                assert!(
                    (filter.weights[offset] - value).abs() < 1e-6,
                    "滤波器 {index} 第 {offset} 个权重 {} 与参考 {value} 不符",
                    filter.weights[offset]
                );
            }
        }

        // 滤波器中心频率单调上升，否则 mel 刻度算错了
        let centers: Vec<usize> = filters
            .iter()
            .map(|filter| {
                filter.start
                    + filter
                        .weights
                        .iter()
                        .enumerate()
                        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
                        .map(|(offset, _)| offset)
                        .unwrap_or(0)
            })
            .collect();
        for pair in centers.windows(2) {
            assert!(pair[0] <= pair[1], "mel 滤波器中心频率非单调");
        }
    }

    /// 端到端比对：1 秒确定性波形 → 98 帧 × 80 维，与 numpy 参考逐项比对。
    #[test]
    fn fbank_matches_numpy_reference() {
        let fbank = Fbank::new();
        let features = fbank
            .compute(&reference_wave(16_000))
            .expect("fbank 应成功");
        assert_eq!(features.len(), 98);
        assert_eq!(features[0].len(), N_MELS);

        // (帧号, [mel 0, mel 1, mel 39, mel 78, mel 79])
        let expected: [(usize, [f32; 5]); 3] = [
            (0, [-6.707_268, -9.016_728, 2.592_675, 6.579_19, 1.065_419]),
            (1, [-8.119_512, -9.770_013, 2.585_225, 6.578_559, 0.977_836]),
            (50, [-6.900_775, -6.837_882, 2.588_742, 6.578_527, 0.979_708]),
        ];
        for (frame, values) in expected {
            for (mel, value) in values.iter().enumerate() {
                let index = [0usize, 1, 39, 78, 79][mel];
                assert!(
                    (features[frame][index] - value).abs() < 5e-3,
                    "frame {frame} mel {index}: {} 与参考 {value} 不一致",
                    features[frame][index]
                );
            }
        }

        let checksum: f64 = features[0]
            .iter()
            .enumerate()
            .map(|(index, value)| f64::from(*value) * (index as f64 + 1.0))
            .sum();
        assert!(
            (checksum - 1_266.743_764_638_900_8).abs() < 0.5,
            "frame 0 加权校验和 {checksum} 与参考不一致"
        );
    }

    #[test]
    fn fbank_frame_count_follows_snip_edges() {
        let fbank = Fbank::new();
        // 400 采样 → 1 帧；多出 160 采样 → 2 帧
        assert_eq!(fbank.compute(&vec![0.1f32; 400]).unwrap().len(), 1);
        assert_eq!(fbank.compute(&vec![0.1f32; 560]).unwrap().len(), 2);
        assert_eq!(fbank.compute(&vec![0.1f32; 559]).unwrap().len(), 1);

        let features = fbank.compute(&vec![0.1f32; 400]).unwrap();
        assert_eq!(features[0].len(), N_MELS);
        // 全零（去直流后）信号的 mel 能量被夹在 eps 上，取 log 后是同一个常数
        let floor = FLOAT_EPS.ln();
        for value in &features[0] {
            assert!((value - floor).abs() < 1e-6, "静音帧应落在 log(eps) 上");
        }
    }

    #[test]
    fn fbank_rejects_short_audio() {
        let fbank = Fbank::new();
        assert!(fbank.compute(&vec![0f32; 399]).is_err());
    }
}
