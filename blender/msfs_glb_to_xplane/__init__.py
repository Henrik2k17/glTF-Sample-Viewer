"""Converts a GLB written by the glTF-Sample-Viewer's MSFS export into X-Plane OBJs with
XPlane2Blender: one OBJ per texture set, X-Plane textures, and the animations the export mapped
to datarefs (gear, flight controls, ...). See textures.py and animation.py."""

import math
import os

import bpy
from bpy.props import BoolProperty, StringProperty
from bpy_extras.io_utils import ImportHelper

from .animation import separate_mesh_parents, setup_animations
from .glb import Glb, match_nodes
from .textures import build_texture_sets

bl_info = {
    "name": "MSFS GLB to X-Plane",
    "description": "Converts a GLB exported by the MSFS glTF viewer into X-Plane OBJs (needs XPlane2Blender)",
    "author": "Henrik Lieb",
    "version": (0, 1, 0),
    "blender": (4, 2, 0),
    "location": "File > Import > MSFS GLB for X-Plane (.glb)",
    "category": "Import-Export",
}


def face_forward(objects):
    """MSFS models arrive with the nose along Blender's -Y; XPlane2Blender writes +Y as the
    X-Plane nose direction (-Z). A root empty turned 180 degrees around Z carries the model."""
    root = bpy.data.objects.new("MSFS_root", None)
    bpy.context.scene.collection.objects.link(root)
    root.rotation_euler = (0, 0, math.pi)
    for obj in objects:
        if obj.parent is None:
            obj.parent = root
    return root


class IMPORT_OT_msfs_glb_xplane(bpy.types.Operator, ImportHelper):
    """Import an MSFS GLB export and set it up as X-Plane OBJs (one per texture set)"""

    bl_idname = "import_scene.msfs_glb_xplane"
    bl_label = "Import MSFS GLB for X-Plane"
    bl_options = {"REGISTER", "UNDO"}

    filename_ext = ".glb"
    filter_glob: StringProperty(default="*.glb", options={"HIDDEN"})
    output_folder: StringProperty(
        name="Output Folder",
        description="Where the textures and OBJs go (empty: a folder next to the GLB)",
        subtype="DIR_PATH",
        default="",
    )
    export_objs: BoolProperty(
        name="Export OBJs",
        description="Export the OBJs right away (otherwise use File > Export > X-Plane later)",
        default=True,
    )
    flip_green: BoolProperty(
        name="Flip Normal Map Green",
        description="Invert the normal maps' green channel (the export writes OpenGL convention, green up)",
        default=False,
    )

    def execute(self, context):
        if not hasattr(bpy.types.Collection, "xplane"):
            self.report({"ERROR"}, "Enable the XPlane2Blender add-on first")
            return {"CANCELLED"}
        try:
            glb = Glb(self.filepath)
        except (OSError, ValueError) as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        stem = os.path.splitext(os.path.basename(self.filepath))[0]
        out_dir = os.path.abspath(
            bpy.path.abspath(self.output_folder) or os.path.join(os.path.dirname(self.filepath), f"{stem}_xplane")
        )

        before = set(bpy.data.objects)
        result = bpy.ops.import_scene.gltf(filepath=self.filepath)
        if "FINISHED" not in result:
            self.report({"ERROR"}, "The glTF import failed")
            return {"CANCELLED"}
        objects = [obj for obj in bpy.data.objects if obj not in before]
        node_objects = match_nodes(glb, objects)
        objects.append(face_forward(objects))

        objects += setup_animations(glb, node_objects, objects, self.report)
        objects += separate_mesh_parents(objects)
        collections = build_texture_sets(glb, node_objects, objects, out_dir, self.flip_green, self.report)
        self.report({"INFO"}, f"{len(collections)} texture sets, textures in {out_dir}")

        if self.export_objs:
            exported = bpy.ops.export.xplane_obj(filepath=os.path.join(out_dir, stem))
            if "FINISHED" not in exported:
                self.report({"ERROR"}, "The X-Plane export failed, see XPlane2Blender's export log")
                return {"CANCELLED"}
            self.report({"INFO"}, f"Exported {len(collections)} OBJs to {out_dir}")
        return {"FINISHED"}


def menu_import(self, context):
    self.layout.operator(IMPORT_OT_msfs_glb_xplane.bl_idname, text="MSFS GLB for X-Plane (.glb)")


def register():
    bpy.utils.register_class(IMPORT_OT_msfs_glb_xplane)
    bpy.types.TOPBAR_MT_file_import.append(menu_import)


def unregister():
    bpy.types.TOPBAR_MT_file_import.remove(menu_import)
    bpy.utils.unregister_class(IMPORT_OT_msfs_glb_xplane)
