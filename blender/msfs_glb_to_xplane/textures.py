"""Splits the imported meshes into X-Plane texture sets (one OBJ each) and writes the textures.

An X-Plane OBJ has one albedo (TEXTURE), one normal (TEXTURE_NORMAL) and one lit (TEXTURE_LIT)
texture, so every set of glTF textures becomes its own collection exported as an OBJ:
- albedo: base color texture times the base color factor (alpha 1 for opaque materials)
- normal: X and Y of the normal map; with NORMAL_METALNESS blue is metalness and alpha gloss
  (1 - roughness), from the glTF metallic-roughness texture and factors
- lit: emissive texture times the emissive factor and strength (clamped to 1)
glTF factors have no X-Plane equivalent and are baked into the textures, so materials sharing
textures with different factors get their own set. Materials without a base color texture
share a palette set: one colour cell per material, their faces' UVs moved onto it.
KHR_texture_transform is baked into the UVs (X-Plane has none).
"""

import math
import os
import shutil
import tempfile

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

from .glb import base_name

PaletteCell = 4  # pixels per palette colour


def texture_image(glb, texture_info):
    if texture_info is None:
        return None
    return glb.array("textures")[texture_info["index"]].get("source")


def uv_matrix(texture_info):
    """KHR_texture_transform as a 3x3 matrix in glTF UV space (V down)."""
    transform = (texture_info or {}).get("extensions", {}).get("KHR_texture_transform")
    if transform is None:
        return None
    offset = transform.get("offset", (0, 0))
    rotation = transform.get("rotation", 0)
    scale = transform.get("scale", (1, 1))
    c, s = math.cos(rotation), math.sin(rotation)
    return Matrix(
        (
            (c * scale[0], s * scale[1], offset[0]),
            (-s * scale[0], c * scale[1], offset[1]),
            (0, 0, 1),
        )
    )


def material_info(glb, index):
    material = glb.array("materials")[index]
    pbr = material.get("pbrMetallicRoughness", {})
    extensions = material.get("extensions", {})
    strength = extensions.get("KHR_materials_emissive_strength", {}).get("emissiveStrength", 1)
    infos = [
        pbr.get("baseColorTexture"),
        pbr.get("metallicRoughnessTexture"),
        material.get("normalTexture"),
        material.get("emissiveTexture"),
    ]
    return {
        "name": material.get("name", f"material{index}"),
        "base_image": texture_image(glb, infos[0]),
        "base_factor": tuple(pbr.get("baseColorFactor", (1, 1, 1, 1))),
        "mr_image": texture_image(glb, infos[1]),
        "metallic": pbr.get("metallicFactor", 1),
        "roughness": pbr.get("roughnessFactor", 1),
        "normal_image": texture_image(glb, infos[2]),
        "emissive_image": texture_image(glb, infos[3]),
        "emissive": tuple(min(1, value * strength) for value in material.get("emissiveFactor", (0, 0, 0))),
        "alpha_mode": material.get("alphaMode", "OPAQUE"),
        "alpha_cutoff": material.get("alphaCutoff", 0.5),
        "uv_matrix": uv_matrix(infos[0]),
        "other_uv_sets": any((info or {}).get("texCoord", 0) != 0 for info in infos if info),
    }


def set_key(info):
    """Materials with the same key share an X-Plane texture set."""
    if info["base_image"] is None:
        return ("palette",)

    def rounded(values):
        return tuple(round(value, 3) for value in values)

    return (
        info["base_image"],
        info["mr_image"],
        info["normal_image"],
        info["emissive_image"],
        rounded(info["base_factor"]),
        round(info["metallic"], 3),
        round(info["roughness"], 3),
        rounded(info["emissive"]),
        info["alpha_mode"] == "OPAQUE",
    )


def material_indices(glb, node_objects, objects):
    """{Blender material: glTF material index}. The importer gives a node's object one slot per
    distinct material, in the order of its mesh's primitives; objects it made itself (skins)
    fall back to the material name."""
    result = {}
    meshes = glb.array("meshes")
    nodes = glb.array("nodes")
    for node_index, obj in node_objects.items():
        mesh_index = nodes[node_index].get("mesh")
        if mesh_index is None or obj.type != "MESH":
            continue
        order = []
        for primitive in meshes[mesh_index]["primitives"]:
            material = primitive.get("material")
            if material is not None and material not in order:
                order.append(material)
        for slot, material in zip(obj.material_slots, order):
            if slot.material is not None:
                result.setdefault(slot.material, material)
    by_name = {}
    for index, material in enumerate(glb.array("materials")):
        by_name.setdefault(material.get("name"), index)
    for obj in objects:
        if obj.type != "MESH":
            continue
        for slot in obj.material_slots:
            if slot.material is not None and slot.material not in result:
                index = by_name.get(base_name(slot.material.name))
                if index is not None:
                    result[slot.material] = index
    return result


def bake_uvs(obj, polygons_by_material, infos, palette_uvs):
    """Applies texture transforms and palette cells to UV0 of each material's faces."""
    mesh = obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    uv = mesh.uv_layers[0]
    mesh.uv_layers.active = uv
    uv.active_render = True
    for material, polygons in polygons_by_material.items():
        cell = palette_uvs.get(material)
        matrix = infos[material]["uv_matrix"]
        if cell is None and matrix is None:
            continue
        for polygon in polygons:
            for loop in mesh.polygons[polygon].loop_indices:
                if cell is not None:
                    uv.data[loop].uv = cell
                else:
                    u, v = uv.data[loop].uv
                    # Blender's V runs up, glTF's down
                    t = matrix @ Vector((u, 1 - v, 1))
                    uv.data[loop].uv = (t[0], 1 - t[1])


def split_by_set(obj, faces_by_set, face_count):
    """{set key: object}: the object keeps the first set's faces, copies get the others; faces of
    no set (unknown materials) are removed."""
    keys = list(faces_by_set)
    parts = {keys[0]: obj}
    for key in keys[1:]:
        copy = obj.copy()
        copy.data = obj.data.copy()
        for collection in obj.users_collection:
            collection.objects.link(copy)
        parts[key] = copy
    for key, part in parts.items():
        keep = set(faces_by_set[key])
        if len(keep) == face_count:
            continue
        mesh = bmesh.new()
        mesh.from_mesh(part.data)
        mesh.faces.ensure_lookup_table()
        bmesh.ops.delete(mesh, geom=[face for face in mesh.faces if face.index not in keep], context="FACES")
        mesh.to_mesh(part.data)
        mesh.free()
    return parts


# ---- images


class ImageCache:
    """The GLB's images as Blender images, loaded once."""

    def __init__(self, glb):
        self.glb = glb
        self.images = {}
        self.folder = tempfile.mkdtemp(prefix="msfs_xplane_")

    def load(self, index):
        if index not in self.images:
            path = os.path.join(self.folder, f"{index}.png")
            with open(path, "wb") as file:
                file.write(self.glb.image_bytes(index))
            image = bpy.data.images.load(path)
            image.colorspace_settings.is_data = True
            image.pixels[0]  # read the file now; it is deleted with the folder
            self.images[index] = image
        return self.images[index]

    def size(self, index):
        return tuple(self.load(index).size)

    def pixels(self, index, size=None):
        """Raw RGBA floats (height, width, 4), bottom row first, optionally resized."""
        image = self.load(index)
        scaled = size is not None and tuple(image.size) != tuple(size)
        if scaled:
            image = image.copy()
            image.scale(size[0], size[1])
        width, height = image.size
        data = np.empty(width * height * 4, dtype=np.float32)
        image.pixels.foreach_get(data)
        if scaled:
            bpy.data.images.remove(image)
        return data.reshape(height, width, 4)

    def release(self):
        for image in self.images.values():
            bpy.data.images.remove(image)
        self.images = {}
        shutil.rmtree(self.folder, ignore_errors=True)


def to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def save_png(pixels, path):
    height, width = pixels.shape[:2]
    image = bpy.data.images.new(os.path.basename(path), width, height, alpha=True)
    image.colorspace_settings.is_data = True
    image.pixels.foreach_set(np.ascontiguousarray(pixels, dtype=np.float32).ravel())
    image.filepath_raw = path
    image.file_format = "PNG"
    image.save()
    bpy.data.images.remove(image)


def constant(size, rgba):
    return np.broadcast_to(np.array(rgba, dtype=np.float32), (size[1], size[0], 4)).copy()


def albedo_pixels(cache, info):
    pixels = cache.pixels(info["base_image"])
    factor = np.array(info["base_factor"], dtype=np.float32)
    if np.any(factor[:3] != 1):
        pixels[..., :3] = to_srgb(to_linear(pixels[..., :3]) * factor[:3])
    pixels[..., 3] = 1 if info["alpha_mode"] == "OPAQUE" else pixels[..., 3] * factor[3]
    return pixels


def normal_pixels(cache, info, flip_green):
    if info["normal_image"] is not None:
        pixels = cache.pixels(info["normal_image"])
    else:
        size = cache.size(info["mr_image"]) if info["mr_image"] is not None else (4, 4)
        pixels = constant(size, (0.5, 0.5, 1, 1))
    if flip_green:
        pixels[..., 1] = 1 - pixels[..., 1]
    if info["mr_image"] is not None:
        mr = cache.pixels(info["mr_image"], (pixels.shape[1], pixels.shape[0]))
        metallic, roughness = mr[..., 2] * info["metallic"], mr[..., 1] * info["roughness"]
    else:
        metallic, roughness = info["metallic"], info["roughness"]
    pixels[..., 2] = metallic
    pixels[..., 3] = 1 - np.clip(roughness, 0, 1)
    return pixels


def lit_pixels(cache, info):
    emissive = np.array(info["emissive"], dtype=np.float32)
    if not np.any(emissive > 0):
        return None
    if info["emissive_image"] is None:
        return constant((4, 4), (*to_srgb(emissive), 1))
    pixels = cache.pixels(info["emissive_image"])
    pixels[..., :3] = to_srgb(to_linear(pixels[..., :3]) * emissive)
    pixels[..., 3] = 1
    return pixels


def palette_pixels(infos, size, cells, flip_green):
    """Albedo, normal and lit palettes of the untextured materials (cells: {material: (x, y)})."""
    albedo = constant((size, size), (1, 1, 1, 1))
    normal = constant((size, size), (0.5, 0.5, 1, 1))
    lit = constant((size, size), (0, 0, 0, 1))
    any_lit = False
    for material, (x, y) in cells.items():
        info = infos[material]
        rows = slice(y * PaletteCell, (y + 1) * PaletteCell)
        cols = slice(x * PaletteCell, (x + 1) * PaletteCell)
        factor = np.array(info["base_factor"], dtype=np.float32)
        albedo[rows, cols] = (*to_srgb(factor[:3]), 1 if info["alpha_mode"] == "OPAQUE" else factor[3])
        normal[rows, cols] = (0.5, 0.5, info["metallic"], 1 - info["roughness"])
        emissive = np.array(info["emissive"], dtype=np.float32)
        if np.any(emissive > 0):
            any_lit = True
            lit[rows, cols] = (*to_srgb(emissive), 1)
    if flip_green:
        normal[..., 1] = 1 - normal[..., 1]
    return albedo, normal, lit if any_lit else None


def safe_name(name):
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name)[:48]


def set_material_options(material, info):
    """X-Plane blending: alpha blend, or alpha cutoff (opaque textures have alpha 1)."""
    settings = material.xplane
    if info["alpha_mode"] == "BLEND":
        settings.blend_v1000 = "on"
    else:
        settings.blend_v1000 = "off"
        settings.blendRatio = info["alpha_cutoff"] if info["alpha_mode"] == "MASK" else 0.5


def link_with_ancestors(collection, obj):
    while obj is not None:
        if collection not in obj.users_collection:
            collection.objects.link(obj)
        obj = obj.parent


def build_texture_sets(glb, node_objects, objects, out_dir, flip_green, report):
    """Puts the meshes into one exportable collection per texture set and writes its textures
    into out_dir. Returns the collections."""
    indices = material_indices(glb, node_objects, objects)
    infos = {material: material_info(glb, index) for material, index in indices.items()}

    palette_materials = sorted((m for m, info in infos.items() if info["base_image"] is None), key=lambda m: m.name)
    grid = max(1, math.ceil(math.sqrt(len(palette_materials))))
    palette_size = 2 ** math.ceil(math.log2(grid * PaletteCell))
    cells = {material: (i % grid, i // grid) for i, material in enumerate(palette_materials)}
    palette_uvs = {
        material: ((x + 0.5) * PaletteCell / palette_size, (y + 0.5) * PaletteCell / palette_size)
        for material, (x, y) in cells.items()
    }

    set_parts = {}  # key -> objects
    set_materials = {}  # key -> materials
    unknown = set()
    other_uv = set()
    for obj in [obj for obj in objects if obj.type == "MESH"]:
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        faces_by_set = {}
        polygons_by_material = {}
        for polygon in obj.data.polygons:
            slot = obj.material_slots[polygon.material_index] if obj.material_slots else None
            material = slot.material if slot is not None else None
            info = infos.get(material)
            if info is None:
                unknown.add(material.name if material else "(no material)")
                continue
            if info["other_uv_sets"]:
                other_uv.add(info["name"])
            key = set_key(info)
            faces_by_set.setdefault(key, []).append(polygon.index)
            polygons_by_material.setdefault(material, []).append(polygon.index)
            set_materials.setdefault(key, set()).add(material)
        if not faces_by_set:
            continue
        bake_uvs(obj, polygons_by_material, infos, palette_uvs)
        for key, part in split_by_set(obj, faces_by_set, len(obj.data.polygons)).items():
            set_parts.setdefault(key, []).append(part)
    if unknown:
        report({"WARNING"}, f"No glTF material for {len(unknown)} material(s), their faces are left out: {', '.join(sorted(unknown)[:5])}")
    if other_uv:
        report({"WARNING"}, f"{len(other_uv)} material(s) use a second UV set, which X-Plane OBJs don't have: {', '.join(sorted(other_uv)[:5])}")

    for material, info in infos.items():
        set_material_options(material, info)

    os.makedirs(out_dir, exist_ok=True)
    cache = ImageCache(glb)
    images = glb.array("images")
    collections = []
    used_names = set()
    try:
        for key, parts in set_parts.items():
            materials = sorted(set_materials[key], key=lambda m: m.name)
            info = infos[materials[0]]
            if key == ("palette",):
                name = "colors"
                albedo, normal, lit = palette_pixels(infos, palette_size, cells, flip_green)
            else:
                name = safe_name(images[info["base_image"]].get("name") or f"texture{info['base_image']}")
                albedo = albedo_pixels(cache, info)
                normal = normal_pixels(cache, info, flip_green)
                lit = lit_pixels(cache, info)
            unique = name
            suffix = 2
            while unique in used_names:
                unique = f"{name}_{suffix}"
                suffix += 1
            used_names.add(unique)

            collection = bpy.data.collections.new(f"XP_{unique}")
            bpy.context.scene.collection.children.link(collection)
            for part in parts:
                link_with_ancestors(collection, part)
            layer = collection.xplane.layer
            collection.xplane.is_exportable_collection = True
            layer.name = unique
            layer.export_type = "aircraft"
            save_png(albedo, os.path.join(out_dir, f"{unique}_albedo.png"))
            layer.texture = f"{unique}_albedo.png"
            save_png(normal, os.path.join(out_dir, f"{unique}_normal.png"))
            layer.texture_normal = f"{unique}_normal.png"
            layer.normal_metalness = True
            if lit is not None:
                save_png(lit, os.path.join(out_dir, f"{unique}_lit.png"))
                layer.texture_lit = f"{unique}_lit.png"
            collections.append(collection)
    finally:
        cache.release()
    return collections
