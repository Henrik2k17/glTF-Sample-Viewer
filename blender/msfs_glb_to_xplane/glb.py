"""Reads the parts of a GLB the converter needs that Blender's glTF importer doesn't keep:
material properties, image bytes, node rest transforms and animation extras."""

import json
import re
import struct

from mathutils import Quaternion, Vector


class Glb:
    def __init__(self, path):
        with open(path, "rb") as file:
            data = file.read()
        magic, version, _length = struct.unpack_from("<III", data, 0)
        if magic != 0x46546C67 or version != 2:
            raise ValueError("Not a glTF 2.0 binary (.glb) file")
        json_length, json_type = struct.unpack_from("<II", data, 12)
        if json_type != 0x4E4F534A:
            raise ValueError("The GLB has no JSON chunk")
        self.json = json.loads(data[20 : 20 + json_length])
        binary_offset = 20 + json_length
        self.binary = b""
        if binary_offset + 8 <= len(data):
            binary_length, binary_type = struct.unpack_from("<II", data, binary_offset)
            if binary_type == 0x004E4942:
                self.binary = data[binary_offset + 8 : binary_offset + 8 + binary_length]

    def array(self, key):
        return self.json.get(key, [])

    def image_bytes(self, image_index):
        image = self.array("images")[image_index]
        view = self.array("bufferViews")[image["bufferView"]]
        offset = view.get("byteOffset", 0)
        return self.binary[offset : offset + view["byteLength"]]

    def blender_animation_names(self):
        """The importer names an object's NLA tracks after the glTF animations; a name used
        before gets .001, .002, ... in order."""
        used = set()
        names = []
        for index, animation in enumerate(self.array("animations")):
            name = animation.get("name") or f"Animation_{index}"
            unique = name
            suffix = 1
            while unique in used:
                unique = f"{name}.{suffix:03d}"
                suffix += 1
            used.add(unique)
            names.append(unique)
        return names


# glTF is Y up, Blender Z up; the importer converts every node transform like this.
def location_to_blender(t):
    return Vector((t[0], -t[2], t[1]))


def rotation_to_blender(q):
    return Quaternion((q[3], q[0], -q[2], q[1]))


def scale_to_blender(s):
    return Vector((s[0], s[2], s[1]))


def node_rest(node):
    """(location, rotation, scale) of a glTF node in Blender axes."""
    return (
        location_to_blender(node.get("translation", (0, 0, 0))),
        rotation_to_blender(node.get("rotation", (0, 0, 0, 1))),
        scale_to_blender(node.get("scale", (1, 1, 1))),
    )


def base_name(name):
    return re.sub(r"\.\d{3}$", "", name)


def match_nodes(glb, objects):
    """{node index: object} for the imported objects, matched through the hierarchy by name
    (Blender may add .001 to names and cuts them at 63 bytes). Subtrees the importer
    restructures (skins: armatures) stay unmatched."""
    nodes = glb.array("nodes")
    children = {}
    for obj in objects:
        children.setdefault(obj.parent, []).append(obj)
    result = {}

    def match(node_indices, parent):
        pool = list(children.get(parent, []))
        for index in node_indices:
            name = nodes[index].get("name")
            if not name:
                continue
            short = name.encode("utf-8")[:63].decode("utf-8", "ignore")
            found = next((obj for obj in pool if base_name(obj.name) == short), None)
            if found is None:
                continue
            pool.remove(found)
            result[index] = found
            match(nodes[index].get("children", []), found)

    scenes = glb.array("scenes")
    if scenes:
        match(scenes[glb.json.get("scene", 0)].get("nodes", []), None)
    return result
