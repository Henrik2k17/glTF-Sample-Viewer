"""Turns the animations the viewer's export maps to X-Plane datarefs (animation extras
"xplane": {dataref, simvar, keys: [[dataref value, seconds], ...]}) into XPlane2Blender
dataref keyframes, and puts every other part in its exported pose.

X-Plane plays an OBJ animation from a dataref, never from time: each key pairs a dataref value
with a pose. The poses are sampled from the imported glTF animation at the key's time. The part
gets a parent empty holding its first pose and is keyed relative to it, so a hinge becomes one
ANIM_rotate around a fixed axis (XPlane2Blender writes axis-angle rotations as one table, Euler
rotations as three, which flip near 90 degrees).
"""

import math

import bpy
from mathutils import Matrix, Quaternion, Vector

from .glb import node_rest

Paths = ("location", "rotation_quaternion", "scale")


def strip_fcurves(strip):
    action = strip.action
    if action is None:
        return []
    layers = getattr(action, "layers", None)
    if layers:  # slotted actions (Blender 4.4 and later)
        slot = getattr(strip, "action_slot", None)
        for layer in layers:
            for layer_strip in layer.strips:
                bag = layer_strip.channelbag(slot) if slot is not None else None
                if bag is not None:
                    return [f for f in bag.fcurves if f.data_path in Paths]
        return []
    return [f for f in action.fcurves if f.data_path in Paths]


def pose_at(rest, fcurves, frame):
    location, rotation, scale = rest[0].copy(), rest[1].copy(), rest[2].copy()
    for fcurve in fcurves:
        value = fcurve.evaluate(frame)
        if fcurve.data_path == "location":
            location[fcurve.array_index] = value
        elif fcurve.data_path == "rotation_quaternion":
            rotation[fcurve.array_index] = value
        else:
            scale[fcurve.array_index] = value
    rotation.normalize()
    return location, rotation, scale


def rotation_angle(q):
    """Angle of the rotation in 0..pi (q and -q are the same rotation)."""
    return 2 * math.atan2(Vector(q[1:]).length, abs(q[0]))


def common_axis(rotations):
    """The axis all rotations turn around, None when they don't share one, (0, 0, 1) when
    none of them rotates."""
    largest = max(rotations, key=rotation_angle)
    if rotation_angle(largest) < 1e-5:
        return Vector((0, 0, 1))
    axis = Vector(largest[1:]).normalized()
    for q in rotations:
        v = Vector(q[1:])
        if v.length > 1e-6 and v.cross(axis).length / v.length > 1e-3:
            return None
    return axis


def signed_angle(q, axis):
    return 2 * math.atan2(Vector(q[1:]).dot(axis), q[0])


def key_part(obj, driver, poses):
    """Parents obj to a pivot at its first pose and keys it relative to the pivot."""
    location0, rotation0, scale0 = poses[0]
    pivot = bpy.data.objects.new(f"{obj.name}_pivot"[:63], None)
    for collection in obj.users_collection:
        collection.objects.link(pivot)
    pivot.parent = obj.parent
    pivot.matrix_parent_inverse = obj.matrix_parent_inverse.copy()
    pivot.rotation_mode = "QUATERNION"
    pivot.location, pivot.rotation_quaternion, pivot.scale = location0, rotation0, scale0
    obj.parent = pivot
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.scale = (1, 1, 1)

    inverse = rotation0.inverted()

    def divided(v):
        return Vector(v[k] / scale0[k] if scale0[k] != 0 else 0 for k in range(3))

    locations = [divided(inverse @ (location - location0)) for location, _, _ in poses]
    rotations = [inverse @ rotation for _, rotation, _ in poses]
    moves = any(location.length > 1e-6 for location in locations)
    turns = any(rotation_angle(rotation) > 1e-5 for rotation in rotations)
    scales = any((scale - scale0).length > 1e-4 for _, _, scale in poses)
    axis = common_axis(rotations)

    datarefs = obj.xplane.datarefs
    datarefs.add()
    index = len(datarefs) - 1
    dataref = datarefs[index]
    dataref.path = driver["dataref"]
    dataref.anim_type = "transform"

    obj.rotation_mode = "AXIS_ANGLE" if axis is not None else "XYZ"
    previous_angle = 0.0
    previous_euler = None
    for key, ((value, _time), location, rotation) in enumerate(zip(driver["keys"], locations, rotations)):
        frame = key + 1
        dataref.value = value
        obj.keyframe_insert(data_path=f"xplane.datarefs[{index}].value", frame=frame)
        obj.location = location if moves else (0, 0, 0)
        if moves:
            obj.keyframe_insert(data_path="location", frame=frame)
        if axis is not None:
            angle = signed_angle(rotation, axis)
            # continuous across keys (a wheel turning past 360 degrees keeps counting)
            angle += 2 * math.pi * round((previous_angle - angle) / (2 * math.pi))
            previous_angle = angle
            obj.rotation_axis_angle = (angle, *axis)
        else:
            euler = rotation.to_euler("XYZ", previous_euler) if previous_euler else rotation.to_euler("XYZ")
            previous_euler = euler
            obj.rotation_euler = euler
        if turns:
            obj.keyframe_insert(data_path="rotation_axis_angle" if axis is not None else "rotation_euler", frame=frame)
    for fcurve in obj.animation_data.action.fcurves:
        for point in fcurve.keyframe_points:
            point.interpolation = "LINEAR"
    return pivot, scales


def setup_animations(glb, node_objects, objects, report):
    """Keys the parts of the mapped animations, poses all others as exported and removes the
    imported animations. Returns the pivot empties it made."""
    scene = bpy.context.scene
    fps = scene.render.fps / scene.render.fps_base
    names = glb.blender_animation_names()
    drivers = {
        names[i]: animation["extras"]["xplane"]
        for i, animation in enumerate(glb.array("animations"))
        if (animation.get("extras") or {}).get("xplane")
    }
    nodes = glb.array("nodes")
    rests = {obj: node_rest(nodes[index]) for index, obj in node_objects.items()}

    samples = []
    several = []
    unmatched = 0
    for obj in objects:
        data = obj.animation_data
        if data is None or obj not in rests:
            unmatched += data is not None and any(track.name in drivers for track in data.nla_tracks)
            continue
        mapped = [track for track in data.nla_tracks if track.name in drivers and len(track.strips) > 0]
        if not mapped:
            continue
        if len({drivers[track.name]["dataref"] for track in mapped}) > 1:
            several.append(obj.name)
        driver = drivers[mapped[0].name]
        fcurves = strip_fcurves(mapped[0].strips[0])
        poses = [pose_at(rests[obj], fcurves, time * fps) for _value, time in driver["keys"]]
        samples.append((obj, driver, poses))

    for obj in objects:
        if obj.animation_data is not None:
            obj.animation_data_clear()
        rest = rests.get(obj)
        if rest is not None:
            obj.rotation_mode = "QUATERNION"
            obj.location, obj.rotation_quaternion, obj.scale = rest

    pivots = []
    scaled = []
    for obj, driver, poses in samples:
        pivot, scales = key_part(obj, driver, poses)
        pivots.append(pivot)
        if scales:
            scaled.append(obj.name)
    datarefs = {driver["dataref"] for _, driver, _ in samples}
    report({"INFO"}, f"{len(samples)} animated parts driven by {len(datarefs)} datarefs")
    if several:
        report({"WARNING"}, f"{len(several)} part(s) are moved by several datarefs, only the first is used: {', '.join(several[:5])}")
    if scaled:
        report({"WARNING"}, f"X-Plane can't animate scale, ignored for: {', '.join(scaled[:5])}")
    if unmatched:
        report({"WARNING"}, f"{unmatched} animated object(s) could not be matched to a glTF node and stay static")
    return pivots


def separate_mesh_parents(objects):
    """Moves the geometry of meshes that have children into a child object, so the hierarchy
    above any part consists of empties only: every texture set's OBJ needs the parents of its
    parts, but must not get their geometry. Returns the new empties."""
    empties = []
    for obj in [obj for obj in objects if obj.type == "MESH" and obj.children]:
        node = bpy.data.objects.new(f"{obj.name}_node"[:63], None)
        for collection in obj.users_collection:
            collection.objects.link(node)
        node.parent = obj.parent
        node.matrix_parent_inverse = obj.matrix_parent_inverse.copy()
        node.rotation_mode = obj.rotation_mode
        node.location = obj.location
        node.rotation_quaternion = obj.rotation_quaternion
        node.rotation_axis_angle = obj.rotation_axis_angle
        node.rotation_euler = obj.rotation_euler
        node.scale = obj.scale
        if obj.animation_data is not None and obj.animation_data.action is not None:
            node.animation_data_create().action = obj.animation_data.action
            for source in obj.xplane.datarefs:
                target = node.xplane.datarefs.add()
                target.path = source.path
                target.anim_type = source.anim_type
                target.loop = source.loop
            obj.animation_data_clear()
            obj.xplane.datarefs.clear()
        for child in list(obj.children):
            child.parent = node
        obj.parent = node
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.location = (0, 0, 0)
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = Quaternion()
        obj.scale = (1, 1, 1)
        empties.append(node)
    return empties
