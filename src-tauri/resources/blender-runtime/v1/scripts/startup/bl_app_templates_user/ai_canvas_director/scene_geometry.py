"""Scene geometry and first-party character assets for the Director template."""

from pathlib import Path
import bmesh
import bpy
from mathutils import Matrix, Vector


DIRECTOR_COLLECTION_NAME = "AI Canvas Director Console"
DIRECTOR_OWNER_KEY = "ai_canvas_console_owner"
DIRECTOR_OWNER_TOKEN = "ai_canvas_director_console_v1"
DIRECTOR_MANAGED_KEY = "ai_canvas_console_managed"
DIRECTOR_KIND_KEY = "ai_canvas_console_kind"
DIRECTOR_ASSET_KEY = "ai_canvas_console_asset"
DIRECTOR_INSTANCE_KEY = "ai_canvas_console_instance"
DIRECTOR_COLLECTION_SCENE_KEY = "ai_canvas_console_collection"
DIRECTOR_MATERIAL_ROLE_KEY = "ai_canvas_console_material_role"
DIRECTOR_BUILTIN_CHARACTERS = {
    "FEMALE": (
        "ai_canvas_female_white.blend",
        "女性白模",
        "female",
        {"Armature", "Eyebrows", "Eyes", "Superhero_Female"},
    ),
    "MALE": (
        "ai_canvas_male_white.blend",
        "男性白模",
        "male",
        {"Armature", "Eyebrows", "Eyes", "SuperHero_Male"},
    ),
}


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


def _mark_console_datablock(datablock, kind, asset_id=None, instance_id=None):
    datablock[DIRECTOR_OWNER_KEY] = DIRECTOR_OWNER_TOKEN
    datablock[DIRECTOR_MANAGED_KEY] = True
    datablock[DIRECTOR_KIND_KEY] = kind
    if asset_id is not None:
        datablock[DIRECTOR_ASSET_KEY] = asset_id
    if instance_id is not None:
        datablock[DIRECTOR_INSTANCE_KEY] = instance_id


def _mark_console_object(obj, kind, asset_id=None, instance_id=None):
    _mark_console_datablock(obj, kind, asset_id, instance_id)


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
    if hasattr(material, "use_nodes"):
        material.use_nodes = True
    shader = next(
        (node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"),
        None,
    )
    if shader is None:
        shader = material.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    output = next(
        (node for node in material.node_tree.nodes if node.type == "OUTPUT_MATERIAL"),
        None,
    )
    if output is None:
        output = material.node_tree.nodes.new("ShaderNodeOutputMaterial")
    if not output.inputs["Surface"].is_linked:
        material.node_tree.links.new(shader.outputs[0], output.inputs["Surface"])
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
    protected_instances = {
        obj.get(DIRECTOR_INSTANCE_KEY)
        for obj in bpy.data.objects
        if obj.get(DIRECTOR_OWNER_KEY) == DIRECTOR_OWNER_TOKEN
        and obj.get(DIRECTOR_MANAGED_KEY) is True
        and obj.get(DIRECTOR_KIND_KEY) in kinds
        and isinstance(obj.get(DIRECTOR_INSTANCE_KEY), str)
        and (
            len(obj.users_collection) != 1
            or obj.users_collection[0] != collection
        )
    }
    removed = 0
    for obj in list(collection.objects):
        if obj.get(DIRECTOR_OWNER_KEY) != DIRECTOR_OWNER_TOKEN:
            continue
        if obj.get(DIRECTOR_MANAGED_KEY) is not True:
            continue
        if obj.get(DIRECTOR_KIND_KEY) not in kinds:
            continue
        if obj.get(DIRECTOR_INSTANCE_KEY) in protected_instances:
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
    _remove_unused_console_datablocks(kinds, protected_instances)
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
    "shape_keys",
    "textures",
)


def _remove_unused_console_datablocks(kinds, protected_instances=None):
    protected_instances = protected_instances or set()
    while True:
        removed_any = False
        for group_name in IMPORT_DATABLOCK_GROUPS:
            group = getattr(bpy.data, group_name)
            for datablock in list(group):
                if datablock.get(DIRECTOR_OWNER_KEY) != DIRECTOR_OWNER_TOKEN:
                    continue
                if datablock.get(DIRECTOR_MANAGED_KEY) is not True:
                    continue
                if datablock.get(DIRECTOR_KIND_KEY) not in kinds:
                    continue
                if datablock.get(DIRECTOR_INSTANCE_KEY) in protected_instances:
                    continue
                if datablock.users != 0:
                    continue
                group.remove(datablock)
                removed_any = True
        if not removed_any:
            return


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
    while True:
        removed_any = False
        for group_name in IMPORT_DATABLOCK_GROUPS:
            group = getattr(bpy.data, group_name)
            for datablock in list(group):
                if datablock.as_pointer() in before[group_name] or datablock.users != 0:
                    continue
                group.remove(datablock)
                removed_any = True
        if not removed_any:
            return


def _new_import_datablocks(before):
    for group_name in IMPORT_DATABLOCK_GROUPS:
        for datablock in getattr(bpy.data, group_name):
            if datablock.as_pointer() not in before[group_name]:
                yield datablock


def _path_is_link_or_junction(path):
    return path.is_symlink() or (
        hasattr(path, "is_junction") and path.is_junction()
    )


def _builtin_character_path(asset):
    character = DIRECTOR_BUILTIN_CHARACTERS.get(asset)
    if character is None:
        raise RuntimeError("Unsupported AI Canvas built-in character")
    filename, label, slug, object_names = character
    try:
        template_directory = Path(__file__).resolve(strict=True).parent
        assets_directory = template_directory / "assets"
        unresolved_directory = assets_directory / "characters"
        if any(
            _path_is_link_or_junction(path)
            for path in (assets_directory, unresolved_directory)
        ):
            raise RuntimeError("AI Canvas built-in character directory is invalid")
        character_directory = unresolved_directory.resolve(strict=True)
        unresolved_path = character_directory / filename
        if _path_is_link_or_junction(unresolved_path):
            raise RuntimeError("AI Canvas built-in character path is invalid")
        character_path = unresolved_path.resolve(strict=True)
    except OSError as error:
        raise RuntimeError("AI Canvas built-in character is unavailable") from error
    try:
        character_path.relative_to(template_directory)
    except ValueError as error:
        raise RuntimeError("AI Canvas built-in character escaped the template") from error
    if character_path.parent != character_directory or not character_path.is_file():
        raise RuntimeError("AI Canvas built-in character path is invalid")
    return character_path, label, slug, object_names


def _evaluated_mesh_bound_points(context, objects):
    context.view_layer.update()
    depsgraph = context.evaluated_depsgraph_get()
    points = []
    for obj in objects:
        if obj.type != "MESH":
            continue
        evaluated = obj.evaluated_get(depsgraph)
        points.extend(
            evaluated.matrix_world @ vertex.co
            for vertex in evaluated.data.vertices
        )
    return points


def _hierarchy_members(roots):
    members = []
    pending = list(roots)
    seen = set()
    while pending:
        obj = pending.pop()
        pointer = obj.as_pointer()
        if pointer in seen:
            continue
        seen.add(pointer)
        members.append(obj)
        pending.extend(obj.children)
    return members


def _translate_roots_to_cursor(context, objects, cursor):
    points = _evaluated_mesh_bound_points(context, objects)
    if not points:
        raise RuntimeError("AI Canvas built-in character has no mesh bounds")
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
    delta = Vector((
        cursor.x - ((minimum.x + maximum.x) * 0.5),
        cursor.y - ((minimum.y + maximum.y) * 0.5),
        cursor.z - minimum.z,
    ))
    object_set = set(objects)
    roots = [obj for obj in objects if obj.parent not in object_set]
    if not roots:
        raise RuntimeError("AI Canvas built-in character hierarchy is invalid")
    for obj in roots:
        matrix = obj.matrix_world.copy()
        matrix.translation += delta
        obj.matrix_world = matrix
    context.view_layer.update()


def _validate_builtin_character(objects, before):
    if len(objects) != 4:
        raise RuntimeError("AI Canvas built-in character object count is invalid")
    armatures = [obj for obj in objects if obj.type == "ARMATURE"]
    meshes = [obj for obj in objects if obj.type == "MESH"]
    if len(armatures) != 1 or len(meshes) != 3:
        raise RuntimeError("AI Canvas built-in character structure is invalid")
    if any(obj.type not in {"ARMATURE", "MESH"} for obj in objects):
        raise RuntimeError("AI Canvas built-in character contains unsupported objects")
    if any(
        obj.library is not None
        or (obj.data is not None and obj.data.library is not None)
        for obj in objects
    ):
        raise RuntimeError("AI Canvas built-in character was not appended locally")
    object_set = set(objects)
    if any(obj.parent is not None and obj.parent not in object_set for obj in objects):
        raise RuntimeError("AI Canvas built-in character hierarchy is invalid")
    rig = armatures[0]
    if len(rig.data.bones) != 65 or rig.data.bones.get("root") is None:
        raise RuntimeError("AI Canvas built-in character rig is invalid")
    for mesh in meshes:
        if mesh.parent is not rig:
            raise RuntimeError("AI Canvas built-in character mesh parent is invalid")
        if not any(
            modifier.type == "ARMATURE" and modifier.object is rig
            for modifier in mesh.modifiers
        ):
            raise RuntimeError("AI Canvas built-in character skin binding is invalid")
    if any(
        image.as_pointer() not in before["images"]
        for image in bpy.data.images
    ):
        raise RuntimeError("AI Canvas built-in character contains external images")
    if any(
        datablock.library is not None
        for datablock in _new_import_datablocks(before)
    ):
        raise RuntimeError("AI Canvas built-in character contains linked data")
    if any(
        getattr(datablock, "use_fake_user", False)
        for datablock in _new_import_datablocks(before)
    ):
        raise RuntimeError("AI Canvas built-in character contains persistent data")
    return rig, meshes


def _rotate_around_world_z(context, obj, angle):
    context.view_layer.update()
    pivot = obj.matrix_world.translation.copy()
    obj.matrix_world = (
        Matrix.Translation(pivot)
        @ Matrix.Rotation(angle, 4, "Z")
        @ Matrix.Translation(-pivot)
        @ obj.matrix_world
    )
    context.view_layer.update()


def _is_managed_character_object(obj):
    return (
        obj.get(DIRECTOR_OWNER_KEY) == DIRECTOR_OWNER_TOKEN
        and obj.get(DIRECTOR_MANAGED_KEY) is True
        and obj.get(DIRECTOR_KIND_KEY) == "character"
        and isinstance(obj.get(DIRECTOR_INSTANCE_KEY), str)
    )


def _managed_character_objects():
    return [obj for obj in bpy.data.objects if _is_managed_character_object(obj)]


def _configure_character_selection(rig, meshes, allow_mesh_selection=False):
    rig.hide_select = False
    rig.show_in_front = True
    for mesh in list(meshes):
        if not allow_mesh_selection:
            mesh.select_set(False)
        mesh.hide_select = not allow_mesh_selection


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
