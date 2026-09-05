"""Fixed AI Canvas Blender job protocol v1.

The host owns executable selection, arguments, working directory, and output
collection. This script only reads ``request.json`` and ``input/scene.json``
from the current job directory and writes a bounded result into ``output``.
Project data is never evaluated as Python.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
from pathlib import Path

import bpy
from mathutils import Vector


PROTOCOL = "ai-canvas-blender-job-v1"
ADAPTER_VERSION = "1.0.0"
EXPECTED_BLENDER_VERSION = (5, 2, 1)
EXPECTED_TEMPLATE_ID = "ai_canvas_director"
EXPECTED_TEMPLATE_VERSION = 1
EDITOR_SESSION_KEY = "ai_canvas_director_editor_session_v1"
MAX_REQUEST_BYTES = 64 * 1024
MAX_SCENE_BYTES = 2 * 1024 * 1024
MAX_BLEND_BYTES = 4 * 1024 * 1024 * 1024
MAX_ENTITIES = 256
MAX_CAMERAS = 64
MAX_SHOTS = 256
MAX_KEYFRAMES = 8192
# Inclusive render span: at most ten minutes at the default 24 fps.
MAX_VIDEO_FRAMES = 14_400
MAX_SAVED_VIDEO_SECONDS = 600
MAX_FRAME = 10_000_000
MAX_NAME_LENGTH = 200
MAX_PATH_LENGTH = 512
MAX_PATH_SEGMENT_LENGTH = 240
MAX_PATH_DEPTH = 32
ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
WINDOWS_RESERVED_NAME_PATTERN = re.compile(
    r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$", re.IGNORECASE
)
FORBIDDEN_PATH_CHARACTER_PATTERN = re.compile(r'[<>"|?*]')

REQUEST_KEYS = {
    "schemaVersion",
    "protocol",
    "jobId",
    "operation",
    "sceneSource",
    "sceneId",
    "sceneRevision",
    "sceneSha256",
    "manifestRevision",
    "targetFrame",
    "baseBlend",
}
SCENE_KEYS = {
    "schemaVersion",
    "sceneId",
    "revision",
    "parent",
    "coordinateSystem",
    "timeline",
    "environment",
    "entities",
    "cameras",
    "shots",
}
TRANSFORM_KEYS = {"position", "rotationEuler", "scale"}
VECTOR_KEYS = {"x", "y", "z"}
PROJECT_FILE_REFERENCE_KEYS = {"kind", "relativePath", "sha256", "bytes"}
BASE_BLEND_KEYS = {"stagedFileName", "sha256", "bytes"}
ENTITY_KEYS = {"entityId", "kind", "name", "asset", "transform", "visible"}
CAMERA_KEYS = {
    "cameraId",
    "name",
    "transform",
    "focalLengthMm",
    "sensorWidthMm",
    "apertureFStop",
    "focusDistanceM",
    "keyframes",
}
CAMERA_KEYFRAME_KEYS = {
    "frame",
    "interpolation",
    "transform",
    "focalLengthMm",
    "apertureFStop",
    "focusDistanceM",
}
SHOT_KEYS = {"shotId", "name", "startFrame", "endFrame", "cameraId"}


class ProtocolError(RuntimeError):
    pass


def _object(value, label):
    if not isinstance(value, dict):
        raise ProtocolError(f"{label} must be an object")
    return value


def _known_keys(value, allowed, label):
    unknown = sorted(set(value) - set(allowed))
    if unknown:
        raise ProtocolError(f"{label} contains an unsupported field")


def _array(value, label, maximum):
    if not isinstance(value, list) or len(value) > maximum:
        raise ProtocolError(f"{label} is invalid")
    return value


def _identifier(value, label):
    if not isinstance(value, str) or ID_PATTERN.fullmatch(value) is None:
        raise ProtocolError(f"{label} is invalid")
    return value


def _required_string(value, label, maximum):
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ProtocolError(f"{label} is invalid")
    if value != value.strip() or any(
        ord(character) <= 31 or 127 <= ord(character) <= 159
        for character in value
    ):
        raise ProtocolError(f"{label} is invalid")
    return value


def _sha256(value, label):
    if not isinstance(value, str) or SHA256_PATTERN.fullmatch(value) is None:
        raise ProtocolError(f"{label} is invalid")
    return value


def _integer(value, label, minimum=1, maximum=MAX_FRAME):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProtocolError(f"{label} must be an integer")
    if value < minimum or value > maximum:
        raise ProtocolError(f"{label} is out of range")
    return value


def _number(value, label, minimum=None, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProtocolError(f"{label} must be a number")
    result = float(value)
    if not math.isfinite(result):
        raise ProtocolError(f"{label} must be finite")
    if minimum is not None and result < minimum:
        raise ProtocolError(f"{label} is out of range")
    if maximum is not None and result > maximum:
        raise ProtocolError(f"{label} is out of range")
    return result


def _assert_unique(values, label):
    if len(set(values)) != len(values):
        raise ProtocolError(f"{label} contains duplicate values")


def _project_relative_path(value, label):
    path = _required_string(value, label, MAX_PATH_LENGTH)
    if (
        FORBIDDEN_PATH_CHARACTER_PATTERN.search(path)
        or "\\" in path
        or ":" in path
        or path.startswith("/")
        or path.startswith("~")
    ):
        raise ProtocolError(f"{label} is invalid")
    segments = path.split("/")
    if len(segments) > MAX_PATH_DEPTH:
        raise ProtocolError(f"{label} is invalid")
    for segment in segments:
        if (
            not segment
            or segment in {".", ".."}
            or segment.lower() == ".trash"
            or segment.endswith((".", " "))
            or len(segment) > MAX_PATH_SEGMENT_LENGTH
            or WINDOWS_RESERVED_NAME_PATTERN.fullmatch(segment) is not None
        ):
            raise ProtocolError(f"{label} is invalid")
    return path


def _validate_project_file_reference(value, label):
    reference = _object(value, label)
    _known_keys(reference, PROJECT_FILE_REFERENCE_KEYS, label)
    if reference.get("kind") != "project-file":
        raise ProtocolError(f"{label}.kind is unsupported")
    _project_relative_path(reference.get("relativePath"), f"{label}.relativePath")
    _sha256(reference.get("sha256"), f"{label}.sha256")
    _integer(
        reference.get("bytes"),
        f"{label}.bytes",
        minimum=1,
        maximum=(2**53) - 1,
    )


def _read_json(path, maximum, label):
    try:
        size = path.stat().st_size
    except OSError as error:
        raise ProtocolError(f"{label} is unavailable") from error
    if size <= 0 or size > maximum or not path.is_file() or path.is_symlink():
        raise ProtocolError(f"{label} is invalid")
    try:
        raw = path.read_bytes()
        text = raw.decode("utf-8", errors="strict")
        value = json.loads(text)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ProtocolError(f"{label} is invalid") from error
    return _object(value, label), raw


def _vector(value, label, *, scale=False):
    raw = _object(value, label)
    _known_keys(raw, VECTOR_KEYS, label)
    minimum = 0 if scale else -1_000_000
    maximum = 10_000 if scale else 1_000_000
    result = tuple(
        _number(raw[axis], f"{label}.{axis}", minimum, maximum)
        for axis in ("x", "y", "z")
    )
    if scale and any(component <= 0 for component in result):
        raise ProtocolError(f"{label} must be greater than zero")
    return result


def _transform(value, label):
    raw = _object(value, label)
    _known_keys(raw, TRANSFORM_KEYS, label)
    return {
        "position": _vector(raw.get("position"), f"{label}.position"),
        "rotation": _vector(raw.get("rotationEuler"), f"{label}.rotationEuler"),
        "scale": _vector(raw.get("scale"), f"{label}.scale", scale=True),
    }


def _apply_transform(obj, transform):
    obj.location = transform["position"]
    obj.rotation_mode = "XYZ"
    obj.rotation_euler = tuple(math.radians(value) for value in transform["rotation"])
    obj.scale = transform["scale"]


def _validate_request(value):
    _known_keys(value, REQUEST_KEYS, "request")
    if value.get("schemaVersion") != 1 or value.get("protocol") != PROTOCOL:
        raise ProtocolError("request protocol is unsupported")
    operation = value.get("operation")
    if operation not in {"open-editor", "render-frame", "render-video"}:
        raise ProtocolError("request operation is unsupported")
    scene_source = value.get("sceneSource", "director-scene")
    if scene_source not in {"director-scene", "saved-blender"}:
        raise ProtocolError("request scene source is unsupported")
    request = {
        "jobId": _identifier(value.get("jobId"), "request.jobId"),
        "operation": operation,
        "sceneSource": scene_source,
        "sceneId": _identifier(value.get("sceneId"), "request.sceneId"),
        "sceneRevision": _integer(value.get("sceneRevision"), "request.sceneRevision"),
        "sceneSha256": _sha256(value.get("sceneSha256"), "request.sceneSha256"),
        "manifestRevision": _integer(value.get("manifestRevision"), "request.manifestRevision"),
        "targetFrame": None,
        "baseBlend": None,
    }
    if value.get("targetFrame") is not None:
        request["targetFrame"] = _integer(
            value.get("targetFrame"), "request.targetFrame", minimum=0
        )
    if value.get("baseBlend") is not None:
        base_blend = _object(value.get("baseBlend"), "request.baseBlend")
        _known_keys(base_blend, BASE_BLEND_KEYS, "request.baseBlend")
        if base_blend.get("stagedFileName") != "base.blend":
            raise ProtocolError("request.baseBlend.stagedFileName is invalid")
        request["baseBlend"] = {
            "stagedFileName": "base.blend",
            "sha256": _sha256(
                base_blend.get("sha256"), "request.baseBlend.sha256"
            ),
            "bytes": _integer(
                base_blend.get("bytes"),
                "request.baseBlend.bytes",
                minimum=1,
                maximum=MAX_BLEND_BYTES,
            ),
        }
    if scene_source == "saved-blender" and request["baseBlend"] is None:
        raise ProtocolError("saved Blender scene requires a verified base project")
    if operation == "render-frame":
        if scene_source == "director-scene" and request["targetFrame"] is None:
            raise ProtocolError("Director Scene frame render requires a target frame")
    elif request["targetFrame"] is not None:
        raise ProtocolError("target frame is only supported for frame rendering")
    return request


def _validate_entity(value, index):
    label = f"scene.entities[{index}]"
    entity = _object(value, label)
    _known_keys(entity, ENTITY_KEYS, label)
    entity_id = _identifier(entity.get("entityId"), f"{label}.entityId")
    if entity.get("kind") not in {"character", "prop"}:
        raise ProtocolError(f"{label}.kind is unsupported")
    _required_string(entity.get("name"), f"{label}.name", MAX_NAME_LENGTH)
    _validate_project_file_reference(entity.get("asset"), f"{label}.asset")
    _transform(entity.get("transform"), f"{label}.transform")
    if not isinstance(entity.get("visible"), bool):
        raise ProtocolError(f"{label}.visible must be a boolean")
    return entity_id


def _validate_camera(value, index, timeline):
    label = f"scene.cameras[{index}]"
    camera = _object(value, label)
    _known_keys(camera, CAMERA_KEYS, label)
    camera_id = _identifier(camera.get("cameraId"), f"{label}.cameraId")
    _required_string(camera.get("name"), f"{label}.name", MAX_NAME_LENGTH)
    _transform(camera.get("transform"), f"{label}.transform")
    _number(camera.get("focalLengthMm"), f"{label}.focalLengthMm", 0.1, 2_000)
    _number(camera.get("sensorWidthMm"), f"{label}.sensorWidthMm", 0.1, 1_000)
    _number(camera.get("apertureFStop"), f"{label}.apertureFStop", 0.1, 128)
    _number(camera.get("focusDistanceM"), f"{label}.focusDistanceM", 0, 1_000_000_000)

    keyframes = _array(camera.get("keyframes"), f"{label}.keyframes", MAX_KEYFRAMES)
    previous_frame = None
    for keyframe_index, keyframe_value in enumerate(keyframes):
        keyframe_label = f"{label}.keyframes[{keyframe_index}]"
        keyframe = _object(keyframe_value, keyframe_label)
        _known_keys(keyframe, CAMERA_KEYFRAME_KEYS, keyframe_label)
        frame = _integer(
            keyframe.get("frame"), keyframe_label + ".frame", minimum=0
        )
        if frame < timeline[0] or frame > timeline[1]:
            raise ProtocolError(f"{keyframe_label}.frame is outside the timeline")
        if previous_frame is not None and frame <= previous_frame:
            raise ProtocolError(f"{label}.keyframes must be strictly increasing")
        previous_frame = frame
        if keyframe.get("interpolation") not in {"constant", "linear", "bezier"}:
            raise ProtocolError(f"{keyframe_label}.interpolation is unsupported")
        _transform(keyframe.get("transform"), f"{keyframe_label}.transform")
        if keyframe.get("focalLengthMm") is not None:
            _number(
                keyframe["focalLengthMm"],
                f"{keyframe_label}.focalLengthMm",
                0.1,
                2_000,
            )
        if keyframe.get("apertureFStop") is not None:
            _number(
                keyframe["apertureFStop"],
                f"{keyframe_label}.apertureFStop",
                0.1,
                128,
            )
        if keyframe.get("focusDistanceM") is not None:
            _number(
                keyframe["focusDistanceM"],
                f"{keyframe_label}.focusDistanceM",
                0,
                1_000_000_000,
            )
    return camera_id, len(keyframes)


def _validate_shot(value, index, timeline, camera_ids):
    label = f"scene.shots[{index}]"
    shot = _object(value, label)
    _known_keys(shot, SHOT_KEYS, label)
    shot_id = _identifier(shot.get("shotId"), f"{label}.shotId")
    _required_string(shot.get("name"), f"{label}.name", MAX_NAME_LENGTH)
    start = _integer(shot.get("startFrame"), f"{label}.startFrame", minimum=0)
    end = _integer(shot.get("endFrame"), f"{label}.endFrame", minimum=0)
    camera_id = _identifier(shot.get("cameraId"), f"{label}.cameraId")
    if start < timeline[0] or end > timeline[1] or end < start:
        raise ProtocolError(f"{label} is outside the timeline")
    if camera_id not in camera_ids:
        raise ProtocolError(f"{label}.cameraId is unavailable")
    return shot_id


def _validate_scene(value, raw_bytes, request):
    _known_keys(value, SCENE_KEYS, "scene")
    if value.get("schemaVersion") != 1:
        raise ProtocolError("scene schema is unsupported")
    if _identifier(value.get("sceneId"), "scene.sceneId") != request["sceneId"]:
        raise ProtocolError("scene identity does not match request")
    revision = _integer(value.get("revision"), "scene.revision")
    if revision != request["sceneRevision"]:
        raise ProtocolError("scene revision does not match request")
    if hashlib.sha256(raw_bytes).hexdigest() != request["sceneSha256"]:
        raise ProtocolError("scene hash does not match request")

    parent = value.get("parent")
    if parent is None:
        if revision != 1:
            raise ProtocolError("scene parent is required")
    else:
        parent_value = _object(parent, "scene.parent")
        _known_keys(parent_value, {"revision", "sha256"}, "scene.parent")
        if revision == 1 or _integer(
            parent_value.get("revision"), "scene.parent.revision"
        ) != revision - 1:
            raise ProtocolError("scene parent revision is invalid")
        _sha256(parent_value.get("sha256"), "scene.parent.sha256")

    coordinate = _object(value.get("coordinateSystem"), "scene.coordinateSystem")
    expected_coordinate = {
        "handedness": "right",
        "upAxis": "Z",
        "forwardAxis": "-Y",
        "lengthUnit": "meter",
        "angleUnit": "degree",
        "rotationOrder": "XYZ",
    }
    if coordinate != expected_coordinate:
        raise ProtocolError("scene coordinate system is unsupported")

    timeline = _object(value.get("timeline"), "scene.timeline")
    _known_keys(timeline, {"fps", "startFrame", "endFrame"}, "scene.timeline")
    start_frame = _integer(timeline.get("startFrame"), "scene.timeline.startFrame", minimum=0)
    end_frame = _integer(timeline.get("endFrame"), "scene.timeline.endFrame", minimum=0)
    if end_frame < start_frame:
        raise ProtocolError("scene timeline is invalid")
    fps = _number(timeline.get("fps"), "scene.timeline.fps", 1, 240)
    if (
        request["operation"] == "render-video"
        and request.get("sceneSource", "director-scene") == "director-scene"
        and end_frame - start_frame + 1 > MAX_VIDEO_FRAMES
    ):
        raise ProtocolError("scene video frame count exceeds the limit")

    environment = _object(value.get("environment"), "scene.environment")
    _known_keys(environment, {"worldColor", "asset"}, "scene.environment")
    world = _object(environment.get("worldColor"), "scene.environment.worldColor")
    _known_keys(world, {"r", "g", "b"}, "scene.environment.worldColor")
    world_color = tuple(
        _number(world.get(channel), f"scene.environment.worldColor.{channel}", 0, 1)
        for channel in ("r", "g", "b")
    )
    if "asset" in environment:
        _validate_project_file_reference(
            environment.get("asset"), "scene.environment.asset"
        )

    entities = _array(value.get("entities"), "scene.entities", MAX_ENTITIES)
    cameras = _array(value.get("cameras"), "scene.cameras", MAX_CAMERAS)
    shots = _array(value.get("shots"), "scene.shots", MAX_SHOTS)
    if not cameras or not shots:
        raise ProtocolError("scene requires at least one camera and shot")

    entity_ids = [
        _validate_entity(entity, index) for index, entity in enumerate(entities)
    ]
    _assert_unique(entity_ids, "scene entity IDs")

    camera_ids = []
    keyframe_count = 0
    for index, camera in enumerate(cameras):
        camera_id, camera_keyframe_count = _validate_camera(
            camera, index, (start_frame, end_frame)
        )
        camera_ids.append(camera_id)
        keyframe_count += camera_keyframe_count
        if keyframe_count > MAX_KEYFRAMES:
            raise ProtocolError("scene camera keyframe count exceeds the limit")
    _assert_unique(camera_ids, "scene camera IDs")

    camera_id_set = set(camera_ids)
    shot_ids = [
        _validate_shot(shot, index, (start_frame, end_frame), camera_id_set)
        for index, shot in enumerate(shots)
    ]
    _assert_unique(shot_ids, "scene shot IDs")

    return {
        "raw": value,
        "fps": fps,
        "startFrame": start_frame,
        "endFrame": end_frame,
        "worldColor": world_color,
        "entities": entities,
        "cameras": cameras,
        "shots": shots,
    }


def _clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in list(bpy.data.collections):
        if collection.users == 0:
            bpy.data.collections.remove(collection)


def _assert_runtime():
    if tuple(bpy.app.version) != EXPECTED_BLENDER_VERSION:
        raise ProtocolError("Blender version is unsupported")
    scene = bpy.context.scene
    if (
        scene is None
        or scene.get("ai_canvas_template_id") != EXPECTED_TEMPLATE_ID
        or scene.get("ai_canvas_template_version") != EXPECTED_TEMPLATE_VERSION
    ):
        raise ProtocolError("AI Canvas application template is unavailable")


def _director_collection(scene):
    collection = bpy.data.collections.new("AI Canvas Scene")
    scene.collection.children.link(collection)
    return collection


def _placeholder_mesh(entity, collection):
    kind = entity.get("kind")
    if kind not in {"character", "prop"}:
        raise ProtocolError("entity kind is unsupported")
    entity_id = _identifier(entity.get("entityId"), "entity.entityId")
    transform = _transform(entity.get("transform"), "entity.transform")
    visible = entity.get("visible")
    if not isinstance(visible, bool):
        raise ProtocolError("entity.visible must be a boolean")

    mesh = bpy.data.meshes.new(f"AI_{entity_id}_mesh")
    if kind == "character":
        vertices = [
            (-0.35, -0.25, 0.0), (0.35, -0.25, 0.0), (0.35, 0.25, 0.0), (-0.35, 0.25, 0.0),
            (-0.35, -0.25, 1.7), (0.35, -0.25, 1.7), (0.35, 0.25, 1.7), (-0.35, 0.25, 1.7),
        ]
    else:
        vertices = [
            (-0.5, -0.5, -0.5), (0.5, -0.5, -0.5), (0.5, 0.5, -0.5), (-0.5, 0.5, -0.5),
            (-0.5, -0.5, 0.5), (0.5, -0.5, 0.5), (0.5, 0.5, 0.5), (-0.5, 0.5, 0.5),
        ]
    faces = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (4, 0, 3, 7)]
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(f"AI_{entity_id}", mesh)
    collection.objects.link(obj)
    material = bpy.data.materials.new(f"AI_{entity_id}_material")
    material.diffuse_color = (0.2, 0.55, 0.95, 1.0) if kind == "character" else (0.85, 0.45, 0.2, 1.0)
    shader = material.node_tree.nodes.get("Principled BSDF") if material.node_tree else None
    if shader is not None:
        shader.inputs["Base Color"].default_value = material.diffuse_color
        shader.inputs["Roughness"].default_value = 0.65
    mesh.materials.append(material)
    _apply_transform(obj, transform)
    obj.hide_render = not visible
    obj.hide_viewport = not visible
    obj["ai_canvas_entity_id"] = entity_id
    obj["ai_canvas_placeholder"] = True
    return obj


def _create_preview_lighting(collection):
    key_data = bpy.data.lights.new("AI Canvas Key", type="AREA")
    key_data.energy = 900
    key_data.shape = "DISK"
    key_data.size = 4
    key = bpy.data.objects.new("AI Canvas Key", key_data)
    collection.objects.link(key)
    key.location = (4.5, -4.5, 6.0)
    key.rotation_euler = (Vector((0.0, 0.0, 0.8)) - key.location).to_track_quat("-Z", "Y").to_euler("XYZ")

    fill_data = bpy.data.lights.new("AI Canvas Fill", type="AREA")
    fill_data.energy = 500
    fill_data.color = (0.55, 0.7, 1.0)
    fill_data.size = 5
    fill = bpy.data.objects.new("AI Canvas Fill", fill_data)
    collection.objects.link(fill)
    fill.location = (-4.0, -1.5, 3.5)
    fill.rotation_euler = (Vector((0.0, 0.0, 0.8)) - fill.location).to_track_quat("-Z", "Y").to_euler("XYZ")


def _action_fcurves(id_block):
    animation_data = getattr(id_block, "animation_data", None)
    action = getattr(animation_data, "action", None)
    if action is None:
        return []

    curves = []
    seen = set()
    slot = getattr(animation_data, "action_slot", None)
    if slot is not None:
        for layer in getattr(action, "layers", ()):
            for strip in getattr(layer, "strips", ()):
                if getattr(strip, "type", None) != "KEYFRAME":
                    continue
                try:
                    channelbag = strip.channelbag(slot, ensure=False)
                except TypeError:
                    channelbag = strip.channelbag(slot)
                if channelbag is None:
                    continue
                for curve in channelbag.fcurves:
                    pointer = curve.as_pointer()
                    if pointer not in seen:
                        seen.add(pointer)
                        curves.append(curve)

    if curves:
        return curves
    for curve in getattr(action, "fcurves", ()):
        pointer = curve.as_pointer()
        if pointer not in seen:
            seen.add(pointer)
            curves.append(curve)
    return curves


def _set_keyframe_interpolation(id_block, frame, interpolation, label, minimum_matches):
    matches = 0
    for curve in _action_fcurves(id_block):
        for point in curve.keyframe_points:
            if math.isclose(float(point.co[0]), frame, rel_tol=0, abs_tol=0.000001):
                point.interpolation = interpolation.upper()
                matches += 1
    if matches < minimum_matches:
        raise ProtocolError(f"{label} animation curves are unavailable")


def _create_camera(camera_value, collection, timeline):
    camera = _object(camera_value, "camera")
    allowed = {
        "cameraId", "name", "transform", "focalLengthMm", "sensorWidthMm",
        "apertureFStop", "focusDistanceM", "keyframes",
    }
    _known_keys(camera, allowed, "camera")
    camera_id = _identifier(camera.get("cameraId"), "camera.cameraId")
    data = bpy.data.cameras.new(f"AI_{camera_id}_data")
    data.lens = _number(camera.get("focalLengthMm"), "camera.focalLengthMm", 0.1, 2_000)
    data.sensor_width = _number(camera.get("sensorWidthMm"), "camera.sensorWidthMm", 0.1, 1_000)
    data.dof.use_dof = True
    data.dof.aperture_fstop = _number(camera.get("apertureFStop"), "camera.apertureFStop", 0.1, 128)
    data.dof.focus_distance = _number(camera.get("focusDistanceM"), "camera.focusDistanceM", 0, 1_000_000_000)
    obj = bpy.data.objects.new(f"AI_{camera_id}", data)
    collection.objects.link(obj)
    _apply_transform(obj, _transform(camera.get("transform"), "camera.transform"))
    obj["ai_canvas_camera_id"] = camera_id

    keyframes = _array(camera.get("keyframes"), "camera.keyframes", MAX_KEYFRAMES)
    for keyframe_value in keyframes:
        keyframe = _object(keyframe_value, "camera.keyframe")
        allowed_keyframe = {
            "frame", "interpolation", "transform", "focalLengthMm",
            "apertureFStop", "focusDistanceM",
        }
        _known_keys(keyframe, allowed_keyframe, "camera.keyframe")
        frame = _integer(keyframe.get("frame"), "camera.keyframe.frame", minimum=0)
        if frame < timeline[0] or frame > timeline[1]:
            raise ProtocolError("camera keyframe is outside the timeline")
        _apply_transform(obj, _transform(keyframe.get("transform"), "camera.keyframe.transform"))
        obj.keyframe_insert(data_path="location", frame=frame)
        obj.keyframe_insert(data_path="rotation_euler", frame=frame)
        obj.keyframe_insert(data_path="scale", frame=frame)
        camera_curve_count = 0
        if keyframe.get("focalLengthMm") is not None:
            data.lens = _number(keyframe["focalLengthMm"], "camera.keyframe.focalLengthMm", 0.1, 2_000)
            data.keyframe_insert(data_path="lens", frame=frame)
            camera_curve_count += 1
        if keyframe.get("apertureFStop") is not None:
            data.dof.aperture_fstop = _number(keyframe["apertureFStop"], "camera.keyframe.apertureFStop", 0.1, 128)
            data.dof.keyframe_insert(data_path="aperture_fstop", frame=frame)
            camera_curve_count += 1
        if keyframe.get("focusDistanceM") is not None:
            data.dof.focus_distance = _number(keyframe["focusDistanceM"], "camera.keyframe.focusDistanceM", 0, 1_000_000_000)
            data.dof.keyframe_insert(data_path="focus_distance", frame=frame)
            camera_curve_count += 1
        interpolation = keyframe.get("interpolation")
        if interpolation not in {"constant", "linear", "bezier"}:
            raise ProtocolError("camera interpolation is unsupported")
        _set_keyframe_interpolation(
            obj, frame, interpolation, "camera object", minimum_matches=9
        )
        if camera_curve_count:
            _set_keyframe_interpolation(
                data,
                frame,
                interpolation,
                "camera data",
                minimum_matches=camera_curve_count,
            )
    return camera_id, obj


def _configure_fps(scene, fps):
    numerator = max(1, int(round(fps)))
    fps_base = numerator / fps
    scene.render.fps = numerator
    scene.render.fps_base = fps_base
    effective_fps = scene.render.fps / scene.render.fps_base
    if not math.isclose(effective_fps, fps, rel_tol=0.000001, abs_tol=0.000001):
        raise ProtocolError("scene timeline fps cannot be represented by Blender")


def _build_scene(scene_value, request):
    _clear_scene()
    scene = bpy.context.scene
    scene.name = "AI Canvas Director"
    scene["ai_canvas_scene_id"] = scene_value["raw"]["sceneId"]
    scene["ai_canvas_scene_revision"] = scene_value["raw"]["revision"]
    scene["ai_canvas_scene_sha256"] = request["sceneSha256"]
    scene["ai_canvas_adapter_version"] = ADAPTER_VERSION
    scene["ai_canvas_template_id"] = EXPECTED_TEMPLATE_ID
    scene["ai_canvas_template_version"] = EXPECTED_TEMPLATE_VERSION
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.render.engine = "BLENDER_EEVEE"
    _configure_fps(scene, scene_value["fps"])
    scene.frame_start = scene_value["startFrame"]
    scene.frame_end = scene_value["endFrame"]
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 50
    if hasattr(scene.render.image_settings, "media_type"):
        scene.render.image_settings.media_type = "IMAGE"
    scene.render.image_settings.file_format = "PNG"

    world = bpy.data.worlds.new("AI Canvas World") if scene.world is None else scene.world
    scene.world = world
    background = world.node_tree.nodes.get("Background")
    if background is not None:
        color = scene_value["worldColor"]
        background.inputs["Color"].default_value = (*color, 1.0)
        background.inputs["Strength"].default_value = 0.8

    collection = _director_collection(scene)
    _create_preview_lighting(collection)
    for entity in scene_value["entities"]:
        _placeholder_mesh(_object(entity, "entity"), collection)

    cameras = {}
    for camera in scene_value["cameras"]:
        camera_id, obj = _create_camera(camera, collection, (scene.frame_start, scene.frame_end))
        if camera_id in cameras:
            raise ProtocolError("camera IDs must be unique")
        cameras[camera_id] = obj

    shot_ranges = []
    for shot_value in scene_value["shots"]:
        shot = _object(shot_value, "shot")
        _known_keys(shot, {"shotId", "name", "startFrame", "endFrame", "cameraId"}, "shot")
        shot_id = _identifier(shot.get("shotId"), "shot.shotId")
        camera_id = _identifier(shot.get("cameraId"), "shot.cameraId")
        start = _integer(shot.get("startFrame"), "shot.startFrame", minimum=0)
        end = _integer(shot.get("endFrame"), "shot.endFrame", minimum=0)
        if start < scene.frame_start or end > scene.frame_end or end < start or camera_id not in cameras:
            raise ProtocolError("shot is invalid")
        scene.timeline_markers.new(f"SHOT_{shot_id}", frame=start).camera = cameras[camera_id]
        shot_ranges.append((start, end, camera_id))
    scene.camera = cameras[shot_ranges[0][2]]
    return scene, cameras, shot_ranges


def _camera_for_frame(scene, cameras, shots, frame):
    for start, end, camera_id in shots:
        if start <= frame <= end:
            scene.camera = cameras[camera_id]
            return
    raise ProtocolError("target frame is not covered by a shot")


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
    return hasher.hexdigest(), size


def _require_finished(result, label):
    if result != {"FINISHED"}:
        raise ProtocolError(f"{label} did not finish")


def _load_base_scene(job_dir, request, scene_value):
    descriptor = request["baseBlend"]
    if descriptor is None:
        return None

    base_path = job_dir / "input" / descriptor["stagedFileName"]
    try:
        metadata = base_path.stat()
    except OSError as error:
        raise ProtocolError("base Blender project is unavailable") from error
    if (
        not base_path.is_file()
        or base_path.is_symlink()
        or metadata.st_size != descriptor["bytes"]
    ):
        raise ProtocolError("base Blender project is invalid")
    digest, size = _hash_file(base_path)
    if digest != descriptor["sha256"] or size != descriptor["bytes"]:
        raise ProtocolError("base Blender project hash does not match request")

    open_result = bpy.ops.wm.open_mainfile(
        filepath=str(base_path),
        load_ui=False,
        use_scripts=False,
    )
    _require_finished(open_result, "base Blender project open")
    _assert_runtime()
    scene = bpy.context.scene
    expected_properties = {
        "ai_canvas_scene_id": request["sceneId"],
        "ai_canvas_scene_revision": request["sceneRevision"],
        "ai_canvas_scene_sha256": request["sceneSha256"],
        "ai_canvas_adapter_version": ADAPTER_VERSION,
    }
    if any(scene.get(key) != value for key, value in expected_properties.items()):
        raise ProtocolError("base Blender project scene binding is invalid")

    if request["sceneSource"] == "saved-blender":
        # The managed file binding still applies; artist-created cameras do not
        # need to copy IDs from the portable Director Scene camera table.
        return scene, {}, []

    expected_camera_ids = {
        _identifier(camera.get("cameraId"), "scene.camera.cameraId")
        for camera in scene_value["cameras"]
    }
    cameras = {}
    for obj in scene.objects:
        camera_id = obj.get("ai_canvas_camera_id")
        if camera_id is None:
            continue
        camera_id = _identifier(camera_id, "base Blender camera ID")
        if obj.type != "CAMERA" or camera_id in cameras:
            raise ProtocolError("base Blender camera binding is invalid")
        cameras[camera_id] = obj
    if set(cameras) != expected_camera_ids:
        raise ProtocolError("base Blender cameras do not match the Director Scene")

    shots = []
    for shot_value in scene_value["shots"]:
        shot = _object(shot_value, "scene.shot")
        shots.append((
            _integer(shot.get("startFrame"), "scene.shot.startFrame", minimum=0),
            _integer(shot.get("endFrame"), "scene.shot.endFrame", minimum=0),
            _identifier(shot.get("cameraId"), "scene.shot.cameraId"),
        ))
    return scene, cameras, shots


def _reset_camera_markers(scene, cameras, shots):
    for marker in list(scene.timeline_markers):
        if marker.camera is not None:
            scene.timeline_markers.remove(marker)
    for index, (start, _end, camera_id) in enumerate(shots):
        scene.timeline_markers.new(f"AI_CANVAS_SHOT_{index + 1}", frame=start).camera = cameras[camera_id]


def _require_scene_camera(scene, camera):
    if (
        camera is None
        or camera.type != "CAMERA"
        or scene.objects.get(camera.name) != camera
    ):
        raise ProtocolError("saved Blender camera does not belong to the managed scene")


def _configure_job_scene(scene, cameras, shots, scene_data, request):
    """Choose a fixed render source without changing a saved animation timeline."""
    saved = request["sceneSource"] == "saved-blender"
    operation = request["operation"]
    if saved:
        start = _integer(scene.frame_start, "saved scene start frame", minimum=0)
        end = _integer(scene.frame_end, "saved scene end frame", minimum=0)
        if end < start:
            raise ProtocolError("saved Blender timeline is invalid")
        numerator = _number(scene.render.fps, "saved scene fps", 1, MAX_FRAME)
        denominator = _number(scene.render.fps_base, "saved scene fps base", 0.000001, MAX_FRAME)
        fps = _number(numerator / denominator, "saved scene effective fps", 1, 240)
        if operation == "render-video":
            frame_count = end - start + 1
            if frame_count > MAX_VIDEO_FRAMES or frame_count / fps > MAX_SAVED_VIDEO_SECONDS:
                raise ProtocolError("saved Blender video exceeds frame count or duration limit")
            if scene.frame_step != 1:
                raise ProtocolError("saved Blender video requires a frame step of one")
        scene_cameras = [obj for obj in scene.objects if obj.type == "CAMERA"]
        camera_markers = [marker for marker in scene.timeline_markers if marker.camera is not None]
        if len(scene_cameras) > MAX_CAMERAS or len(camera_markers) > MAX_SHOTS:
            raise ProtocolError("saved Blender camera or shot count exceeds the limit")
        _require_scene_camera(scene, scene.camera)
        for marker in camera_markers:
            _require_scene_camera(scene, marker.camera)
    else:
        scene.frame_start = scene_data["startFrame"]
        scene.frame_end = scene_data["endFrame"]
        scene.frame_step = 1
        _configure_fps(scene, scene_data["fps"])
        _reset_camera_markers(scene, cameras, shots)
        start, end = scene.frame_start, scene.frame_end
        fps = scene.render.fps / scene.render.fps_base

    # Output dimensions remain a fixed preview contract, not values from IPC.
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 50
    target_frame = request["targetFrame"]
    if target_frame is None:
        target_frame = scene.frame_current if saved and operation != "render-video" else start
    target_frame = _integer(target_frame, "target frame", minimum=0)
    if operation != "open-editor" and not start <= target_frame <= end:
        raise ProtocolError("target frame is outside the selected scene timeline")
    if not saved:
        _camera_for_frame(scene, cameras, shots, target_frame)
    scene.frame_set(target_frame)
    if saved:
        _require_scene_camera(scene, scene.camera)
    return target_frame, fps


def _artifact(path, artifact_prefix, kind, mime_type, **metadata):
    if not path.is_file() or path.is_symlink():
        raise ProtocolError("expected output artifact is unavailable")
    digest, size = _hash_file(path)
    value = {
        "artifactId": f"{artifact_prefix}-{digest}",
        "kind": kind,
        "mimeType": mime_type,
        "stagedFileName": path.name,
        "sha256": digest,
        "bytes": size,
    }
    value.update(metadata)
    return value


def _write_result(output_dir, request, artifacts):
    result = {
        "schemaVersion": 1,
        "protocol": PROTOCOL,
        "jobId": request["jobId"],
        "sceneId": request["sceneId"],
        "sceneRevision": request["sceneRevision"],
        "sceneSha256": request["sceneSha256"],
        "manifestRevision": request["manifestRevision"],
        "producer": {
            "runtime": "blender",
            "adapterVersion": ADAPTER_VERSION,
            "blenderVersion": bpy.app.version_string,
        },
        "artifactCandidates": artifacts,
    }
    encoded = (json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    if len(encoded) > MAX_REQUEST_BYTES:
        raise ProtocolError("job result exceeds its size limit")

    result_path = output_dir / "job-result.json"
    temporary_path = output_dir / ".job-result.json.tmp"
    if result_path.is_symlink() or temporary_path.is_symlink():
        raise ProtocolError("job result path is invalid")
    try:
        if temporary_path.exists():
            if not temporary_path.is_file():
                raise ProtocolError("job result temporary path is invalid")
            temporary_path.unlink()
        with temporary_path.open("xb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, result_path)
    except ProtocolError:
        raise
    except OSError as error:
        try:
            if temporary_path.exists() and not temporary_path.is_symlink():
                temporary_path.unlink()
        except OSError:
            pass
        raise ProtocolError("job result could not be committed") from error


def _run_job(job_dir):
    request_value, _ = _read_json(job_dir / "request.json", MAX_REQUEST_BYTES, "request")
    request = _validate_request(request_value)
    scene_value, scene_bytes = _read_json(job_dir / "input" / "scene.json", MAX_SCENE_BYTES, "scene")
    scene_data = _validate_scene(scene_value, scene_bytes, request)

    output_dir = job_dir / "output"
    if output_dir.is_symlink():
        raise ProtocolError("output directory is invalid")
    if output_dir.exists():
        if not output_dir.is_dir() or output_dir.is_symlink():
            raise ProtocolError("output directory is invalid")
        if any(output_dir.iterdir()):
            raise ProtocolError("output directory is not empty")
    else:
        output_dir.mkdir()

    loaded = _load_base_scene(job_dir, request, scene_data)
    if loaded is None:
        scene, cameras, shots = _build_scene(scene_data, request)
    else:
        scene, cameras, shots = loaded
    operation = request["operation"]
    target_frame, effective_fps = _configure_job_scene(scene, cameras, shots, scene_data, request)

    artifacts = []
    blend_path = output_dir / "project.blend"

    if operation == "open-editor":
        # Open-editor saves the same managed file again when the user chooses
        # "Save and Return". Prevent an undeclared ``project.blend1`` side
        # artifact in the isolated Blender profile.
        bpy.context.preferences.filepaths.save_version = 0
        save_result = bpy.ops.wm.save_as_mainfile(
            filepath=str(blend_path),
            compress=False,
        )
        _require_finished(save_result, "AI Canvas editor project save")
        bpy.app.driver_namespace[EDITOR_SESSION_KEY] = {
            "jobDir": str(job_dir),
            "outputDir": str(output_dir),
            "jobId": request["jobId"],
            "sceneId": request["sceneId"],
            "sceneRevision": request["sceneRevision"],
            "sceneSha256": request["sceneSha256"],
            "manifestRevision": request["manifestRevision"],
            "adapterVersion": ADAPTER_VERSION,
            "blenderVersion": bpy.app.version_string,
        }
        return

    if operation == "render-frame":
        frame_path = output_dir / "frame.png"
        scene.render.filepath = str(frame_path)
        if hasattr(scene.render.image_settings, "media_type"):
            scene.render.image_settings.media_type = "IMAGE"
        scene.render.image_settings.file_format = "PNG"
        _require_finished(
            bpy.ops.render.render(write_still=True),
            "AI Canvas frame render",
        )
        artifacts.append(_artifact(
            frame_path,
            "frame",
            "frame-image",
            "image/png",
            frame=target_frame,
        ))
    elif operation == "render-video":
        video_path = output_dir / "reference.mp4"
        scene.render.filepath = str(video_path)
        if hasattr(scene.render.image_settings, "media_type"):
            scene.render.image_settings.media_type = "VIDEO"
        scene.render.image_settings.file_format = "FFMPEG"
        scene.render.ffmpeg.format = "MPEG4"
        scene.render.ffmpeg.codec = "H264"
        scene.render.ffmpeg.constant_rate_factor = "MEDIUM"
        scene.render.ffmpeg.audio_codec = "NONE"
        _require_finished(
            bpy.ops.render.render(animation=True),
            "AI Canvas video render",
        )
        artifacts.append(_artifact(
            video_path,
            "video",
            "reference-video",
            "video/mp4",
            startFrame=scene.frame_start,
            endFrame=scene.frame_end,
            fps=effective_fps,
        ))

    _require_finished(
        bpy.ops.wm.save_as_mainfile(
            filepath=str(blend_path),
            copy=True,
            compress=False,
        ),
        "AI Canvas Blender project save",
    )
    artifacts.append(_artifact(
        blend_path,
        "blend",
        "blend-project",
        "application/x-blender",
    ))
    _write_result(output_dir, request, artifacts)


def main():
    _assert_runtime()
    job_dir = Path.cwd().resolve(strict=True)
    _run_job(job_dir)


if __name__ == "__main__":
    try:
        main()
    except ProtocolError as error:
        print(f"AI_CANVAS_JOB_ERROR:{error}", file=sys.stderr)
        raise SystemExit(23) from error
