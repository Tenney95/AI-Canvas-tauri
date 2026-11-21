"""AI Canvas Director application-template bootstrap.

This file is a versioned first-party resource. It never evaluates project data as
Python and does not register a general script execution entry point.
"""

import hashlib
import json
import math
import os
import time
from pathlib import Path
import bpy
from bpy.app.handlers import persistent
from bpy.props import BoolProperty, EnumProperty, FloatProperty, StringProperty
from bpy_extras.io_utils import ImportHelper
from mathutils import Vector

if __package__:
    from . import camera_preview, scene_geometry
else:
    from importlib.util import module_from_spec, spec_from_file_location

    def _load_template_module(name):
        path = Path(__file__).with_name(f"{name}.py")
        spec = spec_from_file_location(f"ai_canvas_director_{name}", path)
        if spec is None or spec.loader is None:
            raise ImportError(f"Director template module unavailable: {name}")
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    camera_preview = _load_template_module("camera_preview")
    scene_geometry = _load_template_module("scene_geometry")

TEMPLATE_ID = "ai_canvas_director"
TEMPLATE_VERSION = 1
EDITOR_BLEND_NAME = "project.blend"
EDITOR_BLEND_STAGING_NAME = ".project-return-staging.blend"
EDITOR_FRAME_NAME = "frame.png"
EDITOR_FRAME_STAGING_NAME = ".frame-return-staging.png"
EDITOR_RESULT_NAME = "job-result.json"
EDITOR_RESULT_STAGING_NAME = ".job-result.json.tmp"
MAX_FRAME = 10_000_000
DIRECTOR_IMPORTED_KEY = "ai_canvas_console_imported"
DIRECTOR_PREVIOUS_WORLD_KEY = "ai_canvas_console_previous_world"
DIRECTOR_CONSOLE_ATTEMPTS_KEY = "ai_canvas_console_activation_attempts"
DIRECTOR_IMPORT_SUFFIXES = {".fbx", ".glb", ".gltf", ".obj"}
def _editor_operator_poll(context):
    return (
        context.scene is not None
        and context.mode == "OBJECT"
        and camera_preview._has_editor_session()
    )


def _point_object_at(obj, target):
    direction = Vector(target) - obj.matrix_world.translation
    if direction.length_squared == 0:
        return
    matrix = direction.to_track_quat("-Z", "Y").to_matrix().to_4x4()
    matrix.translation = obj.matrix_world.translation
    obj.matrix_world = matrix


def _new_light(name, collection, light_type, location, target, energy, color, size, kind):
    light_data = bpy.data.lights.new(name, type=light_type)
    light_data.energy = energy
    light_data.color = color
    if light_type == "AREA":
        light_data.shape = "DISK"
        light_data.size = size
    obj = bpy.data.objects.new(name, light_data)
    collection.objects.link(obj)
    obj.location = location
    _point_object_at(obj, target)
    scene_geometry._mark_console_object(obj, kind)
    return obj


def _ensure_console_world(scene):
    if (
        scene.world is not None
        and scene.world.get(scene_geometry.DIRECTOR_OWNER_KEY) == scene_geometry.DIRECTOR_OWNER_TOKEN
    ):
        return scene.world
    previous_name = scene.world.name if scene.world is not None else ""
    scene[DIRECTOR_PREVIOUS_WORLD_KEY] = previous_name
    world = bpy.data.worlds.new("AI Canvas Director Console World")
    world[scene_geometry.DIRECTOR_OWNER_KEY] = scene_geometry.DIRECTOR_OWNER_TOKEN
    scene.world = world
    return world


def _restore_console_world(scene):
    world = scene.world
    if world is None or world.get(scene_geometry.DIRECTOR_OWNER_KEY) != scene_geometry.DIRECTOR_OWNER_TOKEN:
        scene.pop(DIRECTOR_PREVIOUS_WORLD_KEY, None)
        return
    previous_name = scene.get(DIRECTOR_PREVIOUS_WORLD_KEY, "")
    previous = bpy.data.worlds.get(previous_name) if previous_name else None
    scene.world = previous
    scene.pop(DIRECTOR_PREVIOUS_WORLD_KEY, None)
    if world.users == 0:
        bpy.data.worlds.remove(world)


def _set_world(scene, color, strength):
    world = _ensure_console_world(scene)
    if hasattr(world, "use_nodes"):
        world.use_nodes = True
    background = next(
        (node for node in world.node_tree.nodes if node.type == "BACKGROUND"),
        None,
    )
    if background is None:
        background = world.node_tree.nodes.new("ShaderNodeBackground")
    output = next(
        (node for node in world.node_tree.nodes if node.type == "OUTPUT_WORLD"),
        None,
    )
    if output is None:
        output = world.node_tree.nodes.new("ShaderNodeOutputWorld")
    if not output.inputs["Surface"].is_linked:
        world.node_tree.links.new(background.outputs[0], output.inputs["Surface"])
    background.inputs["Color"].default_value = (*color, 1.0)
    background.inputs["Strength"].default_value = strength


def _configure_director_console_area():
    if bpy.app.background or not camera_preview._has_editor_session():
        return False
    window = bpy.context.window
    if window is None or window.screen is None:
        return False
    configured = False
    for area in window.screen.areas:
        if area.type != "PROPERTIES":
            continue
        space = area.spaces.active
        try:
            space.context = "SCENE"
        except TypeError:
            continue
        area.tag_redraw()
        configured = True
    return configured


def _activate_director_console_when_ready():
    if bpy.app.background:
        return None
    if not camera_preview._has_editor_session():
        return 0.1
    console_ready = _configure_director_console_area()
    preview_ready = camera_preview._camera_preview_is_active() or camera_preview._start_camera_preview()
    if console_ready and preview_ready:
        bpy.app.driver_namespace.pop(DIRECTOR_CONSOLE_ATTEMPTS_KEY, None)
        return None
    attempts = bpy.app.driver_namespace.get(DIRECTOR_CONSOLE_ATTEMPTS_KEY, 0) + 1
    if attempts >= 40:
        bpy.app.driver_namespace.pop(DIRECTOR_CONSOLE_ATTEMPTS_KEY, None)
        return None
    bpy.app.driver_namespace[DIRECTOR_CONSOLE_ATTEMPTS_KEY] = attempts
    return 0.25


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
    session = bpy.app.driver_namespace.get(camera_preview.EDITOR_SESSION_KEY)
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


def _write_editor_result(session, output_dir, blend_path, frame_path, frame):
    blend_size, blend_digest = _hash_file(blend_path)
    frame_size, frame_digest = _hash_file(frame_path)
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
        "artifactCandidates": [
            {
                "artifactId": f"frame-{frame_digest}",
                "kind": "frame-image",
                "mimeType": "image/png",
                "stagedFileName": EDITOR_FRAME_NAME,
                "sha256": frame_digest,
                "bytes": frame_size,
                "frame": frame,
            },
            {
                "artifactId": f"blend-{blend_digest}",
                "kind": "blend-project",
                "mimeType": "application/x-blender",
                "stagedFileName": EDITOR_BLEND_NAME,
                "sha256": blend_digest,
                "bytes": blend_size,
            },
        ],
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


def _render_editor_frame(output_dir):
    frame_path = output_dir / EDITOR_FRAME_NAME
    staging_path = output_dir / EDITOR_FRAME_STAGING_NAME
    for path in (frame_path, staging_path):
        if path.exists() or path.is_symlink():
            raise RuntimeError("AI Canvas editor frame output is busy")

    scene = bpy.context.scene
    frame = int(scene.frame_current)
    if frame < 0 or frame > MAX_FRAME:
        raise RuntimeError("当前帧超出 AI Canvas 支持范围")
    scene.frame_set(frame)
    camera = scene.camera
    if camera is None or camera.type != "CAMERA":
        raise RuntimeError("当前场景没有活动摄影机")

    render = scene.render
    image_settings = render.image_settings
    previous_filepath = render.filepath
    previous_use_file_extension = render.use_file_extension
    previous_use_multiview = render.use_multiview
    previous_use_sequencer = render.use_sequencer
    previous_file_format = image_settings.file_format
    previous_media_type = (
        image_settings.media_type
        if hasattr(image_settings, "media_type")
        else None
    )
    try:
        render.filepath = str(staging_path)
        render.use_file_extension = True
        render.use_multiview = False
        render.use_sequencer = False
        if previous_media_type is not None:
            image_settings.media_type = "IMAGE"
        image_settings.file_format = "PNG"
        _require_finished(
            bpy.ops.render.render(
                scene=scene.name,
                write_still=True,
                use_viewport=False,
            ),
            "AI Canvas editor frame render",
        )
        if not staging_path.is_file() or staging_path.is_symlink():
            raise RuntimeError("AI Canvas editor frame staging output is invalid")
        with staging_path.open("rb+") as handle:
            os.fsync(handle.fileno())
    except Exception:
        try:
            if staging_path.is_file() and not staging_path.is_symlink():
                staging_path.unlink()
        except OSError:
            pass
        raise
    finally:
        try:
            render.filepath = previous_filepath
            render.use_file_extension = previous_use_file_extension
            render.use_multiview = previous_use_multiview
            render.use_sequencer = previous_use_sequencer
            if previous_media_type is not None:
                image_settings.media_type = previous_media_type
            image_settings.file_format = previous_file_format
        except Exception:
            try:
                if staging_path.is_file() and not staging_path.is_symlink():
                    staging_path.unlink()
            except OSError:
                pass
            raise
    try:
        os.replace(staging_path, frame_path)
    except Exception:
        try:
            if staging_path.is_file() and not staging_path.is_symlink():
                staging_path.unlink()
        except OSError:
            pass
        raise
    return frame_path, frame


def _save_editor_blend_atomically(output_dir):
    blend_path = output_dir / EDITOR_BLEND_NAME
    staging_path = output_dir / EDITOR_BLEND_STAGING_NAME
    frame_path = output_dir / EDITOR_FRAME_NAME
    frame_staging_path = output_dir / EDITOR_FRAME_STAGING_NAME
    result_path = output_dir / EDITOR_RESULT_NAME
    result_staging_path = output_dir / EDITOR_RESULT_STAGING_NAME

    if not blend_path.is_file() or blend_path.is_symlink():
        raise RuntimeError("AI Canvas editor project path is invalid")
    for path in (
        staging_path,
        frame_path,
        frame_staging_path,
        result_path,
        result_staging_path,
    ):
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


class AI_CANVAS_OT_add_builtin_character(bpy.types.Operator):
    bl_idname = "ai_canvas.add_builtin_character"
    bl_label = "添加内置人物"
    bl_description = "在 3D 光标处添加带完整骨骼的 AI Canvas 内置白模"
    bl_options = {"REGISTER", "UNDO", "INTERNAL"}

    asset: EnumProperty(
        name="内置人物",
        items=(
            ("FEMALE", "女性白模", "添加带完整骨骼的女性测试白模"),
            ("MALE", "男性白模", "添加带完整骨骼的男性测试白模"),
        ),
    )

    @classmethod
    def poll(cls, context):
        return _editor_operator_poll(context)

    def execute(self, context):
        scene = context.scene
        before = scene_geometry._snapshot_import_state()
        had_collection_property = scene_geometry.DIRECTOR_COLLECTION_SCENE_KEY in scene
        previous_collection_name = scene.get(scene_geometry.DIRECTOR_COLLECTION_SCENE_KEY)
        try:
            character_path, label, slug, object_names = scene_geometry._builtin_character_path(
                self.asset,
            )
            with bpy.data.libraries.load(
                str(character_path),
                link=False,
                set_fake=False,
                recursive=False,
                reuse_local_id=False,
            ) as (
                data_from,
                data_to,
            ):
                if set(data_from.objects) != object_names:
                    raise RuntimeError("AI Canvas built-in character names are invalid")
                data_to.objects = sorted(object_names)
            objects = [obj for obj in data_to.objects if obj is not None]
            rig, meshes = scene_geometry._validate_builtin_character(objects, before)
            collection = scene_geometry._director_collection(scene)
            instance_id = f"{slug}-{time.time_ns():x}"
            asset_id = f"builtin-character-{slug}"
            for obj in objects:
                collection.objects.link(obj)
                scene_geometry._mark_console_object(obj, "character", asset_id, instance_id)
            for datablock in scene_geometry._new_import_datablocks(before):
                scene_geometry._mark_console_datablock(
                    datablock,
                    "character",
                    asset_id,
                    instance_id,
                )
            rig.name = f"AI_character-{slug}-rig"
            scene_geometry._rotate_around_world_z(context, rig, math.pi)
            scene_geometry._translate_roots_to_cursor(
                context,
                objects,
                scene.cursor.location.copy(),
            )
            scene_geometry._configure_character_selection(rig, meshes)
            scene_geometry._select_objects(context, [rig], rig)
        except Exception:
            scene_geometry._remove_new_import_data(before)
            if had_collection_property:
                scene[scene_geometry.DIRECTOR_COLLECTION_SCENE_KEY] = previous_collection_name
            elif scene_geometry.DIRECTOR_COLLECTION_SCENE_KEY in scene:
                del scene[scene_geometry.DIRECTOR_COLLECTION_SCENE_KEY]
            self.report({"ERROR"}, "内置人物加载失败，请重新安装 Blender 导演台资源")
            return {"CANCELLED"}

        self.report({"INFO"}, f"已添加{label}；骨架已设为活动对象")
        return {"FINISHED"}


class AI_CANVAS_OT_toggle_character_mesh_selection(bpy.types.Operator):
    bl_idname = "ai_canvas.toggle_character_mesh_selection"
    bl_label = "切换人物网格选择"
    bl_description = "默认锁定人物身体以防与骨架分离；需要高级网格编辑时可临时解锁"
    bl_options = {"REGISTER", "UNDO", "INTERNAL"}

    allow_mesh_selection: BoolProperty(
        name="允许选择人物网格",
        default=False,
    )

    @classmethod
    def poll(cls, context):
        return _editor_operator_poll(context)

    def execute(self, context):
        character_objects = scene_geometry._managed_character_objects()
        meshes = [obj for obj in character_objects if obj.type == "MESH"]
        rigs = [obj for obj in character_objects if obj.type == "ARMATURE"]
        if not meshes or not rigs:
            self.report({"WARNING"}, "当前场景没有可切换的内置人物")
            return {"CANCELLED"}

        active = context.view_layer.objects.active
        active_instance = (
            active.get(scene_geometry.DIRECTOR_INSTANCE_KEY)
            if active is not None and scene_geometry._is_managed_character_object(active)
            else None
        )
        for rig in rigs:
            rig.hide_select = False
            rig.show_in_front = True
        for mesh in list(meshes):
            if not self.allow_mesh_selection:
                mesh.select_set(False)
            mesh.hide_select = not self.allow_mesh_selection

        if not self.allow_mesh_selection and active_instance is not None:
            rig = next(
                (
                    candidate
                    for candidate in rigs
                    if candidate.get(scene_geometry.DIRECTOR_INSTANCE_KEY) == active_instance
                ),
                None,
            )
            if rig is not None:
                scene_geometry._select_objects(context, [rig], rig)
        context.view_layer.update()

        if self.allow_mesh_selection:
            self.report({"INFO"}, "已解锁人物网格；完成编辑后请恢复整体移动模式")
        else:
            self.report({"INFO"}, "已锁定人物网格；请移动显示在前方的骨架")
        return {"FINISHED"}


class AI_CANVAS_OT_add_blockout(bpy.types.Operator):
    bl_idname = "ai_canvas.add_blockout"
    bl_label = "添加基础模型"
    bl_description = "在 3D 光标处创建一个可撤销的 AI Canvas 基础模型"
    bl_options = {"REGISTER", "UNDO", "INTERNAL"}

    asset: EnumProperty(
        name="基础模型",
        items=(
            ("CUBE", "方块", "创建一米方块"),
            ("SPHERE", "球体", "创建一米球体"),
            ("FLOOR", "地面", "创建六米见方的地面"),
            ("TABLE", "桌子", "创建拍摄占位桌"),
        ),
    )

    @classmethod
    def poll(cls, context):
        return _editor_operator_poll(context)

    def execute(self, context):
        collection = scene_geometry._director_collection(context.scene)
        origin = context.scene.cursor.location.copy()
        neutral = scene_geometry._ensure_material("AI Canvas Neutral", (0.55, 0.58, 0.65))
        prop = scene_geometry._ensure_material("AI Canvas Prop", (0.85, 0.45, 0.2))
        created = []

        if self.asset == "CUBE":
            created.append(scene_geometry._new_box(
                "AI_blockout-cube",
                collection,
                origin + Vector((0.0, 0.0, 0.5)),
                (1.0, 1.0, 1.0),
                prop,
                "primitive",
            ))
        elif self.asset == "SPHERE":
            created.append(scene_geometry._new_sphere(
                "AI_blockout-sphere",
                collection,
                origin + Vector((0.0, 0.0, 0.5)),
                1.0,
                prop,
                "primitive",
            ))
        elif self.asset == "FLOOR":
            created.append(scene_geometry._new_box(
                "AI_blockout-floor",
                collection,
                origin + Vector((0.0, 0.0, -0.05)),
                (6.0, 6.0, 0.1),
                neutral,
                "primitive",
            ))
        elif self.asset == "TABLE":
            root = bpy.data.objects.new("AI_blockout-table", None)
            collection.objects.link(root)
            root.location = origin
            root.empty_display_type = "PLAIN_AXES"
            root.empty_display_size = 0.3
            scene_geometry._mark_console_object(root, "primitive")
            created.append(root)
            tabletop = scene_geometry._new_box(
                "AI_blockout-tabletop",
                collection,
                (0.0, 0.0, 0.78),
                (1.6, 0.8, 0.1),
                prop,
                "primitive",
            )
            tabletop.parent = root
            created.append(tabletop)
            for index, offset in enumerate((
                (-0.65, -0.28, 0.38),
                (0.65, -0.28, 0.38),
                (-0.65, 0.28, 0.38),
                (0.65, 0.28, 0.38),
            ), start=1):
                leg = scene_geometry._new_box(
                    f"AI_blockout-table-leg-{index}",
                    collection,
                    offset,
                    (0.1, 0.1, 0.76),
                    prop,
                    "primitive",
                )
                leg.parent = root
                created.append(leg)
        scene_geometry._select_objects(context, created, created[0] if created else None)
        self.report({"INFO"}, f"已创建 {len(created)} 个基础对象")
        return {"FINISHED"}


class AI_CANVAS_OT_apply_scene_preset(bpy.types.Operator):
    bl_idname = "ai_canvas.apply_scene_preset"
    bl_label = "应用场景预设"
    bl_description = "替换操作台创建的场景搭建，不影响 Director Scene 原对象"
    bl_options = {"REGISTER", "UNDO", "INTERNAL"}

    preset: EnumProperty(
        name="场景预设",
        items=(
            ("STUDIO", "摄影棚", "地面和摄影棚背景"),
            ("ROOM", "简单室内", "地面和三面墙"),
            ("OFFICE", "办公室", "简单室内与办公桌占位"),
            ("STREET", "街道", "道路、人行道与建筑占位"),
            ("GREEN", "绿幕", "地面和绿色背景墙"),
        ),
    )

    @classmethod
    def poll(cls, context):
        return _editor_operator_poll(context)

    def execute(self, context):
        scene_geometry._remove_console_objects(context.scene, {"scene"})
        collection = scene_geometry._director_collection(context.scene)
        neutral = scene_geometry._ensure_material("AI Canvas Set Neutral", (0.42, 0.45, 0.52))
        dark = scene_geometry._ensure_material("AI Canvas Road", (0.08, 0.09, 0.12), roughness=0.85)
        concrete = scene_geometry._ensure_material("AI Canvas Concrete", (0.35, 0.37, 0.4), roughness=0.8)
        green = scene_geometry._ensure_material("AI Canvas Green Screen", (0.04, 0.62, 0.12), roughness=0.9)
        wood = scene_geometry._ensure_material("AI Canvas Office Wood", (0.34, 0.16, 0.07), roughness=0.72)
        created = []

        def box(name, location, dimensions, material=neutral):
            obj = scene_geometry._new_box(name, collection, location, dimensions, material, "scene")
            created.append(obj)
            return obj

        if self.preset == "STUDIO":
            box("AI_set-studio-floor", (0.0, 0.0, -0.05), (10.0, 10.0, 0.1))
            box("AI_set-studio-backdrop", (0.0, 4.0, 3.0), (10.0, 0.1, 6.0))
            box("AI_set-studio-side", (-5.0, 1.0, 3.0), (0.1, 6.0, 6.0))
        elif self.preset in {"ROOM", "OFFICE"}:
            box("AI_set-room-floor", (0.0, 0.0, -0.05), (8.0, 8.0, 0.1))
            box("AI_set-room-back", (0.0, 4.0, 1.5), (8.0, 0.1, 3.0))
            box("AI_set-room-left", (-4.0, 0.0, 1.5), (0.1, 8.0, 3.0))
            box("AI_set-room-right", (4.0, 0.0, 1.5), (0.1, 8.0, 3.0))
            if self.preset == "OFFICE":
                box("AI_set-office-desk", (0.0, 0.7, 0.78), (2.2, 0.9, 0.1), wood)
                for index, offset in enumerate((
                    (-0.9, 0.45, 0.38),
                    (0.9, 0.45, 0.38),
                    (-0.9, 0.95, 0.38),
                    (0.9, 0.95, 0.38),
                ), start=1):
                    box(f"AI_set-office-leg-{index}", offset, (0.1, 0.1, 0.76), wood)
                box("AI_set-office-monitor", (0.0, 0.95, 1.35), (0.9, 0.08, 0.55), dark)
        elif self.preset == "STREET":
            box("AI_set-street-road", (0.0, 0.0, -0.06), (5.5, 14.0, 0.12), dark)
            box("AI_set-street-sidewalk-l", (-3.6, 0.0, 0.02), (1.6, 14.0, 0.16), concrete)
            box("AI_set-street-sidewalk-r", (3.6, 0.0, 0.02), (1.6, 14.0, 0.16), concrete)
            box("AI_set-street-building-l", (-5.2, 2.0, 2.5), (1.6, 10.0, 5.0))
            box("AI_set-street-building-r", (5.2, -1.0, 3.0), (1.6, 12.0, 6.0))
        elif self.preset == "GREEN":
            box("AI_set-green-floor", (0.0, 0.0, -0.05), (8.0, 8.0, 0.1), neutral)
            box("AI_set-green-screen", (0.0, 3.2, 2.0), (7.0, 0.1, 4.0), green)

        scene_geometry._select_objects(context, created)
        self.report({"INFO"}, "场景预设已应用；Director Scene 原对象保持不变")
        return {"FINISHED"}


class AI_CANVAS_OT_clear_console_build(bpy.types.Operator):
    bl_idname = "ai_canvas.clear_console_build"
    bl_label = "清理快速搭建"
    bl_description = "只删除操作台创建的基础模型、内置人物、场景和灯光，保留本地导入模型与 Director Scene"
    bl_options = {"REGISTER", "UNDO", "INTERNAL"}

    @classmethod
    def poll(cls, context):
        return _editor_operator_poll(context)

    def execute(self, context):
        removed = scene_geometry._remove_console_objects(
            context.scene,
            {"primitive", "character", "scene", "light"},
        )
        _restore_console_world(context.scene)
        self.report({"INFO"}, f"已清理 {removed} 个操作台对象")
        return {"FINISHED"}


class AI_CANVAS_OT_ground_selected(bpy.types.Operator):
    bl_idname = "ai_canvas.ground_selected"
    bl_label = "所选对象落地"
    bl_description = "保持所选层级整体关系，将最低点移动到 Z=0"
    bl_options = {"REGISTER", "UNDO", "INTERNAL"}

    @classmethod
    def poll(cls, context):
        return _editor_operator_poll(context) and any(
            obj.type not in {"CAMERA", "LIGHT"}
            for obj in context.selected_objects
        )

    def execute(self, context):
        selected = [
            obj for obj in context.selected_objects
            if obj.type not in {"CAMERA", "LIGHT"}
        ]
        character_instances = {
            obj.get(scene_geometry.DIRECTOR_INSTANCE_KEY)
            for obj in selected
            if obj.get(scene_geometry.DIRECTOR_OWNER_KEY) == scene_geometry.DIRECTOR_OWNER_TOKEN
            and obj.get(scene_geometry.DIRECTOR_MANAGED_KEY) is True
            and obj.get(scene_geometry.DIRECTOR_KIND_KEY) == "character"
            and isinstance(obj.get(scene_geometry.DIRECTOR_INSTANCE_KEY), str)
        }
        movement_objects = list(selected)
        movement_pointers = {obj.as_pointer() for obj in movement_objects}
        for obj in bpy.data.objects:
            if obj.get(scene_geometry.DIRECTOR_INSTANCE_KEY) not in character_instances:
                continue
            if obj.as_pointer() in movement_pointers:
                continue
            movement_objects.append(obj)
            movement_pointers.add(obj.as_pointer())
        movement_set = set(movement_objects)
        roots = [
            obj for obj in movement_objects
            if obj.parent not in movement_set
        ]
        hierarchy = scene_geometry._hierarchy_members(roots)
        points = scene_geometry._evaluated_mesh_bound_points(context, hierarchy)
        if not points:
            points = [
                obj.matrix_world @ Vector(corner)
                for obj in hierarchy
                if obj.type not in {"CAMERA", "LIGHT"}
                for corner in obj.bound_box
            ]
        if not points:
            self.report({"ERROR"}, "所选对象没有可用于落地的边界")
            return {"CANCELLED"}
        delta = -min(point.z for point in points)
        for obj in roots:
            matrix = obj.matrix_world.copy()
            matrix.translation.z += delta
            obj.matrix_world = matrix
        context.view_layer.update()
        self.report({"INFO"}, "所选对象已落地")
        return {"FINISHED"}


class AI_CANVAS_OT_apply_camera_preset(bpy.types.Operator):
    bl_idname = "ai_canvas.apply_camera_preset"
    bl_label = "应用镜头预设"
    bl_description = "用当前协议镜头为所选对象快速取景，并在当前帧写入关键帧"
    bl_options = {"REGISTER", "UNDO", "INTERNAL"}

    preset: EnumProperty(
        name="镜头预设",
        items=(
            ("CLOSE", "近景", "靠近所选对象"),
            ("MEDIUM", "中景", "适合半身或单人表演"),
            ("FULL", "全景", "展示人物与环境"),
            ("OVER", "过肩", "偏置到主体侧后方"),
            ("TOP", "俯拍", "从上方拍摄"),
            ("LOW", "仰拍", "从低机位拍摄"),
        ),
    )

    @classmethod
    def poll(cls, context):
        return _editor_operator_poll(context) and camera_preview._active_protocol_camera(context.scene) is not None

    def execute(self, context):
        camera = camera_preview._active_protocol_camera(context.scene)
        target, radius = scene_geometry._target_bounds(context)
        if self.preset == "CLOSE":
            offset = Vector((0.0, -max(1.4, radius * 2.2), radius * 0.1))
            lens = 85.0
        elif self.preset == "MEDIUM":
            offset = Vector((0.0, -max(2.8, radius * 3.4), radius * 0.35))
            lens = 50.0
        elif self.preset == "FULL":
            offset = Vector((0.0, -max(4.5, radius * 5.2), radius * 0.7))
            lens = 35.0
        elif self.preset == "OVER":
            offset = Vector((max(1.1, radius * 1.4), -max(2.5, radius * 3.0), radius * 0.45))
            lens = 50.0
        elif self.preset == "TOP":
            offset = Vector((0.0, -0.01, max(4.5, radius * 5.0)))
            lens = 35.0
        else:
            offset = Vector((0.0, -max(3.0, radius * 4.0), -min(0.8, radius * 0.45)))
            lens = 35.0

        position = target + offset
        matrix = camera.matrix_world.copy()
        matrix.translation = position
        camera.matrix_world = matrix
        _point_object_at(camera, target)
        camera.data.lens = lens
        camera.data.dof.use_dof = True
        frame = context.scene.frame_current
        if camera.data.dof.focus_object is None:
            camera.data.dof.focus_distance = max((target - position).length, 0.1)
            camera.data.dof.keyframe_insert(data_path="focus_distance", frame=frame)
        context.scene.camera = camera
        camera.keyframe_insert(data_path="location", frame=frame)
        camera.keyframe_insert(data_path="rotation_euler", frame=frame)
        camera.data.keyframe_insert(data_path="lens", frame=frame)
        self.report({"INFO"}, f"镜头预设已应用：{self.preset}")
        return {"FINISHED"}


class AI_CANVAS_OT_set_focal_length(bpy.types.Operator):
    bl_idname = "ai_canvas.set_focal_length"
    bl_label = "设置焦段"
    bl_description = "设置当前协议镜头焦段并在当前帧写入关键帧"
    bl_options = {"REGISTER", "UNDO", "INTERNAL"}

    lens: FloatProperty(name="焦段", min=1.0, max=300.0, default=50.0)

    @classmethod
    def poll(cls, context):
        return _editor_operator_poll(context) and camera_preview._active_protocol_camera(context.scene) is not None

    def execute(self, context):
        camera = camera_preview._active_protocol_camera(context.scene)
        camera.data.lens = self.lens
        camera.data.keyframe_insert(data_path="lens", frame=context.scene.frame_current)
        self.report({"INFO"}, f"焦段已设置为 {self.lens:g} mm")
        return {"FINISHED"}


class AI_CANVAS_OT_focus_selected(bpy.types.Operator):
    bl_idname = "ai_canvas.focus_selected"
    bl_label = "对焦所选对象"
    bl_description = "将当前协议镜头景深焦点绑定到所选对象"
    bl_options = {"REGISTER", "UNDO", "INTERNAL"}

    @classmethod
    def poll(cls, context):
        active = context.view_layer.objects.active
        return (
            _editor_operator_poll(context)
            and camera_preview._active_protocol_camera(context.scene) is not None
            and active is not None
            and active.type not in {"CAMERA", "LIGHT"}
        )

    def execute(self, context):
        camera = camera_preview._active_protocol_camera(context.scene)
        target = context.view_layer.objects.active
        camera.data.dof.use_dof = True
        camera.data.dof.focus_object = target
        self.report({"INFO"}, f"已对焦：{target.name}")
        return {"FINISHED"}


class AI_CANVAS_OT_apply_lighting_preset(bpy.types.Operator):
    bl_idname = "ai_canvas.apply_lighting_preset"
    bl_label = "应用灯光预设"
    bl_description = "替换操作台灯光，不影响 Director Scene 原灯光"
    bl_options = {"REGISTER", "UNDO", "INTERNAL"}

    preset: EnumProperty(
        name="灯光预设",
        items=(
            ("THREE_POINT", "三点布光", "主光、补光和轮廓光"),
            ("SOFT", "柔光", "大面积柔和双灯"),
            ("DAY", "日景", "明亮世界光与太阳光"),
            ("NIGHT", "夜景", "冷色主光与暖色轮廓光"),
        ),
    )

    @classmethod
    def poll(cls, context):
        return _editor_operator_poll(context)

    def execute(self, context):
        scene_geometry._remove_console_objects(context.scene, {"light"})
        collection = scene_geometry._director_collection(context.scene)
        target, _radius = scene_geometry._target_bounds(context)
        created = []

        def light(name, light_type, location, energy, color, size=3.0):
            obj = _new_light(
                name,
                collection,
                light_type,
                location,
                target,
                energy,
                color,
                size,
                "light",
            )
            created.append(obj)

        if self.preset == "THREE_POINT":
            _set_world(context.scene, (0.04, 0.04, 0.055), 0.3)
            light("AI_console-key", "AREA", (4.5, -4.5, 5.5), 1100, (1.0, 0.82, 0.68), 4.0)
            light("AI_console-fill", "AREA", (-4.0, -2.0, 3.0), 500, (0.55, 0.7, 1.0), 5.0)
            light("AI_console-rim", "AREA", (0.0, 3.5, 4.2), 850, (1.0, 0.35, 0.2), 2.5)
        elif self.preset == "SOFT":
            _set_world(context.scene, (0.12, 0.12, 0.12), 0.45)
            light("AI_console-soft-key", "AREA", (3.5, -3.5, 4.5), 850, (1.0, 0.92, 0.82), 6.0)
            light("AI_console-soft-fill", "AREA", (-3.5, -1.5, 3.2), 650, (0.72, 0.82, 1.0), 6.0)
        elif self.preset == "DAY":
            _set_world(context.scene, (0.45, 0.6, 0.9), 0.8)
            light("AI_console-sun", "SUN", (4.0, -4.0, 7.0), 3.0, (1.0, 0.88, 0.7))
        else:
            _set_world(context.scene, (0.01, 0.02, 0.08), 0.18)
            light("AI_console-night-key", "AREA", (3.5, -4.0, 4.0), 900, (0.12, 0.32, 1.0), 4.0)
            light("AI_console-night-rim", "AREA", (-2.0, 3.0, 3.0), 700, (1.0, 0.18, 0.06), 3.0)

        scene_geometry._select_objects(context, created)
        self.report({"INFO"}, "灯光预设已应用")
        return {"FINISHED"}


class AI_CANVAS_OT_import_model(bpy.types.Operator, ImportHelper):
    bl_idname = "ai_canvas.import_model"
    bl_label = "导入本地模型"
    bl_description = "由用户选择 OBJ、FBX、GLB 或 GLTF，并导入当前 Blender 工程"
    bl_options = {"REGISTER", "UNDO", "INTERNAL"}

    filename_ext = ""
    filter_glob: StringProperty(
        default="*.obj;*.fbx;*.glb;*.gltf",
        options={"HIDDEN"},
        maxlen=1024,
    )

    @classmethod
    def poll(cls, context):
        return _editor_operator_poll(context)

    def execute(self, context):
        try:
            path = Path(self.filepath).resolve(strict=True)
        except OSError:
            self.report({"ERROR"}, "所选模型文件不可用")
            return {"CANCELLED"}
        suffix = path.suffix.lower()
        if not path.is_file() or suffix not in DIRECTOR_IMPORT_SUFFIXES:
            self.report({"ERROR"}, "仅支持 OBJ、FBX、GLB 和 GLTF 模型")
            return {"CANCELLED"}

        before = scene_geometry._snapshot_import_state()
        scene = context.scene
        timeline = (
            scene.frame_start,
            scene.frame_end,
            scene.render.fps,
            scene.render.fps_base,
            scene.frame_current,
            scene.camera,
        )
        try:
            if suffix == ".obj":
                result = bpy.ops.wm.obj_import(filepath=str(path))
            elif suffix == ".fbx":
                try:
                    result = bpy.ops.wm.fbx_import(filepath=str(path))
                except AttributeError:
                    result = bpy.ops.import_scene.fbx(filepath=str(path))
            else:
                result = bpy.ops.import_scene.gltf(
                    filepath=str(path),
                    import_pack_images=True,
                )
        except Exception:
            scene_geometry._remove_new_import_data(before)
            self.report({"ERROR"}, "模型导入失败，请检查文件格式和外部资源")
            return {"CANCELLED"}
        finally:
            (
                scene.frame_start,
                scene.frame_end,
                scene.render.fps,
                scene.render.fps_base,
                current_frame,
                scene.camera,
            ) = timeline
            scene.frame_set(current_frame)

        if result != {"FINISHED"}:
            scene_geometry._remove_new_import_data(before)
            self.report({"ERROR"}, "模型导入器未完成任务")
            return {"CANCELLED"}
        imported = [
            obj for obj in bpy.data.objects
            if obj.as_pointer() not in before["objects"]
        ]
        if not imported:
            self.report({"ERROR"}, "模型导入器没有创建可用对象")
            return {"CANCELLED"}
        for obj in imported:
            obj[DIRECTOR_IMPORTED_KEY] = True
        scene_geometry._select_objects(context, imported)
        self.report({"INFO"}, f"已导入 {len(imported)} 个对象到当前工程")
        return {"FINISHED"}


class AI_CANVAS_OT_show_console(bpy.types.Operator):
    bl_idname = "ai_canvas.show_console"
    bl_label = "打开导演操作台"
    bl_description = "把当前工作区右下属性编辑器切换到 AI Canvas 导演操作台"
    bl_options = {"INTERNAL"}

    @classmethod
    def poll(cls, _context):
        return not bpy.app.background and camera_preview._has_editor_session()

    def execute(self, _context):
        if not _configure_director_console_area():
            self.report({"ERROR"}, "当前工作区没有属性编辑器")
            return {"CANCELLED"}
        return {"FINISHED"}


class AI_CANVAS_OT_save_and_return(bpy.types.Operator):
    bl_idname = "ai_canvas.save_and_return"
    bl_label = "保存并返回 AI Canvas"
    bl_description = "保存当前 Blender 工程，回写 AI Canvas 并关闭本窗口"
    bl_options = {"INTERNAL"}

    @classmethod
    def poll(cls, _context):
        return camera_preview._has_editor_session()

    def execute(self, _context):
        frame_path = None
        try:
            session, output_dir = _editor_session()
            blend_path = _save_editor_blend_atomically(output_dir)
            frame_path, frame = _render_editor_frame(output_dir)
            _write_editor_result(
                session,
                output_dir,
                blend_path,
                frame_path,
                frame,
            )
        except Exception as error:
            try:
                if (
                    frame_path is not None
                    and frame_path.is_file()
                    and not frame_path.is_symlink()
                ):
                    frame_path.unlink()
            except OSError:
                pass
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}

        camera_preview._stop_camera_preview()
        bpy.app.driver_namespace.pop(camera_preview.EDITOR_SESSION_KEY, None)

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

    @classmethod
    def poll(cls, _context):
        return camera_preview._has_editor_session()

    def draw(self, context):
        layout = self.layout
        layout.label(text="工程由 AI Canvas 管理", icon="LINKED")
        layout.operator(AI_CANVAS_OT_show_console.bl_idname, icon="SCENE_DATA")
        layout.operator(AI_CANVAS_OT_save_and_return.bl_idname, icon="FILE_TICK")


class AI_CANVAS_PT_properties_base:
    bl_space_type = "PROPERTIES"
    bl_region_type = "WINDOW"
    bl_context = "scene"

    @classmethod
    def poll(cls, _context):
        return camera_preview._has_editor_session()


class AI_CANVAS_PT_director_console(AI_CANVAS_PT_properties_base, bpy.types.Panel):
    bl_label = "AI Canvas 导演操作台"
    bl_idname = "SCENE_PT_ai_canvas_director_console"
    bl_order = 0

    def draw(self, _context):
        layout = self.layout
        session = bpy.app.driver_namespace.get(camera_preview.EDITOR_SESSION_KEY, {})
        layout.label(text="已连接当前 3D 导演台", icon="LINKED")
        revision = session.get("sceneRevision")
        if isinstance(revision, int):
            layout.label(text=f"场景版本：r{revision}")
        if camera_preview._camera_preview_is_active():
            layout.operator(
                camera_preview.AI_CANVAS_OT_hide_camera_preview.bl_idname,
                icon="X",
            )
        else:
            layout.operator(
                camera_preview.AI_CANVAS_OT_show_camera_preview.bl_idname,
                icon="CAMERA_DATA",
            )
        layout.operator(AI_CANVAS_OT_save_and_return.bl_idname, icon="FILE_TICK")


class AI_CANVAS_PT_quick_build(AI_CANVAS_PT_properties_base, bpy.types.Panel):
    bl_label = "快速创建"
    bl_idname = "SCENE_PT_ai_canvas_quick_build"
    bl_parent_id = AI_CANVAS_PT_director_console.bl_idname
    bl_order = 1

    def draw(self, _context):
        layout = self.layout
        row = layout.row(align=True)
        row.operator(AI_CANVAS_OT_add_blockout.bl_idname, text="方块", icon="MESH_CUBE").asset = "CUBE"
        row.operator(AI_CANVAS_OT_add_blockout.bl_idname, text="球体", icon="MESH_UVSPHERE").asset = "SPHERE"
        row = layout.row(align=True)
        row.operator(AI_CANVAS_OT_add_blockout.bl_idname, text="地面").asset = "FLOOR"
        row.operator(AI_CANVAS_OT_add_blockout.bl_idname, text="桌子").asset = "TABLE"
        row = layout.row(align=True)
        row.operator(
            AI_CANVAS_OT_add_builtin_character.bl_idname,
            text="女性白模",
            icon="ARMATURE_DATA",
        ).asset = "FEMALE"
        row.operator(
            AI_CANVAS_OT_add_builtin_character.bl_idname,
            text="男性白模",
            icon="ARMATURE_DATA",
        ).asset = "MALE"
        character_meshes = [
            obj
            for obj in scene_geometry._managed_character_objects()
            if obj.type == "MESH"
        ]
        if character_meshes:
            mesh_selection_enabled = any(
                not mesh.hide_select
                for mesh in character_meshes
            )
            toggle = layout.operator(
                AI_CANVAS_OT_toggle_character_mesh_selection.bl_idname,
                text=(
                    "锁定人物整体移动"
                    if mesh_selection_enabled
                    else "解锁人物网格编辑"
                ),
            )
            toggle.allow_mesh_selection = not mesh_selection_enabled
        layout.operator(AI_CANVAS_OT_ground_selected.bl_idname, icon="CON_FLOOR")


class AI_CANVAS_PT_scene_presets(AI_CANVAS_PT_properties_base, bpy.types.Panel):
    bl_label = "场景预设"
    bl_idname = "SCENE_PT_ai_canvas_scene_presets"
    bl_parent_id = AI_CANVAS_PT_director_console.bl_idname
    bl_order = 2

    def draw(self, _context):
        layout = self.layout
        row = layout.row(align=True)
        row.operator(AI_CANVAS_OT_apply_scene_preset.bl_idname, text="摄影棚").preset = "STUDIO"
        row.operator(AI_CANVAS_OT_apply_scene_preset.bl_idname, text="简单室内").preset = "ROOM"
        row = layout.row(align=True)
        row.operator(AI_CANVAS_OT_apply_scene_preset.bl_idname, text="办公室").preset = "OFFICE"
        row.operator(AI_CANVAS_OT_apply_scene_preset.bl_idname, text="街道").preset = "STREET"
        layout.operator(
            AI_CANVAS_OT_apply_scene_preset.bl_idname,
            text="绿幕场景",
        ).preset = "GREEN"


class AI_CANVAS_PT_camera_presets(AI_CANVAS_PT_properties_base, bpy.types.Panel):
    bl_label = "镜头与焦段"
    bl_idname = "SCENE_PT_ai_canvas_camera_presets"
    bl_parent_id = AI_CANVAS_PT_director_console.bl_idname
    bl_order = 3

    def draw(self, _context):
        layout = self.layout
        for first, second in (("CLOSE", "MEDIUM"), ("FULL", "OVER"), ("TOP", "LOW")):
            labels = {
                "CLOSE": "近景",
                "MEDIUM": "中景",
                "FULL": "全景",
                "OVER": "过肩",
                "TOP": "俯拍",
                "LOW": "仰拍",
            }
            row = layout.row(align=True)
            row.operator(AI_CANVAS_OT_apply_camera_preset.bl_idname, text=labels[first]).preset = first
            row.operator(AI_CANVAS_OT_apply_camera_preset.bl_idname, text=labels[second]).preset = second
        row = layout.row(align=True)
        for lens in (24.0, 35.0, 50.0, 85.0):
            row.operator(
                AI_CANVAS_OT_set_focal_length.bl_idname,
                text=f"{lens:g}",
            ).lens = lens
        layout.operator(AI_CANVAS_OT_focus_selected.bl_idname, icon="EYEDROPPER")


class AI_CANVAS_PT_lighting_presets(AI_CANVAS_PT_properties_base, bpy.types.Panel):
    bl_label = "灯光预设"
    bl_idname = "SCENE_PT_ai_canvas_lighting_presets"
    bl_parent_id = AI_CANVAS_PT_director_console.bl_idname
    bl_order = 4

    def draw(self, _context):
        layout = self.layout
        row = layout.row(align=True)
        row.operator(AI_CANVAS_OT_apply_lighting_preset.bl_idname, text="三点布光").preset = "THREE_POINT"
        row.operator(AI_CANVAS_OT_apply_lighting_preset.bl_idname, text="柔光").preset = "SOFT"
        row = layout.row(align=True)
        row.operator(AI_CANVAS_OT_apply_lighting_preset.bl_idname, text="日景").preset = "DAY"
        row.operator(AI_CANVAS_OT_apply_lighting_preset.bl_idname, text="夜景").preset = "NIGHT"


class AI_CANVAS_PT_model_import(AI_CANVAS_PT_properties_base, bpy.types.Panel):
    bl_label = "导入模型"
    bl_idname = "SCENE_PT_ai_canvas_model_import"
    bl_parent_id = AI_CANVAS_PT_director_console.bl_idname
    bl_order = 5

    def draw(self, _context):
        layout = self.layout
        layout.operator(AI_CANVAS_OT_import_model.bl_idname, icon="IMPORT")
        layout.label(text="支持 OBJ / FBX / GLB / GLTF", icon="INFO")
        layout.label(text="FBX / OBJ 贴图可能保留外部路径")
        layout.label(text="本期导入到当前 .blend，不写入项目素材库")


class AI_CANVAS_PT_output(AI_CANVAS_PT_properties_base, bpy.types.Panel):
    bl_label = "保存与输出"
    bl_idname = "SCENE_PT_ai_canvas_output"
    bl_parent_id = AI_CANVAS_PT_director_console.bl_idname
    bl_order = 6

    def draw(self, _context):
        layout = self.layout
        layout.operator(AI_CANVAS_OT_save_and_return.bl_idname, icon="FILE_TICK")
        layout.label(text="返回后可在同一节点同步当前帧", icon="INFO")
        layout.label(text="或生成参考视频")
        layout.separator()
        layout.operator(AI_CANVAS_OT_clear_console_build.bl_idname, icon="TRASH")


REGISTER_CLASSES = (
    AI_CANVAS_OT_add_builtin_character,
    AI_CANVAS_OT_toggle_character_mesh_selection,
    AI_CANVAS_OT_add_blockout,
    AI_CANVAS_OT_apply_scene_preset,
    AI_CANVAS_OT_clear_console_build,
    AI_CANVAS_OT_ground_selected,
    AI_CANVAS_OT_apply_camera_preset,
    AI_CANVAS_OT_set_focal_length,
    AI_CANVAS_OT_focus_selected,
    AI_CANVAS_OT_apply_lighting_preset,
    AI_CANVAS_OT_import_model,
    camera_preview.AI_CANVAS_OT_camera_preview_modal,
    camera_preview.AI_CANVAS_OT_show_camera_preview,
    camera_preview.AI_CANVAS_OT_hide_camera_preview,
    AI_CANVAS_OT_show_console,
    AI_CANVAS_OT_save_and_return,
    AI_CANVAS_PT_director_console,
    AI_CANVAS_PT_quick_build,
    AI_CANVAS_PT_scene_presets,
    AI_CANVAS_PT_camera_presets,
    AI_CANVAS_PT_lighting_presets,
    AI_CANVAS_PT_model_import,
    AI_CANVAS_PT_output,
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


def _localize_workspace_names():
    if bpy.app.background:
        return
    preferences = bpy.context.preferences.view
    if not preferences.use_translate_new_dataname:
        return

    translations = bpy.app.translations
    workspace_context = translations.contexts.id_workspace
    for workspace in bpy.data.workspaces:
        translated_name = translations.pgettext_data(
            workspace.name,
            workspace_context,
        )
        if translated_name != workspace.name:
            workspace.name = translated_name


@persistent
def _teardown_camera_preview_before_load(_):
    camera_preview._stop_camera_preview()


@persistent
def _load_factory_startup(_):
    bpy.app.driver_namespace.pop(camera_preview.EDITOR_SESSION_KEY, None)
    for scene in bpy.data.scenes:
        _configure_scene(scene)
    _localize_workspace_names()

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
    if _teardown_camera_preview_before_load not in bpy.app.handlers.load_pre:
        bpy.app.handlers.load_pre.append(_teardown_camera_preview_before_load)
    if _load_factory_startup not in bpy.app.handlers.load_factory_startup_post:
        bpy.app.handlers.load_factory_startup_post.append(_load_factory_startup)
    if (
        not bpy.app.background
        and not bpy.app.timers.is_registered(_activate_director_console_when_ready)
    ):
        bpy.app.timers.register(
            _activate_director_console_when_ready,
            first_interval=0.1,
            persistent=True,
        )
    _localize_workspace_names()


def unregister():
    camera_preview._stop_camera_preview()
    bpy.app.driver_namespace.pop(camera_preview.EDITOR_SESSION_KEY, None)
    bpy.app.driver_namespace.pop(DIRECTOR_CONSOLE_ATTEMPTS_KEY, None)
    if bpy.app.timers.is_registered(_activate_director_console_when_ready):
        bpy.app.timers.unregister(_activate_director_console_when_ready)
    if _teardown_camera_preview_before_load in bpy.app.handlers.load_pre:
        bpy.app.handlers.load_pre.remove(_teardown_camera_preview_before_load)
    if _load_factory_startup in bpy.app.handlers.load_factory_startup_post:
        bpy.app.handlers.load_factory_startup_post.remove(_load_factory_startup)
    for class_type in reversed(REGISTER_CLASSES):
        bpy.utils.unregister_class(class_type)


if __name__ == "__main__":
    register()
