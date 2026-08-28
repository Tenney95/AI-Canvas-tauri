"""AI Canvas Director application-template bootstrap.

This file is a versioned first-party resource. It never evaluates project data as
Python and does not register a general script execution entry point.
"""

import hashlib
import json
import os
from pathlib import Path

import bpy
from bpy.app.handlers import persistent


TEMPLATE_ID = "ai_canvas_director"
TEMPLATE_VERSION = 1
EDITOR_SESSION_KEY = "ai_canvas_director_editor_session_v1"
EDITOR_BLEND_NAME = "project.blend"
EDITOR_BLEND_STAGING_NAME = ".project-return-staging.blend"
EDITOR_RESULT_NAME = "job-result.json"
EDITOR_RESULT_STAGING_NAME = ".job-result.json.tmp"


def _require_finished(result, label):
    if result != {"FINISHED"}:
        raise RuntimeError(f"{label} did not finish")


def _hash_file(path):
    hasher = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            hasher.update(chunk)
    return size, hasher.hexdigest()


def _editor_session():
    session = bpy.app.driver_namespace.get(EDITOR_SESSION_KEY)
    required = {
        "jobDir",
        "outputDir",
        "jobId",
        "sceneId",
        "sceneRevision",
        "sceneSha256",
        "manifestRevision",
        "adapterVersion",
        "blenderVersion",
    }
    if not isinstance(session, dict) or set(session) != required:
        raise RuntimeError("AI Canvas editor session is unavailable")
    if not all(isinstance(session[key], str) and session[key] for key in (
        "jobDir",
        "outputDir",
        "jobId",
        "sceneId",
        "sceneSha256",
        "adapterVersion",
        "blenderVersion",
    )):
        raise RuntimeError("AI Canvas editor session is invalid")
    if not all(isinstance(session[key], int) and session[key] > 0 for key in (
        "sceneRevision",
        "manifestRevision",
    )):
        raise RuntimeError("AI Canvas editor session is invalid")

    job_dir = Path(session["jobDir"]).resolve(strict=True)
    output_dir = Path(session["outputDir"]).resolve(strict=True)
    if output_dir.parent != job_dir or output_dir.name != "output":
        raise RuntimeError("AI Canvas editor output is invalid")
    if job_dir.is_symlink() or output_dir.is_symlink():
        raise RuntimeError("AI Canvas editor output is invalid")
    return session, output_dir


def _write_editor_result(session, output_dir, blend_path):
    size, digest = _hash_file(blend_path)
    result = {
        "schemaVersion": 1,
        "protocol": "ai-canvas-blender-job-v1",
        "jobId": session["jobId"],
        "sceneId": session["sceneId"],
        "sceneRevision": session["sceneRevision"],
        "sceneSha256": session["sceneSha256"],
        "manifestRevision": session["manifestRevision"],
        "producer": {
            "runtime": "blender",
            "adapterVersion": session["adapterVersion"],
            "blenderVersion": session["blenderVersion"],
        },
        "artifactCandidates": [{
            "artifactId": f"blend-{digest}",
            "kind": "blend-project",
            "mimeType": "application/x-blender",
            "stagedFileName": "project.blend",
            "sha256": digest,
            "bytes": size,
        }],
    }
    encoded = (json.dumps(
        result,
        ensure_ascii=False,
        sort_keys=True,
        indent=2,
    ) + "\n").encode("utf-8")
    temporary_path = output_dir / EDITOR_RESULT_STAGING_NAME
    result_path = output_dir / EDITOR_RESULT_NAME
    if temporary_path.exists() or temporary_path.is_symlink():
        raise RuntimeError("AI Canvas editor result is busy")
    if result_path.exists() or result_path.is_symlink():
        raise RuntimeError("AI Canvas editor result already exists")
    try:
        with temporary_path.open("xb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, result_path)
    except OSError as error:
        try:
            if temporary_path.exists() and not temporary_path.is_symlink():
                temporary_path.unlink()
        except OSError:
            pass
        raise RuntimeError("AI Canvas editor result could not be committed") from error


def _save_editor_blend_atomically(output_dir):
    blend_path = output_dir / EDITOR_BLEND_NAME
    staging_path = output_dir / EDITOR_BLEND_STAGING_NAME
    result_path = output_dir / EDITOR_RESULT_NAME
    result_staging_path = output_dir / EDITOR_RESULT_STAGING_NAME

    if not blend_path.is_file() or blend_path.is_symlink():
        raise RuntimeError("AI Canvas editor project path is invalid")
    for path in (staging_path, result_path, result_staging_path):
        if path.exists() or path.is_symlink():
            raise RuntimeError("AI Canvas editor output is busy")

    bpy.context.preferences.filepaths.save_version = 0
    try:
        save_result = bpy.ops.wm.save_as_mainfile(
            filepath=str(staging_path),
            copy=True,
            compress=False,
        )
        _require_finished(save_result, "AI Canvas editor save")
        if not staging_path.is_file() or staging_path.is_symlink():
            raise RuntimeError("AI Canvas editor staging project is invalid")
        with staging_path.open("rb+") as handle:
            os.fsync(handle.fileno())
        os.replace(staging_path, blend_path)
    except Exception:
        try:
            if staging_path.is_file() and not staging_path.is_symlink():
                staging_path.unlink()
        except OSError:
            pass
        raise
    return blend_path


class AI_CANVAS_OT_save_and_return(bpy.types.Operator):
    bl_idname = "ai_canvas.save_and_return"
    bl_label = "保存并返回 AI Canvas"
    bl_description = "保存当前 Blender 工程，回写 AI Canvas 并关闭本窗口"
    bl_options = {"INTERNAL"}

    @classmethod
    def poll(cls, _context):
        return isinstance(bpy.app.driver_namespace.get(EDITOR_SESSION_KEY), dict)

    def execute(self, _context):
        try:
            session, output_dir = _editor_session()
            blend_path = _save_editor_blend_atomically(output_dir)
            _write_editor_result(session, output_dir, blend_path)
        except Exception as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}

        bpy.app.driver_namespace.pop(EDITOR_SESSION_KEY, None)

        def quit_blender():
            bpy.ops.wm.quit_blender()
            return None

        bpy.app.timers.register(quit_blender, first_interval=0.1)
        self.report({"INFO"}, "已保存，正在返回 AI Canvas")
        return {"FINISHED"}


class AI_CANVAS_PT_director_session(bpy.types.Panel):
    bl_label = "AI Canvas 导演模式"
    bl_idname = "AI_CANVAS_PT_director_session"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "AI Canvas"

    def draw(self, context):
        layout = self.layout
        if AI_CANVAS_OT_save_and_return.poll(context):
            layout.label(text="工程由 AI Canvas 管理")
            layout.operator(AI_CANVAS_OT_save_and_return.bl_idname, icon="FILE_TICK")
        else:
            layout.label(text="未连接 AI Canvas Job", icon="INFO")


REGISTER_CLASSES = (
    AI_CANVAS_OT_save_and_return,
    AI_CANVAS_PT_director_session,
)


def _configure_scene(scene):
    scene["ai_canvas_template_id"] = TEMPLATE_ID
    scene["ai_canvas_template_version"] = TEMPLATE_VERSION
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    if hasattr(scene.render.image_settings, "media_type"):
        scene.render.image_settings.media_type = "IMAGE"
    scene.render.image_settings.file_format = "PNG"
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 50


@persistent
def _load_factory_startup(_):
    bpy.app.driver_namespace.pop(EDITOR_SESSION_KEY, None)
    for scene in bpy.data.scenes:
        _configure_scene(scene)

    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type != "VIEW_3D":
                continue
            space = area.spaces.active
            space.shading.type = "MATERIAL"
            space.shading.use_scene_lights = True
            space.shading.use_scene_world = True


def register():
    for class_type in REGISTER_CLASSES:
        bpy.utils.register_class(class_type)
    if _load_factory_startup not in bpy.app.handlers.load_factory_startup_post:
        bpy.app.handlers.load_factory_startup_post.append(_load_factory_startup)


def unregister():
    bpy.app.driver_namespace.pop(EDITOR_SESSION_KEY, None)
    if _load_factory_startup in bpy.app.handlers.load_factory_startup_post:
        bpy.app.handlers.load_factory_startup_post.remove(_load_factory_startup)
    for class_type in reversed(REGISTER_CLASSES):
        bpy.utils.unregister_class(class_type)
