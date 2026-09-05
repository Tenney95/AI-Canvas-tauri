"""Fixed-job contract tests. Uses in-memory bpy doubles; never starts Blender."""

import importlib.util
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch


SCRIPT = Path(__file__).resolve().parents[2] / "src-tauri/resources/blender-runtime/v1/jobs/ai_canvas_director_job_v1.py"
bpy = ModuleType("bpy")
mathutils = ModuleType("mathutils")
mathutils.Vector = object
with patch.dict(sys.modules, {"bpy": bpy, "mathutils": mathutils}):
    spec = importlib.util.spec_from_file_location("director_fixed_job", SCRIPT)
    job = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(job)


class Camera(SimpleNamespace):
    def get(self, key):
        return getattr(self, key, None)


class Objects(list):
    def get(self, name):
        return next((obj for obj in self if obj.name == name), None)


class Markers(list):
    def new(self, name, frame):
        marker = SimpleNamespace(name=name, frame=frame, camera=None)
        self.append(marker)
        return marker


class Scene(SimpleNamespace):
    def get(self, key):
        return self.properties.get(key)

    def frame_set(self, frame):
        self.frame_current = frame
        self.frames_set.append(frame)


class MemoryPath:
    def __init__(self, name="test-job"):
        self.name = name

    def __truediv__(self, child):
        return MemoryPath(child)

    def __str__(self):
        return self.name

    def is_symlink(self):
        return False

    def exists(self):
        return True

    def is_file(self):
        return True

    def is_dir(self):
        return True

    def iterdir(self):
        return iter(())

    def stat(self):
        return SimpleNamespace(st_size=12)


def request(operation="render-video", source="saved-blender", frame=None):
    return {
        "schemaVersion": 1, "protocol": job.PROTOCOL, "jobId": "job-1",
        "operation": operation, "sceneSource": source,
        "sceneId": "scene-1", "sceneRevision": 1, "sceneSha256": "a" * 64,
        "manifestRevision": 2, "targetFrame": frame,
        "baseBlend": {"stagedFileName": "base.blend", "sha256": "a" * 64, "bytes": 12},
    }


class SavedBlenderSceneTests(unittest.TestCase):
    def setUp(self):
        self.camera = Camera(name="Artist Camera", type="CAMERA")
        self.second = Camera(name="Closeup Camera", type="CAMERA")
        self.markers = Markers([
            SimpleNamespace(name="Artist cut", frame=160, camera=self.second),
            SimpleNamespace(name="Note", frame=130, camera=None),
        ])
        self.scene = Scene(
            frame_start=100, frame_end=399, frame_current=185, frame_step=1,
            camera=self.camera, objects=Objects([self.camera, self.second]),
            timeline_markers=self.markers, frames_set=[],
            render=SimpleNamespace(fps=30, fps_base=1.001, resolution_x=1920,
                resolution_y=1080, resolution_percentage=100,
                image_settings=SimpleNamespace(file_format="PNG", media_type="IMAGE"),
                ffmpeg=SimpleNamespace()),
            properties={"ai_canvas_scene_id": "scene-1", "ai_canvas_scene_revision": 1,
                "ai_canvas_scene_sha256": "a" * 64, "ai_canvas_adapter_version": job.ADAPTER_VERSION,
                "ai_canvas_template_id": job.EXPECTED_TEMPLATE_ID,
                "ai_canvas_template_version": job.EXPECTED_TEMPLATE_VERSION},
        )
        self.portable = {"startFrame": 1, "endFrame": 120, "fps": 24,
            "cameras": [{"cameraId": "camera-1"}], "shots": []}
        bpy.context = SimpleNamespace(scene=self.scene,
            preferences=SimpleNamespace(filepaths=SimpleNamespace(save_version=1)))
        bpy.app = SimpleNamespace(version=job.EXPECTED_BLENDER_VERSION,
            version_string="5.2.1", driver_namespace={})
        bpy.ops = SimpleNamespace(
            wm=SimpleNamespace(open_mainfile=Mock(return_value={"FINISHED"}),
                save_as_mainfile=Mock(return_value={"FINISHED"})),
            render=SimpleNamespace(render=Mock(return_value={"FINISHED"})),
        )

    def configure(self, operation="render-video", frame=None):
        return job._configure_job_scene(self.scene, {}, [], self.portable,
            request(operation, frame=frame))

    def test_saved_video_preserves_timeline_fractional_fps_and_camera_markers(self):
        target, fps = self.configure()
        self.assertEqual((self.scene.frame_start, self.scene.frame_end), (100, 399))
        self.assertEqual((self.scene.render.fps, self.scene.render.fps_base), (30, 1.001))
        self.assertAlmostEqual(fps, 30 / 1.001)
        self.assertEqual(target, 100)
        self.assertIs(self.scene.timeline_markers, self.markers)
        self.assertEqual([m.name for m in self.markers], ["Artist cut", "Note"])
        self.assertIs(self.scene.camera, self.camera)
        self.assertIs(self.markers[0].camera, self.second)

    def test_saved_frame_defaults_to_saved_current_frame_outside_old_json_range(self):
        self.assertEqual(self.configure("render-frame")[0], 185)

    def test_saved_frame_can_select_frame_outside_old_json_range(self):
        self.assertEqual(self.configure("render-frame", 350)[0], 350)

    def test_saved_editor_preserves_current_frame(self):
        self.assertEqual(self.configure("open-editor")[0], 185)

    def test_saved_editor_can_reopen_a_long_timeline_for_correction(self):
        self.scene.frame_end = 50000
        self.assertEqual(self.configure("open-editor")[0], 185)

    def test_saved_frame_rejects_frame_outside_actual_timeline(self):
        with self.assertRaisesRegex(job.ProtocolError, "outside the selected"):
            self.configure("render-frame", 25)

    def test_saved_scene_rejects_invalid_fps(self):
        for fps, base in [(30, 0), (300, 1), (30, float("nan"))]:
            with self.subTest(fps=fps, base=base):
                self.scene.render.fps, self.scene.render.fps_base = fps, base
                with self.assertRaises(job.ProtocolError):
                    self.configure()

    def test_saved_video_rejects_excess_frames_even_at_high_fps(self):
        self.scene.frame_start, self.scene.frame_end = 0, 14400
        self.scene.render.fps, self.scene.render.fps_base = 240, 1
        with self.assertRaisesRegex(job.ProtocolError, "frame count or duration"):
            self.configure()

    def test_saved_video_rejects_long_duration_even_with_few_frames(self):
        self.scene.frame_start, self.scene.frame_end = 0, 600
        self.scene.render.fps, self.scene.render.fps_base = 1, 1
        with self.assertRaisesRegex(job.ProtocolError, "frame count or duration"):
            self.configure()

    def test_saved_video_accepts_exact_frame_and_duration_limit(self):
        self.scene.frame_start, self.scene.frame_end = 0, 14399
        self.scene.render.fps, self.scene.render.fps_base = 24, 1
        self.assertEqual(self.configure(), (0, 24))

    def test_saved_video_rejects_frame_skipping(self):
        self.scene.frame_step = 2
        with self.assertRaisesRegex(job.ProtocolError, "frame step"):
            self.configure()

    def test_saved_scene_rejects_missing_or_foreign_active_camera(self):
        for camera in [None, Camera(name="Foreign", type="CAMERA")]:
            with self.subTest(camera=camera):
                self.scene.camera = camera
                with self.assertRaisesRegex(job.ProtocolError, "does not belong"):
                    self.configure()

    def test_saved_scene_rejects_foreign_marker_camera(self):
        self.markers[0].camera = Camera(name="Foreign", type="CAMERA")
        with self.assertRaisesRegex(job.ProtocolError, "does not belong"):
            self.configure()

    def test_saved_scene_rejects_excess_camera_markers(self):
        self.markers[:] = [self.markers[0]] * (job.MAX_SHOTS + 1)
        with self.assertRaisesRegex(job.ProtocolError, "count exceeds"):
            self.configure()

    def test_saved_source_requires_a_base_project(self):
        value = request()
        value["baseBlend"] = None
        with self.assertRaisesRegex(job.ProtocolError, "verified base"):
            job._validate_request(value)

    def test_request_rejects_unknown_source_and_free_form_execution(self):
        for patch_value in [{"sceneSource": "arbitrary"}, {"python": "ignored"}]:
            with self.subTest(value=patch_value):
                with self.assertRaises(job.ProtocolError):
                    job._validate_request({**request(), **patch_value})

    def test_request_frame_rules_are_source_and_operation_specific(self):
        self.assertIsNone(job._validate_request(request("render-frame"))["targetFrame"])
        for value in [request("render-frame", "director-scene"), request("render-video", frame=1), request("open-editor", frame=1)]:
            with self.subTest(value=value):
                with self.assertRaises(job.ProtocolError):
                    job._validate_request(value)

    def test_legacy_request_defaults_to_director_scene(self):
        value = request("render-frame", frame=42)
        del value["sceneSource"]
        self.assertEqual(job._validate_request(value)["sceneSource"], "director-scene")

    def test_director_mode_still_applies_json_and_replaces_camera_markers(self):
        camera = Camera(name="Managed", type="CAMERA")
        target, fps = job._configure_job_scene(self.scene, {"camera-1": camera},
            [(1, 120, "camera-1")], self.portable, request("render-frame", "director-scene", 42))
        self.assertEqual((self.scene.frame_start, self.scene.frame_end, target, fps), (1, 120, 42, 24))
        self.assertIs(self.scene.camera, camera)
        self.assertEqual([m.name for m in self.markers], ["Note", "AI_CANVAS_SHOT_1"])

    def test_saved_load_accepts_artist_cameras_and_disables_embedded_scripts(self):
        with patch.object(job, "_hash_file", return_value=("a" * 64, 12)):
            self.assertEqual(job._load_base_scene(MemoryPath(), request(), self.portable), (self.scene, {}, []))
        bpy.ops.wm.open_mainfile.assert_called_once_with(filepath="base.blend", load_ui=False, use_scripts=False)

    def test_saved_load_still_rejects_mismatched_scene_binding(self):
        self.scene.properties["ai_canvas_scene_revision"] = 2
        with patch.object(job, "_hash_file", return_value=("a" * 64, 12)):
            with self.assertRaisesRegex(job.ProtocolError, "binding is invalid"):
                job._load_base_scene(MemoryPath(), request(), self.portable)

    def test_director_load_keeps_exact_managed_camera_id_requirement(self):
        with patch.object(job, "_hash_file", return_value=("a" * 64, 12)):
            with self.assertRaisesRegex(job.ProtocolError, "cameras do not match"):
                job._load_base_scene(MemoryPath(), request(source="director-scene"), self.portable)

    def test_video_run_emits_actual_timeline_and_saves_an_output_copy(self):
        result = Mock()
        def artifact(path, prefix, kind, mime, **metadata):
            return {"kind": kind, "stagedFileName": path.name, **metadata}
        with patch.object(job, "_read_json", side_effect=[(request(), b""), ({}, b"")]), \
            patch.object(job, "_validate_scene", return_value=self.portable), \
            patch.object(job, "_load_base_scene", return_value=(self.scene, {}, [])), \
            patch.object(job, "_artifact", side_effect=artifact), \
            patch.object(job, "_write_result", result):
            job._run_job(MemoryPath())
        artifacts = result.call_args.args[2]
        self.assertEqual([item["kind"] for item in artifacts], ["reference-video", "blend-project"])
        self.assertEqual((artifacts[0]["startFrame"], artifacts[0]["endFrame"]), (100, 399))
        self.assertAlmostEqual(artifacts[0]["fps"], 30 / 1.001)
        bpy.ops.render.render.assert_called_once_with(animation=True)
        bpy.ops.wm.save_as_mainfile.assert_called_once_with(filepath="project.blend", copy=True, compress=False)
        self.assertEqual([marker.name for marker in self.markers], ["Artist cut", "Note"])


if __name__ == "__main__":
    unittest.main()
