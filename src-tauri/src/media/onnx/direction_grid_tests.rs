use super::direction_grid::{compose_character_direction_grid_image, CHROMA_KEY_COLOR, DIRECTION_PLACEMENTS};
use super::*;

fn test_directory(name: &str) -> PathBuf {
    let unique = format!(
        "ai-canvas-onnx-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时间应晚于 UNIX epoch")
            .as_nanos()
    );
    let directory = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&directory).expect("应创建测试目录");
    directory
}

#[cfg(windows)]
fn spawn_exit_process(exit_code: i32) -> Child {
    Command::new("cmd")
        .args(["/C", &format!("exit {exit_code}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("应启动退出测试进程")
}

#[cfg(not(windows))]
fn spawn_exit_process(exit_code: i32) -> Child {
    Command::new("sh")
        .args(["-c", &format!("exit {exit_code}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("应启动退出测试进程")
}

#[cfg(windows)]
fn spawn_stalled_process() -> Child {
    Command::new("cmd")
        .args(["/C", "ping 127.0.0.1 -n 30 >NUL"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("应启动超时测试进程")
}

#[cfg(not(windows))]
fn spawn_stalled_process() -> Child {
    Command::new("sh")
        .args(["-c", "sleep 30"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("应启动超时测试进程")
}

#[test]
fn direction_mapping_matches_confirmed_layout() {
    let source_indices = DIRECTION_PLACEMENTS.map(|placement| placement.source_index);
    let mirror_flags = DIRECTION_PLACEMENTS.map(|placement| placement.mirror);

    assert_eq!(source_indices, [5, 3, 5, 1, 0, 1, 4, 2, 4]);
    assert_eq!(
        mirror_flags,
        [false, false, true, true, false, false, false, false, true]
    );
}

#[test]
fn validates_model_name_and_rejects_html_payload() {
    assert!(validate_model_name("rmbg-1.4.onnx").is_ok());
    assert!(validate_model_name("../rmbg-1.4.onnx").is_err());
    assert!(validate_model_name("rmbg-1.4.bin").is_err());
    assert!(validate_model_name("nested/model.onnx").is_err());

    // 辅助文件只允许逐个登记过的名字
    assert!(validate_model_name("sensevoice-vocab.txt").is_ok());
    assert!(validate_model_name("sensevoice-tokens.txt").is_err());
    assert!(validate_model_name("../../secrets/mcp/token").is_err());

    let directory = test_directory("validation");
    let model_path = directory.join("model.onnx");
    std::fs::write(&model_path, b"<!doctype html><html>not a model</html>")
        .expect("应写入测试文件");
    assert!(validate_onnx_file(&model_path, None)
        .expect_err("HTML 内容应被拒绝")
        .contains("HTML"));
    std::fs::remove_dir_all(directory).expect("应清理测试目录");
}

#[test]
fn speech_models_use_pinned_official_urls_and_complete_digests() {
    let manifest: Value = serde_json::from_str(include_str!("../../../../src/constants/localSpeechModels.json")).unwrap();
    let revision = manifest["revision"].as_str().unwrap();
    assert_eq!(revision.len(), 40);
    assert_eq!(manifest["assets"].as_array().unwrap().len(), 2);
    for name in ["sensevoice-small-int8.onnx", "sensevoice-vocab.txt"] {
        let asset = speech_model_asset(name).unwrap();
        assert!(asset.url.starts_with("https://huggingface.co/OpenVoiceOS/sensevoice-small-onnx/resolve/"));
        assert!(asset.url.contains(&format!("/resolve/{revision}/")));
        assert!(!asset.url.contains("/main/"));
        assert!(asset.bytes > 0);
        assert_eq!(asset.sha256.len(), 64);
        assert!(asset.sha256.bytes().all(|value| value.is_ascii_hexdigit()));
        assert!(validate_speech_model_url(asset, &asset.url).is_ok());
        assert!(validate_speech_model_url(asset, "https://example.test/model.onnx").is_err());
    }
}

#[test]
fn two_failed_sources_keep_both_safe_reasons_within_display_limit() {
    use crate::model_mirror::Source;
    let message = model_source_failures(
        Source::Mirror, "模型下载返回 HTTP 503",
        Source::Official, "模型文件校验失败，请检查模型下载来源",
    );
    assert!(message.contains("国内镜像失败：模型下载返回 HTTP 503"));
    assert!(message.contains("官方源失败：模型文件校验失败"));
    let long = "网络异常🌐".repeat(500);
    let message = model_source_failures(Source::Official, &long, Source::Mirror, &long);
    assert!(format!("语音模型下载失败：{message}").encode_utf16().count() <= 400);
}

#[test]
fn speech_cache_requires_exact_bytes_and_sha256_before_reuse() {
    let directory = test_directory("speech-integrity");
    let path = directory.join("speech.onnx");
    let asset = SpeechModelAsset {
        name: "test.onnx".into(), url: "https://example.test/test.onnx".into(),
        bytes: 4, sha256: format!("{:x}", Sha256::digest(b"good")),
    };
    assert_eq!(verified_speech_model_size(&path, &asset, None, None).unwrap(), None);
    std::fs::write(&path, b"good").unwrap();
    assert_eq!(verified_speech_model_size(&path, &asset, None, None).unwrap(), Some(4));
    assert_eq!(verified_speech_model_size(&path, &asset, Some("text/html"), None).unwrap(), None);
    std::fs::write(&path, b"bad!").unwrap();
    assert_eq!(verified_speech_model_size(&path, &asset, None, None).unwrap(), None);
    std::fs::write(&path, b"goo").unwrap();
    assert_eq!(verified_speech_model_size(&path, &asset, None, None).unwrap(), None);
    std::fs::write(&path, b"version https://git-lfs.github.com/spec/v1").unwrap();
    assert_eq!(verified_speech_model_size(&path, &asset, None, None).unwrap(), None);
    std::fs::write(&path, b"good").unwrap();
    let task_id = "speech-integrity-cancel";
    crate::file_transfer::cancel_file_transfer(task_id.into()).unwrap();
    assert_eq!(verified_speech_model_size(&path, &asset, None, Some(task_id)).unwrap_err(), "文件传输已取消");
    crate::file_transfer::clear_cancelled(task_id);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn managed_model_removal_rejects_unknown_names_and_directories() {
    let directory = test_directory("managed-removal");
    let model = directory.join("rmbg-1.4.onnx");
    let unrelated = directory.join("private.txt");
    std::fs::write(&model, b"model").expect("应写入模型文件");
    std::fs::write(&unrelated, b"private").expect("应写入无关文件");

    assert!(remove_managed_model(&directory, "../private.txt").is_err());
    assert!(remove_managed_model(&directory, "private.txt").is_err());
    assert!(unrelated.is_file());
    remove_managed_model(&directory, "rmbg-1.4.onnx").expect("应删除已登记模型");
    assert!(!model.exists());
    remove_managed_model(&directory, "rmbg-1.4.onnx").expect("重复删除应成功");

    std::fs::create_dir(&model).expect("应创建同名目录");
    assert!(remove_managed_model(&directory, "rmbg-1.4.onnx").is_err());
    assert!(model.is_dir());
    std::fs::remove_dir_all(directory).expect("应清理测试目录");
}

#[test]
fn reaps_normal_failed_and_timed_out_children_twenty_times_each() {
    for exit_code in [0, 7] {
        for _ in 0..20 {
            let mut child = spawn_exit_process(exit_code);
            reap_child(&mut child, WORKER_EXIT_GRACE);
            assert!(child.try_wait().expect("应读取退出状态").is_some());
        }
    }

    for _ in 0..20 {
        let mut child = spawn_stalled_process();
        reap_child(&mut child, Duration::from_millis(20));
        assert!(child.try_wait().expect("应读取退出状态").is_some());
    }
}

#[test]
fn worker_cleanup_does_not_block_async_runtime() {
    tauri::async_runtime::block_on(async {
        let cleanup = tauri::async_runtime::spawn_blocking(|| {
            let mut child = spawn_stalled_process();
            reap_child(&mut child, Duration::from_millis(500));
        });

        let started = Instant::now();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            started.elapsed() < Duration::from_millis(300),
            "阻塞回收不应占用 async runtime"
        );
        cleanup.await.expect("阻塞回收任务应完成");
    });
}

#[test]
fn composition_creates_three_by_three_transparent_grid() {
    let mut subject = image::RgbaImage::new(200, 300);
    let colors = [
        [220, 20, 20, 255],
        [20, 220, 20, 255],
        [20, 20, 220, 255],
        [220, 220, 20, 255],
        [220, 20, 220, 255],
        [20, 220, 220, 255],
    ];

    for (source_index, color) in colors.into_iter().enumerate() {
        let row = source_index / 2;
        let col = source_index % 2;
        for y in (row as u32 * 100 + 20)..(row as u32 * 100 + 80) {
            for x in (col as u32 * 100 + 20)..(col as u32 * 100 + 80) {
                subject.put_pixel(x, y, image::Rgba(color));
            }
        }
    }

    let grid = compose_character_direction_grid_image(&subject).expect("应成功合成宫格");
    assert_eq!(grid.dimensions(), (1536, 1536));
    assert_eq!(grid.get_pixel(0, 0)[3], 0);

    let expected_sources = [5usize, 3, 5, 1, 0, 1, 4, 2, 4];
    for (target_index, source_index) in expected_sources.into_iter().enumerate() {
        let row = target_index / 3;
        let col = target_index % 3;
        let pixel = grid.get_pixel(col as u32 * 512 + 256, row as u32 * 512 + 256);
        assert_eq!(pixel.0, colors[source_index]);
    }
}

/// 不做主体识别后源图整张不透明，仍应按 2×3 切图落到正确的 9 个格子
#[test]
fn composition_slices_opaque_source_without_matting() {
    let mut subject = image::RgbaImage::new(200, 300);
    // 都远离键控色，避免被抠底逻辑碰到，这里只验证切格
    let colors = [
        [220, 20, 20, 255],
        [120, 20, 220, 255],
        [20, 20, 220, 255],
        [220, 220, 20, 255],
        [220, 20, 220, 255],
        [20, 220, 220, 255],
    ];

    for (x, y, pixel) in subject.enumerate_pixels_mut() {
        let source_index = (y / 100 * 2 + x / 100) as usize;
        *pixel = image::Rgba(colors[source_index]);
    }

    let grid = compose_character_direction_grid_image(&subject).expect("应成功合成宫格");
    assert_eq!(grid.dimensions(), (1536, 1536));
    // 单元格 512、主体最长边 448，四角留白仍是透明的
    assert_eq!(grid.get_pixel(0, 0)[3], 0);

    let expected_sources = [5usize, 3, 5, 1, 0, 1, 4, 2, 4];
    for (target_index, source_index) in expected_sources.into_iter().enumerate() {
        let row = target_index / 3;
        let col = target_index % 3;
        let pixel = grid.get_pixel(col as u32 * 512 + 256, row as u32 * 512 + 256);
        assert_eq!(pixel.0, colors[source_index]);
    }
}

/// 键控底色被抠掉、主体被裁到边界；角色身上同为键控色的图案不连通边框，必须活下来
#[test]
fn chroma_key_removes_background_but_keeps_key_colored_island() {
    let key = [
        CHROMA_KEY_COLOR[0],
        CHROMA_KEY_COLOR[1],
        CHROMA_KEY_COLOR[2],
        255,
    ];
    let colors = [
        [220, 20, 20, 255],
        [120, 20, 220, 255],
        [20, 20, 220, 255],
        [220, 220, 20, 255],
        [220, 20, 220, 255],
        [20, 220, 220, 255],
    ];

    let mut subject = image::RgbaImage::from_pixel(200, 300, image::Rgba(key));
    for (source_index, subject_color) in colors.into_iter().enumerate() {
        let cell_x = (source_index as u32 % 2) * 100;
        let cell_y = (source_index as u32 / 2) * 100;
        // 30×30 主体，正中挖一块 10×10 的键控色图案（角色身上的绿）
        for y in 35..65u32 {
            for x in 35..65u32 {
                let inside_island = (45..55).contains(&x) && (45..55).contains(&y);
                let color = if inside_island { key } else { subject_color };
                subject.put_pixel(cell_x + x, cell_y + y, image::Rgba(color));
            }
        }
    }

    let grid = compose_character_direction_grid_image(&subject).expect("应成功合成宫格");
    let expected_sources = [5usize, 3, 5, 1, 0, 1, 4, 2, 4];
    for (target_index, source_index) in expected_sources.into_iter().enumerate() {
        let center_x = (target_index as u32 % 3) * 512 + 256;
        let center_y = (target_index as u32 / 3) * 512 + 256;

        // 主体中心那块键控色图案没被抠掉
        assert_eq!(grid.get_pixel(center_x, center_y).0, key);
        // 背景抠干净后主体被裁到 30×30 再放大，中心 +150 仍落在主体上
        // （取图案与主体边缘的中点，避开 Lanczos 放大在两侧边界的过渡带）
        assert_eq!(
            grid.get_pixel(center_x + 150, center_y).0,
            colors[source_index]
        );
        // 抠掉的背景不该跟着主体一起放大进格子
        assert_eq!(grid.get_pixel(center_x + 240, center_y)[3], 0);
    }
}
