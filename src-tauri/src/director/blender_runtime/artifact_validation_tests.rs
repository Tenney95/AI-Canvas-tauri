use super::*;

fn candidate(kind: BlenderResultArtifactKind, frame: Option<u64>) -> StagedArtifact {
    let hash = "a".repeat(64);
    let (start_frame, end_frame, fps) = match kind {
        BlenderResultArtifactKind::ReferenceVideo => {
            (Some(1), Some(24), serde_json::Number::from_f64(24.0))
        }
        _ => (None, None, None),
    };
    StagedArtifact {
        artifact_id: format!("{}-{hash}", artifact_prefix(kind)),
        kind,
        mime_type: kind.expected_mime_type().to_string(),
        staged_file_name: staged_file_name(kind).to_string(),
        sha256: hash,
        bytes: 64,
        frame,
        start_frame,
        end_frame,
        fps,
    }
}

fn collected_frame(frame: u64) -> BlenderResultArtifact {
    let hash = "a".repeat(64);
    BlenderResultArtifact {
        artifact_id: format!("frame-{hash}"),
        kind: BlenderResultArtifactKind::FrameImage,
        mime_type: "image/png".to_string(),
        relative_path: format!("director/scenes/scene/results/frame-{hash}-{hash}.png"),
        sha256: hash,
        bytes: 64,
        frame: Some(frame),
        start_frame: None,
        end_frame: None,
        fps: None,
    }
}

#[test]
fn existing_artifact_requires_matching_file_contents() {
    struct TestDirectory(PathBuf);

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be available")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "ai-canvas-blender-artifact-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir(&root).expect("test root should be created");
    let root = TestDirectory(root);

    let mut bytes = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1];
    let mut artifact = collected_frame(42);
    artifact.bytes = bytes.len() as u64;
    artifact.sha256 = format!("{:x}", Sha256::digest(bytes));
    artifact.relative_path = expected_artifact_relative_path("scene", &artifact);
    let path = join_project_relative(&root.0, &artifact.relative_path).unwrap();
    fs::create_dir_all(path.parent().unwrap()).expect("artifact directory should be created");
    assert!(verify_artifact_file(&root.0, &path, &artifact).is_err());

    fs::write(&path, bytes).expect("test artifact should be written");
    verify_artifact_file(&root.0, &path, &artifact).expect("matching artifact should validate");

    bytes[8] = 2;
    fs::write(&path, bytes).expect("test artifact should be updated");
    assert!(verify_artifact_file(&root.0, &path, &artifact).is_err());
}

#[test]
fn open_editor_requires_exactly_one_current_frame_and_one_blend() {
    let valid = [
        candidate(BlenderResultArtifactKind::FrameImage, Some(42)),
        candidate(BlenderResultArtifactKind::BlendProject, None),
    ];
    assert!(validate_operation_artifacts(
        BlenderJobOperation::OpenEditor,
        BlenderSceneSource::DirectorScene,
        None,
        &valid,
    )
    .is_ok());
    assert!(validate_operation_artifacts(
        BlenderJobOperation::OpenEditor,
        BlenderSceneSource::DirectorScene,
        Some(42),
        &valid,
    )
    .is_err());

    let missing_frame = [candidate(BlenderResultArtifactKind::BlendProject, None)];
    assert!(validate_operation_artifacts(
        BlenderJobOperation::OpenEditor,
        BlenderSceneSource::DirectorScene,
        None,
        &missing_frame,
    )
    .is_err());

    let duplicate_frame = [
        candidate(BlenderResultArtifactKind::FrameImage, Some(42)),
        candidate(BlenderResultArtifactKind::FrameImage, Some(42)),
        candidate(BlenderResultArtifactKind::BlendProject, None),
    ];
    assert!(validate_operation_artifacts(
        BlenderJobOperation::OpenEditor,
        BlenderSceneSource::DirectorScene,
        None,
        &duplicate_frame,
    )
    .is_err());

    let video_mixed_in = [
        candidate(BlenderResultArtifactKind::FrameImage, Some(42)),
        candidate(BlenderResultArtifactKind::BlendProject, None),
        candidate(BlenderResultArtifactKind::ReferenceVideo, None),
    ];
    assert!(validate_operation_artifacts(
        BlenderJobOperation::OpenEditor,
        BlenderSceneSource::DirectorScene,
        None,
        &video_mixed_in,
    )
    .is_err());
}

#[test]
fn render_frame_remains_bound_to_the_requested_frame() {
    let valid = [
        candidate(BlenderResultArtifactKind::FrameImage, Some(42)),
        candidate(BlenderResultArtifactKind::BlendProject, None),
    ];
    assert!(validate_operation_artifacts(
        BlenderJobOperation::RenderFrame,
        BlenderSceneSource::DirectorScene,
        Some(42),
        &valid,
    )
    .is_ok());
    assert!(validate_operation_artifacts(
        BlenderJobOperation::RenderFrame,
        BlenderSceneSource::DirectorScene,
        Some(41),
        &valid,
    )
    .is_err());
    assert!(validate_operation_artifacts(
        BlenderJobOperation::RenderFrame,
        BlenderSceneSource::DirectorScene,
        None,
        &valid,
    )
    .is_err());
}

#[test]
fn saved_scene_frames_allow_current_frame_but_still_bind_explicit_targets() {
    let valid = [
        candidate(BlenderResultArtifactKind::FrameImage, Some(185)),
        candidate(BlenderResultArtifactKind::BlendProject, None),
    ];
    assert!(validate_operation_artifacts(
        BlenderJobOperation::RenderFrame,
        BlenderSceneSource::SavedBlender,
        None,
        &valid
    )
    .is_ok());
    assert!(validate_operation_artifacts(
        BlenderJobOperation::RenderFrame,
        BlenderSceneSource::SavedBlender,
        Some(42),
        &valid
    )
    .is_err());
    let invalid = [
        candidate(BlenderResultArtifactKind::FrameImage, None),
        candidate(BlenderResultArtifactKind::BlendProject, None),
    ];
    assert!(validate_operation_artifacts(
        BlenderJobOperation::RenderFrame,
        BlenderSceneSource::SavedBlender,
        None,
        &invalid
    )
    .is_err());
}

#[test]
fn saved_scene_video_checks_duration_and_frame_limits_using_actual_fps() {
    for (end, fps, accepted) in [
        (14399, 24.0, true),
        (14400, 240.0, false),
        (600, 1.0, false),
        (299, 30.0 / 1.001, true),
        (299, 241.0, false),
    ] {
        let mut video = candidate(BlenderResultArtifactKind::ReferenceVideo, None);
        video.start_frame = Some(0);
        video.end_frame = Some(end);
        video.fps = serde_json::Number::from_f64(fps);
        let artifacts = [
            video,
            candidate(BlenderResultArtifactKind::BlendProject, None),
        ];
        assert_eq!(
            validate_operation_artifacts(
                BlenderJobOperation::RenderVideo,
                BlenderSceneSource::SavedBlender,
                None,
                &artifacts
            )
            .is_ok(),
            accepted
        );
    }
}

#[test]
fn repeated_identical_frame_moves_the_current_metadata_to_the_end() {
    let repeated = collected_frame(42);
    let mut artifacts = vec![
        repeated.clone(),
        BlenderResultArtifact {
            artifact_id: format!("blend-{}", "b".repeat(64)),
            kind: BlenderResultArtifactKind::BlendProject,
            mime_type: "application/x-blender".to_string(),
            relative_path: "director/scenes/scene/results/project.blend".to_string(),
            sha256: "b".repeat(64),
            bytes: 64,
            frame: None,
            start_frame: None,
            end_frame: None,
            fps: None,
        },
    ];
    let current = BlenderResultArtifact {
        frame: Some(84),
        ..repeated
    };

    append_latest_artifact(&mut artifacts, current.clone());

    assert_eq!(artifacts.len(), 2);
    assert_eq!(artifacts.last(), Some(&current));
}
