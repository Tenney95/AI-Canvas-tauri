//! SenseVoice 词表与 CTC 贪心解码。
//!
//! 模型输出的是 `logprobs`（已经过 log_softmax），因此逐帧取 argmax 再折叠就是标准
//! CTC 贪心解码：合并相邻重复 → 去掉 blank。折叠后的前 4 个 token 是模型回吐的
//! prompt（`<|zh|>`、`<|NEUTRAL|>`、`<|Speech|>`、`<|woitn|>`），不是正文，需要丢掉。
//!
//! 词表是 SentencePiece 的 piece 列表，行号即 token id，词之间用 `▁`（U+2581）分隔。

use std::path::Path;

/// blank token 的 id，与 `config.json` 的 `blank_token_id` 一致。
pub const BLANK_ID: i64 = 0;

/// 正文前面的 prompt token 数量：语言、情绪、音频事件、是否做 ITN。
pub const PROMPT_TOKEN_COUNT: usize = 4;

/// 词表：`pieces[id]` 是第 id 个 token 的文本。
pub struct Vocab {
    pieces: Vec<String>,
}

impl Vocab {
    /// 读取词表文件。格式为每行 `<piece> <id>`，缺少 id 列时按行号推断。
    pub fn load(path: &Path) -> Result<Self, String> {
        let content = std::fs::read_to_string(path)
            .map_err(|error| format!("读取词表失败: {error}"))?;

        let mut pieces: Vec<(usize, String)> = Vec::new();
        for (line_index, line) in content.lines().enumerate() {
            let line = line.trim_end();
            if line.is_empty() {
                continue;
            }
            let (piece, declared_id) = match line.rsplit_once(' ') {
                Some((head, tail))
                    if !tail.is_empty() && tail.bytes().all(|byte| byte.is_ascii_digit()) =>
                {
                    (head, tail.parse::<usize>().ok())
                }
                _ => (line, None),
            };
            pieces.push((declared_id.unwrap_or(line_index), piece.to_string()));
        }

        if pieces.is_empty() {
            return Err("词表文件为空".to_string());
        }

        let mut sorted = pieces;
        sorted.sort_by_key(|(id, _)| *id);
        let max_id = sorted[sorted.len() - 1].0;
        if max_id >= sorted.len() * 4 {
            return Err(format!("词表 id 不连续（最大 id {max_id}），文件可能损坏"));
        }

        let mut indexed = vec![String::new(); max_id + 1];
        for (id, piece) in sorted {
            indexed[id] = piece;
        }
        Ok(Self { pieces: indexed })
    }

    pub fn piece(&self, id: i64) -> Option<&str> {
        if id < 0 {
            return None;
        }
        self.pieces.get(id as usize).map(String::as_str)
    }

    pub fn len(&self) -> usize {
        self.pieces.len()
    }

    /// 把模型输出的逐帧 argmax 结果解码成文本。
    pub fn decode(&self, frame_ids: &[i64]) -> String {
        let collapsed = collapse_ctc(frame_ids);

        // 折叠后的前 4 个 token 是 prompt；数量不足说明这段音频没识别出内容
        if collapsed.len() <= PROMPT_TOKEN_COUNT {
            return String::new();
        }

        let mut text = String::new();
        for id in collapsed.iter().skip(PROMPT_TOKEN_COUNT) {
            let piece = match self.piece(*id) {
                Some(piece) => piece,
                None => continue,
            };
            if is_special_token(piece) {
                continue;
            }
            text.push_str(piece);
        }

        normalize_pieces(&text)
    }
}

/// CTC 贪心折叠：合并相邻重复 token，再去掉 blank。
pub fn collapse_ctc(frame_ids: &[i64]) -> Vec<i64> {
    let mut deduped: Vec<i64> = Vec::with_capacity(frame_ids.len());
    for id in frame_ids {
        if deduped.last() == Some(id) {
            continue;
        }
        deduped.push(*id);
    }
    deduped
        .into_iter()
        .filter(|id| *id != BLANK_ID)
        .collect()
}

/// SentencePiece 还原：▁ 是词首空格，其余 piece 直接拼接。
fn normalize_pieces(text: &str) -> String {
    let joined: String = text
        .chars()
        .map(|character| if character == '\u{2581}' { ' ' } else { character })
        .collect();
    joined.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_special_token(piece: &str) -> bool {
    piece.starts_with("<|") && piece.ends_with("|>")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vocab_from(pieces: &[&str]) -> Vocab {
        Vocab {
            pieces: pieces.iter().map(|piece| piece.to_string()).collect(),
        }
    }

    #[test]
    fn collapse_merges_repeats_and_drops_blank() {
        // blank=0，重复帧合并，blank 分隔的相同 token 必须保留两份
        let frames = [0, 0, 5, 5, 5, 0, 5, 7, 7, 0];
        assert_eq!(collapse_ctc(&frames), vec![5, 5, 7]);
        assert!(collapse_ctc(&[0, 0, 0]).is_empty());
        assert_eq!(collapse_ctc(&[3]), vec![3]);
    }

    #[test]
    fn decode_drops_prompt_tokens_and_restores_spaces() {
        // 0=<blk> 1=<|zh|> ... 用一段最小词表模拟真实输出
        let vocab = vocab_from(&[
            "<blk>", "<|zh|>", "<|NEUTRAL|>", "<|Speech|>", "<|woitn|>",
        ]);
        // 只有 4 个 prompt，没有正文 → 空串
        assert_eq!(vocab.decode(&[0, 1, 1, 2, 2, 3, 3, 4, 0]), "");
    }

    #[test]
    fn decode_joins_chinese_without_spaces() {
        let vocab = vocab_from(&[
            "<blk>", "<|zh|>", "<|NEUTRAL|>", "<|Speech|>", "<|woitn|>", "这", "是", "测", "试",
        ]);
        let frames = [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 0];
        assert_eq!(vocab.decode(&frames), "这是测试");
    }

    #[test]
    fn decode_restores_sentencepiece_underscore_as_space() {
        let vocab = vocab_from(&[
            "<blk>", "<|en|>", "<|NEUTRAL|>", "<|Speech|>", "<|woitn|>", "▁hello", "▁world",
        ]);
        let frames = [1, 2, 3, 4, 5, 5, 6, 6];
        assert_eq!(vocab.decode(&frames), "hello world");
    }

    #[test]
    fn load_reads_piece_and_id_columns() {
        let directory = std::env::temp_dir().join(format!(
            "ai-canvas-asr-vocab-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("系统时间应晚于 UNIX epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).expect("应创建临时目录");
        let path = directory.join("vocab.txt");
        std::fs::write(&path, "<blk> 0\n<s> 1\n▁the 2\n</s> 3\n").expect("应写入词表");

        let vocab = Vocab::load(&path).expect("应加载词表");
        assert_eq!(vocab.len(), 4);
        assert_eq!(vocab.piece(0), Some("<blk>"));
        assert_eq!(vocab.piece(2), Some("▁the"));
        assert_eq!(vocab.piece(9), None);

        std::fs::remove_dir_all(&directory).expect("应清理临时目录");
    }

    #[test]
    fn load_rejects_empty_vocab() {
        let path = std::env::temp_dir().join(format!("ai-canvas-asr-empty-{}", std::process::id()));
        std::fs::write(&path, "\n\n").expect("应写入空词表");
        assert!(Vocab::load(&path).is_err());
        let _ = std::fs::remove_file(&path);
    }
}
