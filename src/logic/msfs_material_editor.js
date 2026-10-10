// Materials tab in the layout of the MSFS 2024 material editor in 3ds Max (MSFS2024_Material.ms:
// rollouts "Parameters" and "Textures", group boxes, spinners, per material type which controls
// are enabled, texture slot names and order). Every field edits a parameter of the Max material
// model (msfs_material_model.js); main.js writes the model back to glTF and replaces the
// material in the renderer.

import { MaterialTypes } from "./msfs_material_model.js";

const is = (type, ...types) => types.includes(type);
const NoSurface = ["Invisible", "Environment Occluder"];
const DecalTypes = ["Decal", "GeoDecal Frosted", "GeoDecal BlendMasked"];

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Linear color (glTF) -> "#rrggbb" sRGB for a color input. */
function colorToHex(color) {
    return (
        "#" +
        [0, 1, 2]
            .map((i) => Math.round(Math.min(1, Math.max(0, linearToSrgb(color[i] ?? 0))) * 255).toString(16).padStart(2, "0"))
            .join("")
    );
}

/** "#rrggbb" sRGB -> linear [r, g, b]. */
function hexToLinear(hex) {
    const value = parseInt(hex.slice(1), 16);
    return [16, 8, 0].map((shift) => srgbToLinear(((value >> shift) & 0xff) / 255));
}

// Field constructors; param: the model parameter the field edits
const num = (label, param, extra = {}) => ({ kind: "number", label, param, step: 0.01, ...extra });
const check = (label, param, extra = {}) => ({ kind: "check", label, param, ...extra });
const color = (label, param, extra = {}) => ({ kind: "color", label, param, ...extra });

/**
 * The editor for one material.
 * @param {object} model readMaterial model (possibly edited)
 * @param {object} options
 *   msfs: an MSFS material (the type can be chosen)
 *   changed: Set of edited keys (params, "type", "texture:<slot>")
 *   describeTexture(textureIndex): { file, thumbnail, status, viewerId } of a loaded texture
 *   textureChoices: [{ index, label }] textures a slot can be set to
 * @returns {object} { type, types, msfs, sections: [{columns: [[group]]}], textures: [row] }
 */
function buildMaterialEditor(model, options) {
    const { msfs, changed = new Set(), describeTexture, textureChoices = [] } = options;
    const t = model.type;
    const p = model.params;

    // fields get their current value; disabled ones are shown as Max does (greyed)
    const bind = (field) => {
        if (field.kind === "radio") {
            return { ...field, value: p[field.param], edited: changed.has(field.param) };
        }
        let value = p[field.param];
        if (field.kind === "color") value = colorToHex(value);
        if (field.scale) value = value * field.scale;
        return { ...field, value, edited: changed.has(field.param), enabled: field.enabled !== false };
    };
    const group = (title, fields, extra = {}) => ({ title, fields: fields.filter(Boolean).map(bind), ...extra });

    const noSurface = is(t, ...NoSurface);
    const emissiveEnabled = !noSurface;
    const baseColor = group("Base Color:", [
        color("Albedo:", "baseColor"),
        num("Alpha:", "baseColorAlpha", { min: 0, max: 1, enabled: t !== "Invisible" })
    ]);
    // the alpha is a component of baseColor; main.js maps baseColorAlpha to it
    baseColor.fields[1].value = p.baseColor[3];

    const emissive = group("Emissive:", [
        color("Emissive Color:", "emissive", { enabled: emissiveEnabled }),
        num("x", "emissiveMul", { step: 1, min: 0, max: 1000000, unit: msfs ? "cd/m²" : undefined, inline: true, enabled: emissiveEnabled }),
        msfs && num("Day Multiplier:", "emissiveDayMul", { step: 0.1, min: 0, max: 999, enabled: emissiveEnabled }),
        msfs && num("Night Multiplier:", "emissiveNightMul", { step: 0.1, min: 0, max: 999, enabled: emissiveEnabled })
    ]);

    // alpha mode: which types let it be chosen (Standard, Propeller..Tree, Fresnel, ClearCoat)
    const alphaModeEnabled = !msfs || is(t, "Standard", "Propeller", "Tire", "Tree", "Fresnel Fade", "ClearCoat");
    const alpha = group("Alpha Mode:", [
        { kind: "radio", param: "alphaMode", options: msfs ? ["OPAQUE", "MASK", "BLEND", "DITHER"] : ["OPAQUE", "MASK", "BLEND"], enabled: alphaModeEnabled }
    ]);
    const render = group("Render Param:", [
        num("Draw Order:", "drawOrder", { step: 1, integer: true, min: -999, max: 999, enabled: is(t, ...DecalTypes, "Glass", "WindShield", "Propeller", "PortHole") }),
        check("Don't cast shadows", "noCastShadow", { enabled: !noSurface && t !== "Ghost" }),
        check("Double Sided", "doubleSided", { enabled: !noSurface }),
        msfs && check("Day Night Cycle", "dayNightCycle", { enabled: is(t, "Standard", "ClearCoat") }),
        msfs && check("Disable Motion Blur", "disableMotionBlur", { enabled: !noSurface }),
        msfs && check("Flip BackFace Normal", "flipBackFace", { enabled: !is(t, "Environment Occluder", "Sail") && p.doubleSided })
    ]);
    const gameplay = msfs
        ? group("Gameplay Param:", [
              check("Collision Material", "collisionMaterial", { enabled: t !== "Environment Occluder" }),
              check("Road Collision Material", "roadMaterial", { enabled: t !== "Environment Occluder" }),
              check("Ground Collision Material", "groundMaterial", { enabled: t !== "Environment Occluder" })
          ])
        : undefined;

    const detailEnabled = !is(t, "Parallax Window", "Invisible", "Fresnel Fade", "Environment Occluder", "SSS");
    const hasBlendMask = model.textures.BlendMask !== undefined && !is(t, "GeoDecal BlendMasked", "Tire");
    const wearEnabled = is(t, "Standard", "ClearCoat");
    const spinners = group(
        "",
        [
            num("Metallic:", "metallic", { min: 0, max: 1, enabled: !is(t, ...NoSurface, "Vegetation") }),
            num("Roughness:", "roughness", { min: 0, max: 1, enabled: !noSurface }),
            num(t === "WindShield" ? "Reflection Mask:" : "AO Strength:", "occlusionStrength", { min: 0, max: 2, enabled: !noSurface }),
            num("Normal Strength:", "normalScale", { min: 0, max: 1, enabled: !noSurface }),
            num("Alpha Cutoff:", "alphaCutoff", { min: 0, max: 1, enabled: alphaModeEnabled && p.alphaMode === "MASK" }),
            msfs && num("Detail UV Tiling:", "detailUVScale", { min: 0.01, max: 100, enabled: detailEnabled }),
            msfs && num("Detail Normal Strength:", "detailNormalScale", { min: 0, max: 1, enabled: detailEnabled }),
            msfs && num("Detail Threshold:", "blendThreshold", { step: 0.001, min: 0.001, max: 1, enabled: hasBlendMask && detailEnabled }),
            msfs && num("Wear Overlay UV Scale:", "dirtUvScale", { min: 0.001, max: 10, enabled: wearEnabled }),
            msfs && num("Wear Blend Sharpness:", "dirtBlendSharpness", { min: 0, max: 1, enabled: wearEnabled }),
            msfs && num("Wear Amount:", "dirtBlendAmount", { min: 0, max: 1, enabled: wearEnabled })
        ],
        { plain: true }
    );
    const rainEnabled = is(t, "ClearCoat", "WindShield");
    const rain = msfs
        ? group("Rain Param:", [
              check("Receive Rain", "canReceiveRain", { enabled: rainEnabled }),
              num("Rain Drop Tiling:", "rainDropScale", { step: 1, min: 0, max: 100, enabled: rainEnabled && p.canReceiveRain }),
              check("Rain on BackFace", "rainDropSide", { enabled: t === "WindShield" && p.canReceiveRain })
          ])
        : undefined;

    const uvEnabled = msfs && t !== "Environment Occluder";
    const uvGroup = msfs
        ? group(
              "UV:",
              [
                  num("Offset U:", "UVOffsetU", { min: -10, max: 10, enabled: uvEnabled }),
                  num("Tiling U:", "UVTilingU", { min: -10, max: 10, enabled: uvEnabled }),
                  check("Clamp U", "clampUVX", { enabled: uvEnabled }),
                  num("Offset V:", "UVOffsetV", { min: -10, max: 10, enabled: uvEnabled }),
                  num("Tiling V:", "UVTilingV", { min: -10, max: 10, enabled: uvEnabled }),
                  check("Clamp V", "clampUVY", { enabled: uvEnabled }),
                  num("Rotation:", "UVRotation", { min: -360, max: 360, enabled: uvEnabled })
              ],
              { grid: 3 }
          )
        : undefined;

    const typeGroups = [];
    if (is(t, ...DecalTypes)) {
        const frosted = t === "GeoDecal Frosted";
        typeGroups.push(
            group("Decal per component blend factors:", [
                num("Color:", "decalColorFactor", { min: 0, max: 1 }),
                num("Roughness:", "decalRoughnessFactor", { min: 0, max: 1 }),
                num("Metal:", "decalMetalFactor", { min: 0, max: 1 }),
                num(frosted ? "Blast Sys:" : "Occlusion:", "decalOcclusionFactor", { min: 0, max: 1 }),
                num("Normal:", "decalNormalFactor", { min: 0, max: 1 }),
                num(frosted ? "Melt Sys:" : "Emissive:", "decalEmissiveFactor", { min: 0, max: 1 }),
                num("Normal Mode Tangent/Override:", "decalNormalOverrideFactor", { min: 0, max: 1 }),
                t === "GeoDecal BlendMasked" && num("Blend Sharpness:", "decalBlendSharpnessFactor", { min: 0, max: 1 }),
                check("Render on ClearCoat", "decalRenderOnClearcoat"),
                t === "Decal" && check("Scenery channel", "decalChan0"),
                t === "Decal" && check("Terrain channel", "decalChan1"),
                t === "Decal" && check("SimObject channel", "decalChan2")
            ])
        );
    }
    if (t === "Hair") typeGroups.push(group("SSS parameters:", [color("SSS Color", "SSSColor")]));
    if (t === "Tire") {
        typeGroups.push(
            group("Tire parameters:", [
                num("Mud Tiling:", "tireMudNormalTiling", { step: 0.1, min: 0, max: 100 }),
                num("Mud Anim State:", "tireMudAnimState", { min: 0, max: 1 }),
                num("Dust Anim State:", "tireDustAnimState", { min: 0, max: 1 })
            ])
        );
    }
    if (t === "ClearCoat") {
        typeGroups.push(
            group("ClearCoat Param:", [
                num("Clearcoat Roughness Factor", "clearcoatRoughnessFactor", { min: 0, max: 1 }),
                num("Clearcoat Normal Factor", "clearcoatNormalFactor", { min: 0, max: 1 }),
                num("Clearcoat Color/Roughness Tiling", "clearcoatColorRoughnessTiling", { min: -1000, max: 1000 }),
                num("Clearcoat Normal Tiling", "clearcoatNormalTiling", { min: -1000, max: 1000 }),
                check("Use uniform base roughness", "clearcoatInverseRoughness"),
                num("Base Roughness", "clearcoatBaseRoughness", { min: 0, max: 1, enabled: p.clearcoatInverseRoughness }),
                check("Base normal affect coat", "clearcoatBaseAffectCoat")
            ])
        );
    }
    if (t === "Glass") {
        // stored in meters, shown in millimeters like Max
        typeGroups.push(group("Glass Width:", [num("Glass Width (mm):", "glassWidth", { step: 1, min: 0, max: 1000, scale: 1000 })]));
    }
    if (t === "Parallax Window") {
        typeGroups.push(
            group("Parallax parameters:", [
                num("Room Scale X:", "roomSizeXScale", { min: 0, max: 1 }),
                num("Room Scale Y:", "roomSizeYScale", { min: 0.01, max: 10 }),
                num("Room Scale Z:", "parallaxScale", { min: 0.01, max: 10 }),
                num("Room Count:", "roomNumberXY", { step: 1, min: 1, max: 16, integer: true }),
                check("Corridor", "corridor")
            ])
        );
    }
    if (t === "Fresnel Fade") {
        typeGroups.push(
            group("Fresnel parameters:", [
                num("Fresnel Factor:", "fresnelFactor", { min: 0.001, max: 100 }),
                num("Fresnel Opacity Bias:", "fresnelOpacityOffset", { min: -1, max: 1 })
            ])
        );
    }
    if (t === "Ghost") {
        typeGroups.push(
            group("Ghost parameters:", [
                num("Bias Factor:", "ghostBiasFactor", { min: 0, max: 1 }),
                num("Ghost Power:", "ghostPowerFactor", { min: 0.001, max: 64 }),
                num("Ghost Scale:", "ghostScaleFactor", { min: 0, max: 1 })
            ])
        );
    }
    if (t === "Sail") typeGroups.push(group("Sail Parameters:", [num("Light Absorption", "sailLightAbsorption", { min: 0, max: 1 })]));
    if (t === "WindShield") {
        typeGroups.push(
            group("Windshield parameters:", [
                num("Detail 1 (R) Rough:", "detail1Rough", { min: 0, max: 1 }),
                num("Detail 1 (R) Opacity:", "detail1Opacity", { min: 0, max: 1 }),
                num("Detail 2 (B) Rough:", "detail2Rough", { min: 0, max: 1 }),
                num("Detail 2 (B) Opacity:", "detail2Opacity", { min: 0, max: 1 }),
                num("Micro-Scratches Tiling:", "microScratchesTiling", { step: 1, min: 0, max: 1000 }),
                num("Micro-Scratches Strength:", "microScratchesStrength", { min: 0, max: 100 }),
                num("Detail Normal Refraction Strength:", "detailNormalRefractScale", { min: 0, max: 1 })
            ]),
            group("Windshield Wipers parameters:", [
                check("Wiper Lines", "wiperLines", { enabled: p.canReceiveRain }),
                num("Tiling:", "wiperLinesTiling", { step: 1, min: 0, max: 100, enabled: p.canReceiveRain && p.wiperLines }),
                num("Strength:", "wiperLinesStrength", { min: 0, max: 10, enabled: p.canReceiveRain && p.wiperLines }),
                num("Wiper1 State:", "wiperAnimState1", { min: 0, max: 1, enabled: p.canReceiveRain })
            ]),
            group("Windshield Reflection parameters:", [
                check("Mask Cubemap Reflections", "cubemapReflectionMasking"),
                num("Screen Space Reflection intensity:", "ssrAttenuation", { step: 0.001, min: 0, max: 1 })
            ]),
            group("Iridescent Param:", [
                check("Use Iridescence", "iridescent"),
                num("Min Thickness", "iridescentMinThickness", { step: 1, min: 0, max: 2000, enabled: p.iridescent }),
                num("Max Thickness", "iridescentMaxThickness", { step: 1, min: 0, max: 2000, enabled: p.iridescent }),
                num("Brightness", "iridescentBrightness", { min: 0, max: 10, enabled: p.iridescent })
            ])
        );
    }
    if (t === "Standard" && msfs) {
        typeGroups.push(
            group("Pearl Param:", [
                check("Use Pearl Effect", "pearlescent"),
                num("Color Shift", "pearlShift", { step: 0.1, min: -999, max: 999, enabled: p.pearlescent }),
                num("Color Range", "pearlRange", { step: 0.1, min: -999, max: 999, enabled: p.pearlescent }),
                num("Color Brightness", "pearlBrightness", { min: -1, max: 1, enabled: p.pearlescent })
            ])
        );
    }

    const sections = [
        { columns: [[baseColor]] },
        { columns: [[emissive]] },
        { columns: [[alpha, render, gameplay].filter(Boolean), [spinners, rain].filter(Boolean)] },
        uvGroup && { columns: [[uvGroup]] },
        ...typeGroups.map((typeGroup) => ({ columns: [[typeGroup]] }))
    ].filter(Boolean);

    const textures = getMaxTextureSlots(model).map(({ slot, label }) => {
        const info = model.textures[slot];
        const described = info !== undefined ? describeTexture(info.index) : undefined;
        return {
            slot,
            label,
            textureIndex: info?.index,
            edited: changed.has(`texture:${slot}`),
            choices: textureChoices,
            ...described,
            tooltip: described ? [described.file, ...(described.rows ?? []).map(([name, v]) => `${name}: ${v}`)].join("\n") : "Empty slot"
        };
    });
    return { type: t, types: msfs ? MaterialTypes : ["glTF PBR"], msfs, sections, textures };
}

/** The Max texture slots shown for the material's type (texturesUI updateTexSlots). */
function getMaxTextureSlots(model) {
    const type = model.type;
    const hasBlendMask = model.textures.BlendMask !== undefined;
    if (is(type, ...NoSurface)) {
        return [];
    }
    const slots = [
        ["BaseColor", "Base Color"],
        ["OcclusionRoughnessMetallic", "Occlusion (R), Roughness (G), Metallic (B)"],
        ["Normal", "Normal"],
        ["Emissive", "Emissive"],
        ["DetailColor", hasBlendMask ? "Secondary Color (RGB), Alpha (A)" : "Detail Color (RGB), Alpha (A)"],
        ["DetailOcclusionRoughnessMetallic", hasBlendMask ? "Secondary Occlusion (R), Roughness (G), Metallic (B)" : "Detail Occlusion (R), Roughness (G), Metallic (B)"],
        ["DetailNormal", hasBlendMask ? "Secondary Normal" : "Detail Normal"],
        ["BlendMask", "Blend Mask"],
        ["Occlusion", "Occlusion (UV2)"]
    ].map(([slot, label]) => ({ slot, label }));
    const find = (slot) => slots.find((entry) => entry.slot === slot);
    const relabel = (slot, label) => {
        const entry = find(slot);
        if (entry) entry.label = label;
    };
    const remove = (...names) => names.forEach((slot) => slots.splice(slots.indexOf(find(slot)), 1));
    const add = (slot, label) => slots.push({ slot, label });
    switch (type) {
        case "WindShield":
            relabel("Emissive", "Secondary Details (RGBA)");
            relabel("DetailColor", "Details 1 (R), Icing Mask (G), Details 2 (B)");
            relabel("DetailNormal", "Icing Normal (use Detail UV Tiling)");
            relabel("OcclusionRoughnessMetallic", "Reflection (R), Roughness (G), Metallic (B)");
            relabel("DetailOcclusionRoughnessMetallic", "Detail Reflection (R), Detail Roughness(G), Detail Metallic (B)");
            relabel("Occlusion", "Reflection Mask (UV2)");
            remove("BlendMask");
            add("WiperMask", "Wiper Mask (RGBA)");
            add("WindshieldDetailNormal", "Detail Normal (use Detail UV Tiling)");
            add("ScratchesNormal", "Scratches Normal");
            add("WindshieldInsects", "Insects Albedo (RGBA)");
            add("WindshieldInsectsMask", "Insects Mask (A)");
            if (model.params.iridescent) add("IridescentThickness", "Iridescent Thickness (R)");
            break;
        case "GeoDecal Frosted":
            remove("BlendMask");
            relabel("DetailOcclusionRoughnessMetallic", "Melt pattern (R), Roughness (G), Metallic (B)");
            break;
        case "GeoDecal BlendMasked":
            relabel("BlendMask", "GeometryDecal Blend Mask");
            break;
        case "ClearCoat":
            if (model.params.clearcoatInverseRoughness) {
                relabel("OcclusionRoughnessMetallic", "Occlusion (R), Clearcoat Roughness (G), Metallic (B)");
            } else {
                add("ClearcoatColorRoughness", "Clearcoat Color (RGB), Clearcoat Roughness (A)");
            }
            add("ClearcoatNormal", "Clearcoat Normal");
            add("Dirt", "Wear Albedo (RGB), Mask (A)");
            add("DirtOcclusionRoughnessMetallic", "Wear Occlusion(R), Roughness(G), Metallic(B), Intensity(A)");
            break;
        case "Parallax Window":
            relabel("BaseColor", "Front Glass Color");
            relabel("Normal", "Front Glass Normal");
            relabel("DetailColor", "Behind Glass Color (RGB), Alpha (A)");
            relabel("Emissive", "Emissive Ins Window (RGB), offset Time (A)");
            remove("DetailNormal", "DetailOcclusionRoughnessMetallic", "BlendMask");
            add("BehindWindowMap", "Behind Window Map");
            break;
        case "Anisotropic":
        case "Hair":
            relabel("OcclusionRoughnessMetallic", "Occlusion (R), Aniso RoughnessX (G), Metallic (B)");
            add("AnisoDirectionRoughness", "Aniso Direction (RG), RoughnessY (B)");
            if (type === "Hair") remove("DetailColor", "DetailNormal", "DetailOcclusionRoughnessMetallic", "BlendMask");
            break;
        case "SSS":
            remove("DetailColor", "DetailNormal", "DetailOcclusionRoughnessMetallic", "BlendMask");
            add("Opacity", "Opacity");
            break;
        case "Fresnel Fade":
            remove("DetailColor", "DetailNormal", "DetailOcclusionRoughnessMetallic", "BlendMask");
            break;
        case "Tree":
        case "Vegetation":
            add("FoliageMask", "Foliage Mask (R), Translucency (G), WindMask (B)");
            break;
        case "Tire":
            relabel("BlendMask", "Tire Mud Cutout");
            add("TireDetails", "Tire Details : Mud (R), Dust (G)");
            add("TireMudNormal", "Tire Mud Normal");
            break;
        case "Standard":
            add("Dirt", "Wear Albedo (RGB), Mask (A)");
            add("DirtOcclusionRoughnessMetallic", "Wear Occlusion(R), Roughness(G), Metallic(B), Intensity(A)");
            break;
    }
    return slots;
}

export { buildMaterialEditor, colorToHex, hexToLinear, getMaxTextureSlots };
