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

import bmesh
import blf
import bpy
import gpu
from bpy.app.handlers import persistent
from bpy.props import EnumProperty, FloatProperty, StringProperty
from bpy_extras.io_utils import ImportHelper
from gpu_extras.batch import batch_for_shader
from mathutils import Vector


TEMPLATE_ID = "ai_canvas_director"
TEMPLATE_VERSION = 1
EDITOR_SESSION_KEY = "ai_canvas_director_editor_session_v1"
EDITOR_BLEND_NAME = "project.blend"
EDITOR_BLEND_STAGING_NAME = ".project-return-staging.blend"
EDITOR_RESULT_NAME = "job-result.json"
EDITOR_RESULT_STAGING_NAME = ".job-result.json.tmp"
DIRECTOR_COLLECTION_NAME = "AI Canvas Director Console"
DIRECTOR_OWNER_KEY = "ai_canvas_console_owner"
DIRECTOR_OWNER_TOKEN = "ai_canvas_director_console_v1"
DIRECTOR_MANAGED_KEY = "ai_canvas_console_managed"
DIRECTOR_KIND_KEY = "ai_canvas_console_kind"
DIRECTOR_IMPORTED_KEY = "ai_canvas_console_imported"
DIRECTOR_COLLECTION_SCENE_KEY = "ai_canvas_console_collection"
DIRECTOR_MATERIAL_ROLE_KEY = "ai_canvas_console_material_role"
DIRECTOR_PREVIOUS_WORLD_KEY = "ai_canvas_console_previous_world"
DIRECTOR_CONSOLE_ATTEMPTS_KEY = "ai_canvas_console_activation_attempts"
DIRECTOR_IMPORT_SUFFIXES = {".fbx", ".glb", ".gltf", ".obj"}
CAMERA_PREVIEW_MARGIN = 16
CAMERA_PREVIEW_HEADER_HEIGHT = 28
CAMERA_PREVIEW_REFRESH_SECONDS = 0.12


_CAMERA_PREVIEW_STATE = {
    "handler": None,
    "window_pointer": 0,
    "area_pointer": 0,
    "region_pointer": 0,
    "offscreen": None,
    "offscreen_size": None,
    "close_rect": None,
    "close_hover": False,
    "drawing": False,
    "stopping": False,
    "dirty": True,
    "texture_valid": False,
    "last_render_at": 0.0,
    "render_count": 0,
    "generation": 0,
    "last_error": None,
}


def _has_editor_session():
    return isinstance(bpy.app.driver_namespace.get(EDITOR_SESSION_KEY), dict)


def _editor_operator_poll(context):
    return (
        context.scene is not None
        and context.mode == "OBJECT"
        and _has_editor_session()
    )


def _collection_contains(root, target):
    if root == target:
        return True
    return any(_collection_contains(child, target) for child in root.children)


def _collection_scenes(collection):
    return [
        scene for scene in bpy.data.scenes
        if _collection_contains(scene.collection, collection)
    ]


def _existing_director_collection(scene):
    collection_name = scene.get(DIRECTOR_COLLECTION_SCENE_KEY)
    if not isinstance(collection_name, str) or not collection_name:
        return None
    collection = bpy.data.collections.get(collection_name)
    if (
        collection is None
        or collection.get(DIRECTOR_OWNER_KEY) != DIRECTOR_OWNER_TOKEN
        or not _collection_contains(scene.collection, collection)
        or _collection_scenes(collection) != [scene]
    ):
        return None
    return collection


def _director_collection(scene):
    collection = _existing_director_collection(scene)
    if collection is not None:
        return collection
    collection = bpy.data.collections.new(DIRECTOR_COLLECTION_NAME)
    collection[DIRECTOR_OWNER_KEY] = DIRECTOR_OWNER_TOKEN
    scene.collection.children.link(collection)
    scene[DIRECTOR_COLLECTION_SCENE_KEY] = collection.name
    return collection


def _mark_console_object(obj, kind):
    obj[DIRECTOR_OWNER_KEY] = DIRECTOR_OWNER_TOKEN
    obj[DIRECTOR_MANAGED_KEY] = True
    obj[DIRECTOR_KIND_KEY] = kind


def _ensure_material(name, color, roughness=0.65, metallic=0.0):
    material = next(
        (
            candidate for candidate in bpy.data.materials
            if candidate.get(DIRECTOR_OWNER_KEY) == DIRECTOR_OWNER_TOKEN
            and candidate.get(DIRECTOR_MATERIAL_ROLE_KEY) == name
        ),
        None,
    )
    if material is None:
        material = bpy.data.materials.new(name)
        material[DIRECTOR_OWNER_KEY] = DIRECTOR_OWNER_TOKEN
        material[DIRECTOR_MATERIAL_ROLE_KEY] = name
    material.diffuse_color = (*color, 1.0)
    material.use_nodes = True
    shader = next(
        (node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"),
        None,
    )
    if shader is not None:
        base_color = shader.inputs.get("Base Color")
        if base_color is not None:
            base_color.default_value = material.diffuse_color
        shader_roughness = shader.inputs.get("Roughness")
        if shader_roughness is not None:
            shader_roughness.default_value = roughness
        shader_metallic = shader.inputs.get("Metallic")
        if shader_metallic is not None:
            shader_metallic.default_value = metallic
    return material


def _new_mesh_object(name, collection, build_mesh, location, scale, material, kind):
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    bm = bmesh.new()
    try:
        build_mesh(bm)
        bm.to_mesh(mesh)
    finally:
        bm.free()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.location = location
    obj.scale = scale
    if material is not None:
        mesh.materials.append(material)
    _mark_console_object(obj, kind)
    return obj


def _new_box(name, collection, location, dimensions, material, kind):
    return _new_mesh_object(
        name,
        collection,
        lambda bm: bmesh.ops.create_cube(bm, size=1.0, calc_uvs=True),
        location,
        dimensions,
        material,
        kind,
    )


def _new_sphere(name, collection, location, diameter, material, kind):
    return _new_mesh_object(
        name,
        collection,
        lambda bm: bmesh.ops.create_uvsphere(
            bm,
            u_segments=24,
            v_segments=12,
            radius=0.5,
            calc_uvs=True,
        ),
        location,
        (diameter, diameter, diameter),
        material,
        kind,
    )


def _select_objects(context, objects, active=None):
    for obj in context.view_layer.objects:
        obj.select_set(False)
    selected = []
    for obj in objects:
        try:
            obj.select_set(True)
            selected.append(obj)
        except RuntimeError:
            continue
    if selected:
        context.view_layer.objects.active = active if active in selected else selected[0]


def _remove_console_objects(scene, kinds):
    collection = _existing_director_collection(scene)
    if collection is None:
        return 0
    removed = 0
    for obj in list(collection.objects):
        if obj.get(DIRECTOR_OWNER_KEY) != DIRECTOR_OWNER_TOKEN:
            continue
        if obj.get(DIRECTOR_MANAGED_KEY) is not True:
            continue
        if obj.get(DIRECTOR_KIND_KEY) not in kinds:
            continue
        if len(obj.users_collection) != 1 or obj.users_collection[0] != collection:
            collection.objects.unlink(obj)
            removed += 1
            continue
        data = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        if data is not None and data.users == 0:
            if isinstance(data, bpy.types.Mesh):
                bpy.data.meshes.remove(data)
            elif isinstance(data, bpy.types.Light):
                bpy.data.lights.remove(data)
        removed += 1
    return removed


IMPORT_DATABLOCK_GROUPS = (
    "actions",
    "armatures",
    "cameras",
    "curves",
    "images",
    "lights",
    "materials",
    "meshes",
    "node_groups",
    "textures",
)


def _snapshot_import_state():
    snapshot = {
        "objects": {obj.as_pointer() for obj in bpy.data.objects},
        "collections": {collection.as_pointer() for collection in bpy.data.collections},
    }
    for group_name in IMPORT_DATABLOCK_GROUPS:
        snapshot[group_name] = {
            datablock.as_pointer() for datablock in getattr(bpy.data, group_name)
        }
    return snapshot


def _remove_new_import_data(before):
    for obj in list(bpy.data.objects):
        if obj.as_pointer() in before["objects"]:
            continue
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in list(bpy.data.collections):
        if collection.as_pointer() in before["collections"]:
            continue
        if collection.objects:
            continue
        bpy.data.collections.remove(collection, do_unlink=True)
    for group_name in IMPORT_DATABLOCK_GROUPS:
        group = getattr(bpy.data, group_name)
        for datablock in list(group):
            if datablock.as_pointer() in before[group_name] or datablock.users != 0:
                continue
            group.remove(datablock)


def _target_bounds(context):
    candidates = [
        obj for obj in context.selected_objects
        if obj.type not in {"CAMERA", "LIGHT"}
    ]
    points = []
    for obj in candidates:
        points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    if not points:
        return Vector((0.0, 0.0, 1.2)), 1.0
    minimum = Vector((
        min(point.x for point in points),
        min(point.y for point in points),
        min(point.z for point in points),
    ))
    maximum = Vector((
        max(point.x for point in points),
        max(point.y for point in points),
        max(point.z for point in points),
    ))
    center = (minimum + maximum) * 0.5
    radius = max((maximum - minimum).length * 0.5, 0.5)
    return center, radius


def _active_protocol_camera(scene):
    camera = scene.camera
    if camera is not None and camera.type == "CAMERA" and camera.get("ai_canvas_camera_id"):
        return camera
    return next(
        (
            obj for obj in scene.objects
            if obj.type == "CAMERA" and obj.get("ai_canvas_camera_id")
        ),
        None,
    )


def _camera_preview_is_active():
    return (
        not _CAMERA_PREVIEW_STATE["stopping"]
        and _CAMERA_PREVIEW_STATE["handler"] is not None
        and _CAMERA_PREVIEW_STATE["area_pointer"] != 0
        and _CAMERA_PREVIEW_STATE["region_pointer"] != 0
    )


def _camera_preview_target_context():
    if bpy.app.background:
        return None
    window_manager = bpy.context.window_manager
    current_window = bpy.context.window
    current_window_is_available = (
        current_window is not None
        and any(
            window.as_pointer() == current_window.as_pointer()
            for window in window_manager.windows
        )
    )
    if current_window_is_available:
        windows = (current_window,)
    elif len(window_manager.windows) == 1:
        windows = (window_manager.windows[0],)
    else:
        return None
    candidates = []
    for window in windows:
        screen = window.screen
        if screen is None:
            continue
        for area in screen.areas:
            if area.type != "VIEW_3D":
                continue
            region = next(
                (candidate for candidate in area.regions if candidate.type == "WINDOW"),
                None,
            )
            if region is not None:
                candidates.append((area.width * area.height, window, screen, area, region))
    if not candidates:
        return None
    _, window, screen, area, region = max(candidates, key=lambda item: item[0])
    return window, screen, area, region


def _camera_preview_owner():
    area_pointer = _CAMERA_PREVIEW_STATE["area_pointer"]
    region_pointer = _CAMERA_PREVIEW_STATE["region_pointer"]
    window_pointer = _CAMERA_PREVIEW_STATE["window_pointer"]
    if not area_pointer or not region_pointer or not window_pointer:
        return None
    for window in bpy.context.window_manager.windows:
        if window.as_pointer() != window_pointer or window.screen is None:
            continue
        for area in window.screen.areas:
            if area.as_pointer() != area_pointer or area.type != "VIEW_3D":
                continue
            region = next(
                (
                    candidate for candidate in area.regions
                    if candidate.as_pointer() == region_pointer
                    and candidate.type == "WINDOW"
                ),
                None,
            )
            if region is not None:
                return window, area, region
    return None


def _tag_camera_preview_ui_redraw(owner=None):
    if bpy.app.background:
        return
    owner = owner or _camera_preview_owner()
    if owner is None:
        return
    window, preview_area, _region = owner
    preview_area.tag_redraw()
    if window.screen is not None:
        for area in window.screen.areas:
            if area.type == "PROPERTIES":
                area.tag_redraw()


def _camera_preview_geometry(region, scene):
    if region.width < 320 or region.height < 260:
        return None
    render = scene.render
    render_width = max(render.resolution_x * render.pixel_aspect_x, 1.0)
    render_height = max(render.resolution_y * render.pixel_aspect_y, 1.0)
    aspect = max(0.25, min(render_width / render_height, 4.0))
    maximum_width = max(region.width - CAMERA_PREVIEW_MARGIN * 2, 1)
    width = min(420, max(280, int(region.width * 0.23)), maximum_width)
    maximum_total_height = min(320, max(180, int(region.height * 0.32)))
    maximum_image_height = maximum_total_height - CAMERA_PREVIEW_HEADER_HEIGHT
    image_height = max(1, int(round(width / aspect)))
    if image_height > maximum_image_height:
        image_height = maximum_image_height
        width = min(width, int(round(image_height * aspect)))
    if width < 180 or image_height < 100:
        return None
    x = region.width - width - CAMERA_PREVIEW_MARGIN
    y = CAMERA_PREVIEW_MARGIN
    total_height = image_height + CAMERA_PREVIEW_HEADER_HEIGHT
    close_size = 22
    close_x = x + width - close_size - 3
    close_y = y + image_height + 3
    return {
        "x": x,
        "y": y,
        "width": width,
        "image_height": image_height,
        "total_height": total_height,
        "close_rect": (close_x, close_y, close_size, close_size),
    }


def _camera_preview_rounded_mesh(x, y, width, height, corner_radii, segments=5):
    maximum_radius = min(width, height) * 0.5
    radii = tuple(
        max(0.0, min(float(radius), maximum_radius))
        for radius in corner_radii
    )
    corner_specs = (
        (x + radii[0], y + radii[0], radii[0], math.pi, math.pi * 1.5),
        (
            x + width - radii[1],
            y + radii[1],
            radii[1],
            math.pi * 1.5,
            math.pi * 2.0,
        ),
        (
            x + width - radii[2],
            y + height - radii[2],
            radii[2],
            0.0,
            math.pi * 0.5,
        ),
        (
            x + radii[3],
            y + height - radii[3],
            radii[3],
            math.pi * 0.5,
            math.pi,
        ),
    )
    boundary = []
    for center_x, center_y, radius, start_angle, end_angle in corner_specs:
        if radius == 0.0:
            boundary.append((center_x, center_y))
            continue
        for step in range(segments + 1):
            angle = start_angle + (end_angle - start_angle) * step / segments
            boundary.append((
                center_x + math.cos(angle) * radius,
                center_y + math.sin(angle) * radius,
            ))
    positions = [(x + width * 0.5, y + height * 0.5), *boundary]
    indices = []
    for boundary_index in range(len(boundary)):
        current = boundary_index + 1
        following = (boundary_index + 1) % len(boundary) + 1
        indices.append((0, current, following))
    return positions, indices


def _draw_camera_preview_rect(
    x,
    y,
    width,
    height,
    color,
    corner_radii=(0.0, 0.0, 0.0, 0.0),
):
    positions, indices = _camera_preview_rounded_mesh(
        x,
        y,
        width,
        height,
        corner_radii,
    )
    shader = gpu.shader.from_builtin("UNIFORM_COLOR")
    batch = batch_for_shader(
        shader,
        "TRIS",
        {"pos": positions},
        indices=indices,
    )
    shader.bind()
    shader.uniform_float("color", color)
    batch.draw(shader)


def _draw_camera_preview_texture(texture, x, y, width, height, corner_radii):
    positions, indices = _camera_preview_rounded_mesh(
        x,
        y,
        width,
        height,
        corner_radii,
    )
    texture_coordinates = [
        ((position_x - x) / width, (position_y - y) / height)
        for position_x, position_y in positions
    ]
    shader = gpu.shader.from_builtin("IMAGE")
    batch = batch_for_shader(
        shader,
        "TRIS",
        {"pos": positions, "texCoord": texture_coordinates},
        indices=indices,
    )
    shader.uniform_sampler("image", texture)
    batch.draw(shader)


def _draw_camera_preview_cross(x, y, size, color):
    inset = 7
    shader = gpu.shader.from_builtin("UNIFORM_COLOR")
    batch = batch_for_shader(
        shader,
        "LINES",
        {"pos": (
            (x + inset, y + inset),
            (x + size - inset, y + size - inset),
            (x + size - inset, y + inset),
            (x + inset, y + size - inset),
        )},
    )
    shader.bind()
    shader.uniform_float("color", color)
    batch.draw(shader)


def _draw_camera_preview_text(text, x, y, size=13.0, color=(0.92, 0.94, 1.0, 1.0)):
    font_id = 0
    blf.size(font_id, size)
    blf.color(font_id, *color)
    blf.position(font_id, x, y, 0.0)
    blf.draw(font_id, text)


def _draw_camera_preview_centered_text(
    text,
    x,
    y,
    height,
    size=13.0,
    color=(0.92, 0.94, 1.0, 1.0),
):
    font_id = 0
    blf.size(font_id, size)
    _text_width, text_height = blf.dimensions(font_id, text)
    baseline_compensation = 3.0
    text_y = y + (height - text_height) * 0.5 + baseline_compensation
    _draw_camera_preview_text(text, x, text_y, size, color)


def _capture_camera_preview_gpu_state():
    return {
        "blend": gpu.state.blend_get(),
        "depth_mask": gpu.state.depth_mask_get(),
        "depth_test": gpu.state.depth_test_get(),
        "line_width": gpu.state.line_width_get(),
        "viewport": tuple(gpu.state.viewport_get()),
        "scissor": tuple(gpu.state.scissor_get()),
    }


def _restore_camera_preview_gpu_state(state):
    restore_operations = (
        (gpu.state.viewport_set, state["viewport"]),
        (gpu.state.scissor_set, state["scissor"]),
        (gpu.state.line_width_set, (state["line_width"],)),
        (gpu.state.depth_mask_set, (state["depth_mask"],)),
        (gpu.state.depth_test_set, (state["depth_test"],)),
        (gpu.state.blend_set, (state["blend"],)),
    )
    for operation, arguments in restore_operations:
        try:
            operation(*arguments)
        except Exception:
            pass


def _free_camera_preview_offscreen():
    offscreen = _CAMERA_PREVIEW_STATE.get("offscreen")
    _CAMERA_PREVIEW_STATE["offscreen"] = None
    _CAMERA_PREVIEW_STATE["offscreen_size"] = None
    if offscreen is not None:
        try:
            offscreen.free()
        except Exception:
            pass


def _ensure_camera_preview_offscreen(width, height):
    size = (width, height)
    if (
        _CAMERA_PREVIEW_STATE["offscreen"] is not None
        and _CAMERA_PREVIEW_STATE["offscreen_size"] == size
    ):
        return _CAMERA_PREVIEW_STATE["offscreen"], False
    _free_camera_preview_offscreen()
    offscreen = gpu.types.GPUOffScreen(width, height)
    _CAMERA_PREVIEW_STATE["offscreen"] = offscreen
    _CAMERA_PREVIEW_STATE["offscreen_size"] = size
    _CAMERA_PREVIEW_STATE["texture_valid"] = False
    return offscreen, True


def _stop_camera_preview():
    if _CAMERA_PREVIEW_STATE["stopping"]:
        return
    _CAMERA_PREVIEW_STATE["stopping"] = True
    _CAMERA_PREVIEW_STATE["generation"] += 1
    try:
        owner = _camera_preview_owner()
    except (ReferenceError, RuntimeError):
        owner = None
    handler = _CAMERA_PREVIEW_STATE.get("handler")
    _CAMERA_PREVIEW_STATE["handler"] = None
    if handler is not None:
        try:
            bpy.types.SpaceView3D.draw_handler_remove(handler, "WINDOW")
        except Exception:
            pass
    if bpy.app.timers.is_registered(_camera_preview_refresh_tick):
        try:
            bpy.app.timers.unregister(_camera_preview_refresh_tick)
        except Exception:
            pass
    _free_camera_preview_offscreen()
    _CAMERA_PREVIEW_STATE.update({
        "window_pointer": 0,
        "area_pointer": 0,
        "region_pointer": 0,
        "close_rect": None,
        "close_hover": False,
        "drawing": False,
        "stopping": False,
        "dirty": True,
        "texture_valid": False,
        "last_render_at": 0.0,
        "render_count": 0,
        "last_error": None,
    })
    _tag_camera_preview_ui_redraw(owner)


def _camera_preview_refresh_tick():
    if not _camera_preview_is_active():
        return None
    owner = _camera_preview_owner()
    if not _has_editor_session() or owner is None:
        _stop_camera_preview()
        return None
    _CAMERA_PREVIEW_STATE["dirty"] = True
    owner[1].tag_redraw()
    return CAMERA_PREVIEW_REFRESH_SECONDS


def _draw_camera_preview():
    if not _camera_preview_is_active() or _CAMERA_PREVIEW_STATE["drawing"]:
        return
    context = bpy.context
    area = context.area
    region = context.region
    if (
        area is None
        or region is None
        or area.as_pointer() != _CAMERA_PREVIEW_STATE["area_pointer"]
        or region.as_pointer() != _CAMERA_PREVIEW_STATE["region_pointer"]
        or area.type != "VIEW_3D"
    ):
        return
    geometry = _camera_preview_geometry(region, context.scene)
    if geometry is None:
        _CAMERA_PREVIEW_STATE["close_rect"] = None
        return
    _CAMERA_PREVIEW_STATE["close_rect"] = geometry["close_rect"]
    x = geometry["x"]
    y = geometry["y"]
    width = geometry["width"]
    image_height = geometry["image_height"]
    total_height = geometry["total_height"]

    _CAMERA_PREVIEW_STATE["drawing"] = True
    gpu_state = None
    try:
        gpu_state = _capture_camera_preview_gpu_state()
        offscreen, created = _ensure_camera_preview_offscreen(width, image_height)
        should_render = (
            created
            or _CAMERA_PREVIEW_STATE["dirty"]
        )
        if should_render:
            try:
                camera = _active_protocol_camera(context.scene)
                if camera is None:
                    raise RuntimeError("protocol camera unavailable")
                depsgraph = context.evaluated_depsgraph_get()
                evaluated_camera = camera.evaluated_get(depsgraph)
                render = context.scene.render
                projection_matrix = evaluated_camera.calc_matrix_camera(
                    depsgraph,
                    x=max(render.resolution_x, 1),
                    y=max(render.resolution_y, 1),
                    scale_x=render.pixel_aspect_x,
                    scale_y=render.pixel_aspect_y,
                )
                view_matrix = evaluated_camera.matrix_world.inverted()
                offscreen.draw_view3d(
                    context.scene,
                    context.view_layer,
                    context.space_data,
                    region,
                    view_matrix,
                    projection_matrix,
                    do_color_management=True,
                    draw_background=True,
                )
                _CAMERA_PREVIEW_STATE["texture_valid"] = True
                _CAMERA_PREVIEW_STATE["last_error"] = None
            except Exception as error:
                _CAMERA_PREVIEW_STATE["texture_valid"] = False
                _CAMERA_PREVIEW_STATE["last_error"] = type(error).__name__
            finally:
                _CAMERA_PREVIEW_STATE["dirty"] = False
                _CAMERA_PREVIEW_STATE["last_render_at"] = time.monotonic()
                _CAMERA_PREVIEW_STATE["render_count"] += 1

        gpu.state.viewport_set(*gpu_state["viewport"])
        gpu.state.scissor_set(*gpu_state["scissor"])
        gpu.state.depth_test_set("NONE")
        gpu.state.depth_mask_set(False)
        gpu.state.blend_set("ALPHA")

        _draw_camera_preview_rect(
            x - 2,
            y - 2,
            width + 4,
            total_height + 4,
            (0.03, 0.035, 0.055, 0.96),
            (10.0, 10.0, 10.0, 10.0),
        )
        rendered = _CAMERA_PREVIEW_STATE["texture_valid"]
        if rendered:
            _draw_camera_preview_texture(
                offscreen.texture_color,
                x,
                y,
                width,
                image_height,
                (7.0, 7.0, 0.0, 0.0),
            )
        else:
            _draw_camera_preview_rect(
                x,
                y,
                width,
                image_height,
                (0.08, 0.09, 0.12, 1.0),
                (7.0, 7.0, 0.0, 0.0),
            )

        header_y = y + image_height
        _draw_camera_preview_rect(
            x,
            header_y,
            width,
            CAMERA_PREVIEW_HEADER_HEIGHT,
            (0.055, 0.06, 0.085, 0.96),
            (0.0, 0.0, 7.0, 7.0),
        )
        _draw_camera_preview_centered_text(
            "摄像机实时预览",
            x + 9,
            header_y,
            CAMERA_PREVIEW_HEADER_HEIGHT,
            13.0,
        )
        close_x, close_y, close_size, _ = geometry["close_rect"]
        close_color = (
            (0.72, 0.16, 0.18, 0.95)
            if _CAMERA_PREVIEW_STATE["close_hover"]
            else (0.18, 0.19, 0.24, 0.95)
        )
        _draw_camera_preview_rect(
            close_x,
            close_y,
            close_size,
            close_size,
            close_color,
            (4.0, 4.0, 4.0, 4.0),
        )
        _draw_camera_preview_cross(
            close_x,
            close_y,
            close_size,
            (0.96, 0.96, 0.98, 1.0),
        )
        if not rendered:
            _draw_camera_preview_text(
                "预览暂不可用",
                x + 12,
                y + max(image_height * 0.5, 18),
                13.0,
                (0.75, 0.78, 0.86, 1.0),
            )
    except Exception as error:
        _CAMERA_PREVIEW_STATE["last_error"] = type(error).__name__
    finally:
        try:
            if gpu_state is not None:
                _restore_camera_preview_gpu_state(gpu_state)
        finally:
            _CAMERA_PREVIEW_STATE["drawing"] = False


def _start_camera_preview():
    if bpy.app.background or not _has_editor_session():
        return False
    if _camera_preview_is_active():
        return True
    target = _camera_preview_target_context()
    if target is None:
        return False
    window, screen, area, region = target
    try:
        with bpy.context.temp_override(
            window=window,
            screen=screen,
            area=area,
            region=region,
        ):
            result = bpy.ops.ai_canvas.camera_preview_modal("INVOKE_DEFAULT")
    except (RuntimeError, TypeError):
        return False
    return result == {"RUNNING_MODAL"} or _camera_preview_is_active()


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
    _mark_console_object(obj, kind)
    return obj


def _ensure_console_world(scene):
    if (
        scene.world is not None
        and scene.world.get(DIRECTOR_OWNER_KEY) == DIRECTOR_OWNER_TOKEN
    ):
        return scene.world
    previous_name = scene.world.name if scene.world is not None else ""
    scene[DIRECTOR_PREVIOUS_WORLD_KEY] = previous_name
    world = bpy.data.worlds.new("AI Canvas Director Console World")
    world[DIRECTOR_OWNER_KEY] = DIRECTOR_OWNER_TOKEN
    scene.world = world
    return world


def _restore_console_world(scene):
    world = scene.world
    if world is None or world.get(DIRECTOR_OWNER_KEY) != DIRECTOR_OWNER_TOKEN:
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
    world.use_nodes = True
    background = next(
        (node for node in world.node_tree.nodes if node.type == "BACKGROUND"),
        None,
    )
    if background is not None:
        background.inputs["Color"].default_value = (*color, 1.0)
        background.inputs["Strength"].default_value = strength


def _configure_director_console_area():
    if bpy.app.background or not _has_editor_session():
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
    if not _has_editor_session():
        return 0.1
    console_ready = _configure_director_console_area()
    preview_ready = _camera_preview_is_active() or _start_camera_preview()
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
            ("MANNEQUIN", "人物占位", "创建一名低多边形人物占位"),
        ),
    )

    @classmethod
    def poll(cls, context):
        return _editor_operator_poll(context)

    def execute(self, context):
        collection = _director_collection(context.scene)
        origin = context.scene.cursor.location.copy()
        neutral = _ensure_material("AI Canvas Neutral", (0.55, 0.58, 0.65))
        character = _ensure_material("AI Canvas Character", (0.2, 0.55, 0.95))
        prop = _ensure_material("AI Canvas Prop", (0.85, 0.45, 0.2))
        created = []

        if self.asset == "CUBE":
            created.append(_new_box(
                "AI_blockout-cube",
                collection,
                origin + Vector((0.0, 0.0, 0.5)),
                (1.0, 1.0, 1.0),
                prop,
                "primitive",
            ))
        elif self.asset == "SPHERE":
            created.append(_new_sphere(
                "AI_blockout-sphere",
                collection,
                origin + Vector((0.0, 0.0, 0.5)),
                1.0,
                prop,
                "primitive",
            ))
        elif self.asset == "FLOOR":
            created.append(_new_box(
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
            _mark_console_object(root, "primitive")
            created.append(root)
            tabletop = _new_box(
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
                leg = _new_box(
                    f"AI_blockout-table-leg-{index}",
                    collection,
                    offset,
                    (0.1, 0.1, 0.76),
                    prop,
                    "primitive",
                )
                leg.parent = root
                created.append(leg)
        elif self.asset == "MANNEQUIN":
            root = bpy.data.objects.new("AI_blockout-person", None)
            collection.objects.link(root)
            root.location = origin
            root.empty_display_type = "PLAIN_AXES"
            root.empty_display_size = 0.35
            _mark_console_object(root, "primitive")
            created.append(root)
            parts = (
                ("head", "sphere", (0.0, 0.0, 1.65), (0.34, 0.34, 0.34)),
                ("torso", "box", (0.0, 0.0, 1.15), (0.55, 0.32, 0.72)),
                ("arm-l", "box", (-0.38, 0.0, 1.18), (0.16, 0.18, 0.68)),
                ("arm-r", "box", (0.38, 0.0, 1.18), (0.16, 0.18, 0.68)),
                ("leg-l", "box", (-0.16, 0.0, 0.46), (0.22, 0.26, 0.92)),
                ("leg-r", "box", (0.16, 0.0, 0.46), (0.22, 0.26, 0.92)),
            )
            for part_name, geometry, location, dimensions in parts:
                if geometry == "sphere":
                    part = _new_sphere(
                        f"AI_blockout-person-{part_name}",
                        collection,
                        location,
                        dimensions[0],
                        character,
                        "primitive",
                    )
                else:
                    part = _new_box(
                        f"AI_blockout-person-{part_name}",
                        collection,
                        location,
                        dimensions,
                        character,
                        "primitive",
                    )
                part.parent = root
                created.append(part)

        _select_objects(context, created, created[0] if created else None)
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
        _remove_console_objects(context.scene, {"scene"})
        collection = _director_collection(context.scene)
        neutral = _ensure_material("AI Canvas Set Neutral", (0.42, 0.45, 0.52))
        dark = _ensure_material("AI Canvas Road", (0.08, 0.09, 0.12), roughness=0.85)
        concrete = _ensure_material("AI Canvas Concrete", (0.35, 0.37, 0.4), roughness=0.8)
        green = _ensure_material("AI Canvas Green Screen", (0.04, 0.62, 0.12), roughness=0.9)
        wood = _ensure_material("AI Canvas Office Wood", (0.34, 0.16, 0.07), roughness=0.72)
        created = []

        def box(name, location, dimensions, material=neutral):
            obj = _new_box(name, collection, location, dimensions, material, "scene")
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

        _select_objects(context, created)
        self.report({"INFO"}, "场景预设已应用；Director Scene 原对象保持不变")
        return {"FINISHED"}


class AI_CANVAS_OT_clear_console_build(bpy.types.Operator):
    bl_idname = "ai_canvas.clear_console_build"
    bl_label = "清理快速搭建"
    bl_description = "只删除操作台创建的基础模型、场景和灯光，保留导入模型与 Director Scene"
    bl_options = {"REGISTER", "UNDO", "INTERNAL"}

    @classmethod
    def poll(cls, context):
        return _editor_operator_poll(context)

    def execute(self, context):
        removed = _remove_console_objects(context.scene, {"primitive", "scene", "light"})
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
        points = [
            obj.matrix_world @ Vector(corner)
            for obj in selected
            for corner in obj.bound_box
        ]
        if not points:
            self.report({"ERROR"}, "所选对象没有可用于落地的边界")
            return {"CANCELLED"}
        delta = -min(point.z for point in points)
        selected_set = set(selected)
        roots = [obj for obj in selected if obj.parent not in selected_set]
        for obj in roots:
            matrix = obj.matrix_world.copy()
            matrix.translation.z += delta
            obj.matrix_world = matrix
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
        return _editor_operator_poll(context) and _active_protocol_camera(context.scene) is not None

    def execute(self, context):
        camera = _active_protocol_camera(context.scene)
        target, radius = _target_bounds(context)
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
        return _editor_operator_poll(context) and _active_protocol_camera(context.scene) is not None

    def execute(self, context):
        camera = _active_protocol_camera(context.scene)
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
            and _active_protocol_camera(context.scene) is not None
            and active is not None
            and active.type not in {"CAMERA", "LIGHT"}
        )

    def execute(self, context):
        camera = _active_protocol_camera(context.scene)
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
        _remove_console_objects(context.scene, {"light"})
        collection = _director_collection(context.scene)
        target, _radius = _target_bounds(context)
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

        _select_objects(context, created)
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

        before = _snapshot_import_state()
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
            _remove_new_import_data(before)
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
            _remove_new_import_data(before)
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
        _select_objects(context, imported)
        self.report({"INFO"}, f"已导入 {len(imported)} 个对象到当前工程")
        return {"FINISHED"}


class AI_CANVAS_OT_camera_preview_modal(bpy.types.Operator):
    bl_idname = "ai_canvas.camera_preview_modal"
    bl_label = "摄像机实时预览"
    bl_description = "在主 3D 视图右下角显示可关闭的实时摄像机预览"
    bl_options = {"INTERNAL"}

    @classmethod
    def poll(cls, context):
        return (
            not bpy.app.background
            and _has_editor_session()
            and context.area is not None
            and context.area.type == "VIEW_3D"
            and context.region is not None
            and context.region.type == "WINDOW"
        )

    def invoke(self, context, _event):
        if _camera_preview_is_active():
            return {"CANCELLED"}
        generation = _CAMERA_PREVIEW_STATE["generation"] + 1
        self._preview_generation = generation
        handler = bpy.types.SpaceView3D.draw_handler_add(
            _draw_camera_preview,
            (),
            "WINDOW",
            "POST_PIXEL",
        )
        _CAMERA_PREVIEW_STATE.update({
            "handler": handler,
            "window_pointer": context.window.as_pointer(),
            "area_pointer": context.area.as_pointer(),
            "region_pointer": context.region.as_pointer(),
            "close_rect": None,
            "close_hover": False,
            "drawing": False,
            "stopping": False,
            "dirty": True,
            "texture_valid": False,
            "last_render_at": 0.0,
            "render_count": 0,
            "generation": generation,
            "last_error": None,
        })
        if not context.window_manager.modal_handler_add(self):
            _stop_camera_preview()
            return {"CANCELLED"}
        try:
            bpy.app.timers.register(
                _camera_preview_refresh_tick,
                first_interval=0.0,
            )
        except Exception:
            _stop_camera_preview()
            return {"CANCELLED"}
        _tag_camera_preview_ui_redraw(_camera_preview_owner())
        return {"RUNNING_MODAL"}

    def modal(self, context, event):
        if (
            getattr(self, "_preview_generation", None)
            != _CAMERA_PREVIEW_STATE["generation"]
        ):
            return {"FINISHED"}
        if not _camera_preview_is_active():
            return {"FINISHED"}
        owner = _camera_preview_owner()
        if not _has_editor_session() or owner is None:
            _stop_camera_preview()
            return {"FINISHED"}
        owner_window, owner_area, owner_region = owner
        same_window = (
            context.window is not None
            and context.window.as_pointer() == owner_window.as_pointer()
        )
        close_rect = _CAMERA_PREVIEW_STATE["close_rect"]
        over_close = False
        if same_window and close_rect is not None:
            mouse_region_x = event.mouse_x - owner_region.x
            mouse_region_y = event.mouse_y - owner_region.y
            x, y, width, height = close_rect
            over_close = (
                x <= mouse_region_x <= x + width
                and y <= mouse_region_y <= y + height
            )
        event_type = event.type
        if event_type == "MOUSEMOVE":
            if over_close != _CAMERA_PREVIEW_STATE["close_hover"]:
                _CAMERA_PREVIEW_STATE["close_hover"] = over_close
                owner_area.tag_redraw()
            return {"PASS_THROUGH"}
        if event_type == "LEFTMOUSE" and event.value == "PRESS" and over_close:
            _stop_camera_preview()
            return {"FINISHED"}
        return {"PASS_THROUGH"}

    def cancel(self, _context):
        if (
            getattr(self, "_preview_generation", None)
            == _CAMERA_PREVIEW_STATE["generation"]
        ):
            _stop_camera_preview()


class AI_CANVAS_OT_show_camera_preview(bpy.types.Operator):
    bl_idname = "ai_canvas.show_camera_preview"
    bl_label = "显示摄像机实时预览"
    bl_description = "在主 3D 视图右下角重新打开摄像机实时预览"
    bl_options = {"INTERNAL"}

    @classmethod
    def poll(cls, _context):
        return (
            not bpy.app.background
            and _has_editor_session()
            and not _camera_preview_is_active()
        )

    def execute(self, _context):
        if not _start_camera_preview():
            self.report({"ERROR"}, "当前工作区没有可用的 3D 视图")
            return {"CANCELLED"}
        return {"FINISHED"}


class AI_CANVAS_OT_hide_camera_preview(bpy.types.Operator):
    bl_idname = "ai_canvas.hide_camera_preview"
    bl_label = "关闭摄像机实时预览"
    bl_description = "关闭主 3D 视图右下角的摄像机实时预览"
    bl_options = {"INTERNAL"}

    @classmethod
    def poll(cls, _context):
        return _camera_preview_is_active()

    def execute(self, _context):
        _stop_camera_preview()
        return {"FINISHED"}


class AI_CANVAS_OT_show_console(bpy.types.Operator):
    bl_idname = "ai_canvas.show_console"
    bl_label = "打开导演操作台"
    bl_description = "把当前工作区右下属性编辑器切换到 AI Canvas 导演操作台"
    bl_options = {"INTERNAL"}

    @classmethod
    def poll(cls, _context):
        return not bpy.app.background and _has_editor_session()

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
        return _has_editor_session()

    def execute(self, _context):
        try:
            session, output_dir = _editor_session()
            blend_path = _save_editor_blend_atomically(output_dir)
            _write_editor_result(session, output_dir, blend_path)
        except Exception as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}

        _stop_camera_preview()
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

    @classmethod
    def poll(cls, _context):
        return _has_editor_session()

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
        return _has_editor_session()


class AI_CANVAS_PT_director_console(AI_CANVAS_PT_properties_base, bpy.types.Panel):
    bl_label = "AI Canvas 导演操作台"
    bl_idname = "SCENE_PT_ai_canvas_director_console"
    bl_order = 0

    def draw(self, _context):
        layout = self.layout
        session = bpy.app.driver_namespace.get(EDITOR_SESSION_KEY, {})
        layout.label(text="已连接当前 3D 导演台", icon="LINKED")
        revision = session.get("sceneRevision")
        if isinstance(revision, int):
            layout.label(text=f"场景版本：r{revision}")
        if _camera_preview_is_active():
            layout.operator(
                AI_CANVAS_OT_hide_camera_preview.bl_idname,
                icon="X",
            )
        else:
            layout.operator(
                AI_CANVAS_OT_show_camera_preview.bl_idname,
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
        layout.operator(
            AI_CANVAS_OT_add_blockout.bl_idname,
            text="添加人物占位",
            icon="ARMATURE_DATA",
        ).asset = "MANNEQUIN"
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
    AI_CANVAS_OT_add_blockout,
    AI_CANVAS_OT_apply_scene_preset,
    AI_CANVAS_OT_clear_console_build,
    AI_CANVAS_OT_ground_selected,
    AI_CANVAS_OT_apply_camera_preset,
    AI_CANVAS_OT_set_focal_length,
    AI_CANVAS_OT_focus_selected,
    AI_CANVAS_OT_apply_lighting_preset,
    AI_CANVAS_OT_import_model,
    AI_CANVAS_OT_camera_preview_modal,
    AI_CANVAS_OT_show_camera_preview,
    AI_CANVAS_OT_hide_camera_preview,
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
    _stop_camera_preview()


@persistent
def _load_factory_startup(_):
    bpy.app.driver_namespace.pop(EDITOR_SESSION_KEY, None)
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
    _stop_camera_preview()
    bpy.app.driver_namespace.pop(EDITOR_SESSION_KEY, None)
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
