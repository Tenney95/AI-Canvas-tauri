"""Camera preview overlay, GPU resources, and modal operators."""

import math
import time
import blf
import bpy
import gpu
from gpu_extras.batch import batch_for_shader


EDITOR_SESSION_KEY = "ai_canvas_director_editor_session_v1"
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
