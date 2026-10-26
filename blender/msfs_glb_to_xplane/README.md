# MSFS GLB to X-Plane (Blender add-on)

Turns a GLB from the viewer's **Export for Blender** (Models tab) into X-Plane OBJs, using the
XPlane2Blender exporter. Made for Blender 4.2.

## Setup

1. Install and enable **XPlane2Blender** (`io_xplane2blender`).
2. Zip the `msfs_glb_to_xplane` folder and install it under *Edit > Preferences > Add-ons > Install
   from Disk*, or copy the folder into Blender's `scripts/addons`.
3. *File > Import > MSFS GLB for X-Plane (.glb)*. Options: output folder (default: `<name>_xplane`
   next to the GLB), export the OBJs right away, flip the normal maps' green channel.

Export from an **MSFS package** (Models tab, package mode) so the GLB knows which sim variables
drive the animations; a single glTF file has no behaviors and gets no animations.

## What it makes

- **One OBJ per texture set.** An X-Plane OBJ has one albedo, normal and lit texture, so the
  meshes are split by the textures (and factors) of their glTF materials. Materials without a base
  color texture share `colors.obj`, a palette with one colour cell per material.
- **Textures** (PNG, next to the OBJs): `_albedo` (base color times its factor; alpha 1 for opaque
  materials), `_normal` (normal X/Y, metalness in blue, gloss = 1 - roughness in alpha, written
  with `NORMAL_METALNESS`) and `_lit` (emissive). UV transforms are baked into the UVs.
- **Animations driven by datarefs.** The export stores, for every animation whose MSFS code reads
  one known sim variable, the X-Plane dataref and the animation time per dataref value
  (`src/logic/xplane_datarefs.js` in the viewer). Each part gets a `_pivot` parent at its first
  pose and is keyed relative to it, one axis when it is a hinge. Covered: gear (deploy, wheel
  rotation, steering), flaps, ailerons / elevator / rudder (yoke ratios), trims, prop pitch
  (when the blades are nodes, not skin bones as on the DA62).
  The datarefs are ordinary XPlane2Blender settings on the objects and can be changed there.

Parts of other animations stay in the pose the viewer showed when exporting.

## Not converted (yet)

- Animations driven by `L:` variables (custom systems, e.g. the Fenix A320's flight controls),
  cockpit switches and levers (`B:` input events), skinned meshes and their bone animations
  (exported in bind pose).
- Detail maps, MSFS material effects, lights, clickable cockpit parts (manipulators).
- A material's second UV set (X-Plane OBJs have one).
- Assembling the aircraft: attach the OBJs in Plane Maker.
