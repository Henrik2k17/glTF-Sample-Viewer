// MSFS 2024 materials as the 3ds Max material defines them (MSFS2024_Material.ms: one flat
// parameter block plus texture file slots, a material type that decides what is used) and the
// two directions to and from glTF:
// - readMaterial: glTF material JSON -> Max parameters (the inverse of the exporter, missing
//   values are the exporter's omitted defaults)
// - writeMaterial: Max parameters -> glTF material JSON, a port of the exporter
//   (FlightSimMaterialExporter.cs: which extensions a type writes, defaults left out, forced
//   alpha modes, comp map in the metallic/roughness and occlusion slots, UV2 occlusion in
//   ASOBO_extra_occlusion, ...)
// Texture slots hold glTF texture infos ({ index, texCoord, extensions }) of the file.

const MaterialTypes = [
    "Standard",
    "Decal",
    "GeoDecal Frosted",
    "GeoDecal BlendMasked",
    "Glass",
    "WindShield",
    "Anisotropic",
    "ClearCoat",
    "Propeller",
    "Tire",
    "Tree",
    "Vegetation",
    "Hair",
    "SSS",
    "Sail",
    "Environment Occluder",
    "Invisible",
    "Fresnel Fade",
    "Ghost",
    "Parallax Window",
    "PortHole",
    "Fake Terrain"
];

const DecalModes = { Decal: "default", "GeoDecal Frosted": "frosted", "GeoDecal BlendMasked": "blendMasked" };
const MaterialCodes = { PortHole: "Porthole", Propeller: "Propeller", Tree: "Tree", Vegetation: "Vegetation" };

// Texture slots of the Max material (texturesUI), in its order
const TextureSlots = [
    "BaseColor",
    "OcclusionRoughnessMetallic",
    "Normal",
    "Emissive",
    "DetailColor",
    "DetailOcclusionRoughnessMetallic",
    "DetailNormal",
    "BlendMask",
    "FoliageMask",
    "Occlusion",
    "AnisoDirectionRoughness",
    "WiperMask",
    "WindshieldDetailNormal",
    "ScratchesNormal",
    "ClearcoatColorRoughness",
    "ClearcoatNormal",
    "Dirt",
    "DirtOcclusionRoughnessMetallic",
    "Opacity",
    "IridescentThickness",
    "WindshieldInsects",
    "WindshieldInsectsMask",
    "TireDetails",
    "TireMudNormal",
    "BehindWindowMap"
];

// Parameters with the values a glTF without them stands for (the exporter's defaults); where
// the Max default differs (e.g. emissiveMul 1000), a missing glTF value still reads as this.
const ParameterDefaults = {
    baseColor: [1, 1, 1, 1],
    emissive: [0, 0, 0],
    emissiveMul: 1,
    emissiveDayMul: 1,
    emissiveNightMul: 1,
    roughness: 1,
    metallic: 1,
    occlusionStrength: 1, // AO Strength spinner -> ASOBO_occlusion_strength
    aoTextureStrength: 1, // occlusionTexture.strength (legacy AO parameter)
    normalScale: 1,
    alphaMode: "OPAQUE", // OPAQUE, MASK, BLEND, DITHER
    alphaCutoff: 0.5,
    doubleSided: false,
    drawOrder: 0,
    dayNightCycle: false,
    disableMotionBlur: false,
    flipBackFace: false,
    noCastShadow: false,
    responsiveAA: false,
    collisionMaterial: false,
    roadMaterial: false,
    groundMaterial: false,
    clampUVX: false,
    clampUVY: false,
    clampUVZ: false,
    UVOffsetU: 0,
    UVOffsetV: 0,
    UVTilingU: 1,
    UVTilingV: 1,
    UVRotation: 0,
    detailUVScale: 1,
    detailNormalScale: 1,
    blendThreshold: 0,
    dirtUvScale: 1,
    dirtBlendSharpness: 0,
    dirtBlendAmount: 0,
    decalColorFactor: 1,
    decalRoughnessFactor: 1,
    decalMetalFactor: 1,
    decalOcclusionFactor: 1,
    decalNormalFactor: 1,
    decalEmissiveFactor: 1,
    decalNormalOverrideFactor: 1,
    decalBlendSharpnessFactor: 1,
    decalRenderOnClearcoat: false,
    decalChan0: true,
    decalChan1: false,
    decalChan2: true,
    pearlescent: false,
    pearlShift: 0,
    pearlRange: 0,
    pearlBrightness: 0,
    iridescent: false,
    iridescentMinThickness: 10,
    iridescentMaxThickness: 400,
    iridescentBrightness: 1,
    canReceiveRain: false,
    rainDropScale: 1,
    rainDropSide: false,
    clearcoatRoughnessFactor: 1,
    clearcoatNormalFactor: 1,
    clearcoatColorRoughnessTiling: 1,
    clearcoatNormalTiling: 1,
    clearcoatInverseRoughness: false,
    clearcoatBaseRoughness: 0.5,
    clearcoatBaseAffectCoat: true,
    detail1Rough: 0,
    detail2Rough: 0,
    detail1Opacity: 0,
    detail2Opacity: 0,
    microScratchesTiling: 1,
    microScratchesStrength: 1,
    detailNormalRefractScale: 1,
    wiperLines: false,
    wiperLinesTiling: 1,
    wiperLinesStrength: 1,
    wiperAnimState1: 0,
    cubemapReflectionMasking: false,
    ssrAttenuation: 1,
    SSSColor: [1, 1, 1],
    parallaxScale: 0,
    roomSizeXScale: 0.5,
    roomSizeYScale: 0.5,
    roomNumberXY: 5,
    corridor: false,
    glassWidth: 0, // meters (the Max UI shows millimeters)
    fresnelFactor: 1,
    fresnelOpacityOffset: 1,
    ghostBiasFactor: 0,
    ghostPowerFactor: 1,
    ghostScaleFactor: 1,
    sailLightAbsorption: 1,
    tireMudNormalTiling: 1,
    tireMudAnimState: 0,
    tireDustAnimState: 0
};

// Extensions this module reads and writes; any other material extension is kept as is.
const HandledExtensions = new Set([
    "ASOBO_occlusion_strength",
    "ASOBO_extra_occlusion",
    "ASOBO_material_emissive",
    "ASOBO_material_geometry_decal",
    "ASOBO_material_dirt",
    "ASOBO_material_ghost_effect",
    "ASOBO_material_draw_order",
    "ASOBO_material_day_night_switch",
    "ASOBO_material_disable_motion_blur",
    "ASOBO_material_flip_back_face",
    "ASOBO_material_pearlescent",
    "ASOBO_material_iridescent",
    "ASOBO_material_alphamode_dither",
    "ASOBO_material_invisible",
    "ASOBO_material_environment_occluder",
    "ASOBO_material_UV_options",
    "ASOBO_material_shadow_options",
    "ASOBO_material_antialiasing_options",
    "ASOBO_material_fake_terrain",
    "ASOBO_material_fresnel_fade",
    "ASOBO_material_detail_map",
    "ASOBO_material_SSS",
    "ASOBO_material_anisotropic_v2",
    "ASOBO_material_windshield_v3",
    "ASOBO_material_clear_coat_v2",
    "ASOBO_material_parallax_window",
    "ASOBO_material_glass_v2",
    "ASOBO_material_foliage_mask",
    "ASOBO_material_vegetation",
    "ASOBO_material_tire",
    "ASOBO_material_sail",
    "ASOBO_material_rain_options",
    "ASOBO_tags"
]);

const is = (type, ...types) => types.includes(type);
const clone = (value) => (value === undefined ? undefined : structuredClone(value));
// a value as read: null (the exporter writes some) and undefined mean "default"
const value = (v, fallback) => (v === undefined || v === null ? fallback : v);

/**
 * The 3ds Max material type of a glTF material (see the exporter). Materials without any MSFS
 * marker are Standard if the glTF is an MSFS asset, else undefined (plain glTF material).
 */
function detectMaterialType(json, msfsAsset = false) {
    const ext = json.extensions ?? {};
    const code = json.extras?.ASOBO_material_code;
    const decalMode = ext.ASOBO_material_geometry_decal?.mode;
    if (ext.ASOBO_material_invisible) return "Invisible";
    if (ext.ASOBO_material_environment_occluder) return "Environment Occluder";
    if (ext.ASOBO_material_fake_terrain) return "Fake Terrain";
    if (decalMode === "frosted") return "GeoDecal Frosted";
    if (decalMode === "blendMasked") return "GeoDecal BlendMasked";
    if (ext.ASOBO_material_geometry_decal) return "Decal";
    if (code === "Porthole") return "PortHole";
    if (code === "Propeller") return "Propeller";
    if (code === "Tree") return "Tree";
    if (code === "Vegetation" || ext.ASOBO_material_vegetation) return "Vegetation";
    if (ext.ASOBO_material_windshield_v3) return "WindShield";
    if (ext.ASOBO_material_glass_v2) return "Glass";
    if (ext.ASOBO_material_clear_coat_v2) return "ClearCoat";
    if (ext.ASOBO_material_parallax_window) return "Parallax Window";
    if (ext.ASOBO_material_ghost_effect) return "Ghost";
    if (ext.ASOBO_material_SSS && ext.ASOBO_material_anisotropic_v2) return "Hair";
    if (ext.ASOBO_material_SSS) return "SSS";
    if (ext.ASOBO_material_anisotropic_v2) return "Anisotropic";
    if (ext.ASOBO_material_fresnel_fade) return "Fresnel Fade";
    if (ext.ASOBO_material_sail) return "Sail";
    if (ext.ASOBO_material_tire) return "Tire";
    const marked = Object.keys(ext).some((name) => name.startsWith("ASOBO_")) || code !== undefined;
    return marked || msfsAsset ? "Standard" : undefined;
}

/** A texture slot's info without the properties its glTF location adds (scale, strength). */
function slotInfo(info) {
    if (info === undefined || info === null || typeof info.index !== "number") {
        return undefined;
    }
    const { scale, strength, ...rest } = clone(info);
    return rest;
}

/**
 * glTF material JSON -> { type, name, params, textures, extras, extensions (unhandled, kept),
 * compiledOcclusion } (Max parameters, see ParameterDefaults and TextureSlots).
 */
function readMaterial(json, msfsAsset = true) {
    const ext = json.extensions ?? {};
    const pbr = json.pbrMetallicRoughness ?? {};
    const type = detectMaterialType(json, msfsAsset) ?? "Standard";
    const p = structuredClone(ParameterDefaults);
    const t = {};

    const baseColor = pbr.baseColorFactor ?? [1, 1, 1, 1];
    p.baseColor = [baseColor[0], baseColor[1], baseColor[2], value(baseColor[3], 1)];
    // emissive = color x multiplier: split into a color with a maximum of 1 and the multiplier
    const emissive = json.emissiveFactor ?? [0, 0, 0];
    p.emissiveMul = Math.max(1, ...emissive);
    p.emissive = emissive.map((c) => c / p.emissiveMul);
    p.emissiveDayMul = value(ext.ASOBO_material_emissive?.emissiveDayMultiplier, 1);
    p.emissiveNightMul = value(ext.ASOBO_material_emissive?.emissiveNightMultiplier, 1);
    p.roughness = value(pbr.roughnessFactor, 1);
    p.metallic = value(pbr.metallicFactor, 1);
    p.occlusionStrength = value(ext.ASOBO_occlusion_strength?.strength, 1);
    p.aoTextureStrength = value(json.occlusionTexture?.strength, 1);
    p.normalScale = value(json.normalTexture?.scale, 1);
    p.alphaMode = ext.ASOBO_material_alphamode_dither ? "DITHER" : value(json.alphaMode, "OPAQUE");
    p.alphaCutoff = value(json.alphaCutoff, 0.5);
    p.doubleSided = json.doubleSided === true;
    p.drawOrder = value(ext.ASOBO_material_draw_order?.drawOrderOffset, 0);
    p.dayNightCycle = ext.ASOBO_material_day_night_switch !== undefined;
    p.disableMotionBlur = ext.ASOBO_material_disable_motion_blur !== undefined;
    p.flipBackFace = ext.ASOBO_material_flip_back_face !== undefined;
    p.noCastShadow = ext.ASOBO_material_shadow_options?.noCastShadow === true;
    p.responsiveAA = ext.ASOBO_material_antialiasing_options?.responsiveAA === true;
    const tags = (ext.ASOBO_tags?.tags ?? []).map((tag) => String(tag).toLowerCase());
    p.collisionMaterial = tags.includes("collision");
    p.roadMaterial = tags.includes("road");
    p.groundMaterial = tags.includes("ground");

    const uv = ext.ASOBO_material_UV_options;
    if (uv !== undefined) {
        // the exporter leaves out zeros: a missing tiling is 0
        p.clampUVX = uv.clampUVX === true;
        p.clampUVY = uv.clampUVY === true;
        p.clampUVZ = uv.clampUVZ === true;
        p.UVOffsetU = value(uv.UVOffsetU, 0);
        p.UVOffsetV = value(uv.UVOffsetV, 0);
        p.UVTilingU = value(uv.UVTilingU, 0);
        p.UVTilingV = value(uv.UVTilingV, 0);
        p.UVRotation = value(uv.UVRotation, 0);
    }

    const detail = ext.ASOBO_material_detail_map;
    p.detailUVScale = value(detail?.UVScale, 1);
    p.blendThreshold = value(detail?.blendThreshold, 0);
    p.detailNormalScale = value(detail?.detailNormalTexture?.scale, 1);

    const dirt = ext.ASOBO_material_dirt;
    if (dirt !== undefined) {
        p.dirtUvScale = value(dirt.dirtUvScale, 1);
        p.dirtBlendSharpness = value(dirt.dirtBlendSharpness, 0);
        p.dirtBlendAmount = value(dirt.dirtBlendAmount, 0);
    }

    const decal = ext.ASOBO_material_geometry_decal;
    if (decal !== undefined) {
        p.decalColorFactor = value(decal.baseColorBlendFactor, 1);
        p.decalRoughnessFactor = value(decal.roughnessBlendFactor, 1);
        p.decalMetalFactor = value(decal.metallicBlendFactor, 1);
        p.decalOcclusionFactor = value(decal.occlusionBlendFactor, 1);
        p.decalNormalFactor = value(decal.normalBlendFactor, 1);
        p.decalEmissiveFactor = value(decal.emissiveBlendFactor, 1);
        p.decalNormalOverrideFactor = value(decal.normalOverrideFactor, 1);
        p.decalBlendSharpnessFactor = value(decal.blendSharpnessFactor, 1);
        p.decalRenderOnClearcoat = decal.underClearcoat === false;
        p.decalChan0 = value(decal.decalChan0, true);
        p.decalChan1 = value(decal.decalChan1, false);
        p.decalChan2 = value(decal.decalChan2, true);
    }

    const pearl = ext.ASOBO_material_pearlescent;
    p.pearlescent = pearl !== undefined;
    p.pearlShift = value(pearl?.pearlShift, 0);
    p.pearlRange = value(pearl?.pearlRange, 0);
    p.pearlBrightness = value(pearl?.pearlBrightness, 0);

    const iridescent = ext.ASOBO_material_iridescent;
    p.iridescent = iridescent !== undefined;
    p.iridescentMinThickness = value(iridescent?.iridescentMinThickness, 10);
    p.iridescentMaxThickness = value(iridescent?.iridescentMaxThickness, 400);
    p.iridescentBrightness = value(iridescent?.iridescentBrightness, 1);

    const rain = ext.ASOBO_material_rain_options;
    p.canReceiveRain = rain !== undefined;
    p.rainDropScale = value(rain?.rainDropScale, 1);
    p.rainDropSide = rain?.rainDropSide === true;

    const coat = ext.ASOBO_material_clear_coat_v2;
    if (coat !== undefined) {
        p.clearcoatRoughnessFactor = value(coat.clearcoatRoughnessFactor, 1);
        p.clearcoatNormalFactor = value(coat.clearcoatNormalFactor, 1);
        p.clearcoatColorRoughnessTiling = value(coat.clearcoatColorRoughnessTiling, 1);
        p.clearcoatNormalTiling = value(coat.clearcoatNormalTiling, 1);
        p.clearcoatInverseRoughness = coat.clearcoatInverseRoughness === true;
        p.clearcoatBaseRoughness = value(coat.clearcoatBaseRoughness, 0.5);
        p.clearcoatBaseAffectCoat = value(coat.clearcoatBaseAffectCoat, true);
    }

    const shield = ext.ASOBO_material_windshield_v3;
    if (shield !== undefined) {
        p.detail1Rough = value(shield.detail1Rough, 0);
        p.detail2Rough = value(shield.detail2Rough, 0);
        p.detail1Opacity = value(shield.detail1Opacity, 0);
        p.detail2Opacity = value(shield.detail2Opacity, 0);
        p.microScratchesTiling = value(shield.microScratchesTiling, 1);
        p.microScratchesStrength = value(shield.microScratchesStrength, 1);
        p.detailNormalRefractScale = value(shield.detailNormalRefractScale, 1);
        p.wiperLines = shield.wiperLines === true;
        p.wiperLinesTiling = value(shield.wiperLinesTiling, 1);
        p.wiperLinesStrength = value(shield.wiperLinesStrength, 1);
        p.wiperAnimState1 = value(shield.wiper1State, 0);
        p.cubemapReflectionMasking = shield.cubemapReflectionMasking === true;
        p.ssrAttenuation = value(shield.ssrAttenuation, 1);
        // the windshield keeps the detail tiling and detail normal scale in its own extension
        p.detailUVScale = value(shield.UVScale, p.detailUVScale);
        p.detailNormalScale = value(shield.windshieldDetailNormalTexture?.scale, p.detailNormalScale);
    }

    const sss = ext.ASOBO_material_SSS;
    p.SSSColor = sss?.SSSColor ? [...sss.SSSColor] : [1, 1, 1];

    const parallax = ext.ASOBO_material_parallax_window;
    if (parallax !== undefined) {
        p.parallaxScale = value(parallax.parallaxScale, 0);
        p.roomSizeXScale = value(parallax.roomSizeXScale, 0.5);
        p.roomSizeYScale = value(parallax.roomSizeYScale, 0.5);
        p.roomNumberXY = value(parallax.roomNumberXY, 5);
        p.corridor = parallax.corridor === true;
    }
    p.glassWidth = value(ext.ASOBO_material_glass_v2?.glassWidth, 0);
    p.fresnelFactor = value(ext.ASOBO_material_fresnel_fade?.fresnelFactor, 1);
    p.fresnelOpacityOffset = value(ext.ASOBO_material_fresnel_fade?.fresnelOpacityOffset, 1);
    p.ghostBiasFactor = value(ext.ASOBO_material_ghost_effect?.bias, 0);
    p.ghostPowerFactor = value(ext.ASOBO_material_ghost_effect?.power, 1);
    p.ghostScaleFactor = value(ext.ASOBO_material_ghost_effect?.scale, 1);
    p.sailLightAbsorption = value(ext.ASOBO_material_sail?.sailLightAbsorption, 1);
    const tire = ext.ASOBO_material_tire;
    p.tireMudNormalTiling = value(tire?.tireMudNormalTiling, 1);
    p.tireMudAnimState = value(tire?.tireMudAnimState, 0);
    p.tireDustAnimState = value(tire?.tireDustAnimState, 0);

    // Textures. The comp map is in metallicRoughnessTexture (and occlusionTexture); a UV2
    // occlusion map is in ASOBO_extra_occlusion, or in occlusionTexture without a comp map.
    t.BaseColor = slotInfo(pbr.baseColorTexture);
    t.OcclusionRoughnessMetallic = slotInfo(pbr.metallicRoughnessTexture);
    t.Normal = slotInfo(json.normalTexture);
    t.Emissive = slotInfo(json.emissiveTexture);
    t.Occlusion = slotInfo(ext.ASOBO_extra_occlusion?.extraOcclusionTexture);
    if (t.Occlusion === undefined && json.occlusionTexture !== undefined) {
        const occlusion = slotInfo(json.occlusionTexture);
        if (t.OcclusionRoughnessMetallic === undefined) {
            if ((occlusion.texCoord ?? 0) === 1) {
                t.Occlusion = occlusion;
            } else {
                t.OcclusionRoughnessMetallic = occlusion;
            }
        }
    }
    // compiled packages point the occlusion texture at the extra occlusion map: keep it so
    const compiledOcclusion =
        t.Occlusion !== undefined && json.occlusionTexture !== undefined && json.occlusionTexture.index === t.Occlusion.index;
    t.DetailColor = slotInfo(detail?.detailColorTexture);
    t.DetailNormal = slotInfo(detail?.detailNormalTexture);
    t.DetailOcclusionRoughnessMetallic = slotInfo(detail?.detailMetalRoughAOTexture);
    t.BlendMask = slotInfo(detail?.blendMaskTexture ?? decal?.blendMaskTexture ?? tire?.tireMudCutoutTexture);
    t.FoliageMask = slotInfo(ext.ASOBO_material_foliage_mask?.foliageMaskTexture ?? ext.ASOBO_material_vegetation?.foliageMaskTexture);
    t.AnisoDirectionRoughness = slotInfo(ext.ASOBO_material_anisotropic_v2?.anisoDirectionRoughnessTexture);
    t.WiperMask = slotInfo(shield?.wiperMaskTexture);
    t.WindshieldDetailNormal = slotInfo(shield?.windshieldDetailNormalTexture);
    t.ScratchesNormal = slotInfo(shield?.scratchesNormalTexture);
    t.WindshieldInsects = slotInfo(shield?.windshieldInsectsTexture);
    t.WindshieldInsectsMask = slotInfo(shield?.windshieldInsectsMaskTexture);
    t.ClearcoatColorRoughness = slotInfo(coat?.clearcoatColorRoughnessTexture);
    t.ClearcoatNormal = slotInfo(coat?.clearcoatNormalTexture);
    t.Dirt = slotInfo(dirt?.dirtTexture);
    t.DirtOcclusionRoughnessMetallic = slotInfo(dirt?.dirtOcclusionRoughnessMetallicTexture);
    t.Opacity = slotInfo(sss?.opacityTexture);
    t.IridescentThickness = slotInfo(iridescent?.iridescentThicknessTexture);
    t.TireDetails = slotInfo(tire?.tireDetailsTexture);
    t.TireMudNormal = slotInfo(tire?.tireMudNormalTexture);
    t.BehindWindowMap = slotInfo(parallax?.behindWindowMapTexture);
    for (const slot of Object.keys(t)) {
        if (t[slot] === undefined) delete t[slot];
    }

    const extensions = {};
    for (const [name, extension] of Object.entries(ext)) {
        if (!HandledExtensions.has(name)) {
            extensions[name] = clone(extension);
        }
    }
    const { ASOBO_material_code, ...extras } = json.extras ?? {};
    return { type, name: json.name, params: p, textures: t, extras, extensions, compiledOcclusion, original: clone(json) };
}

/** Texture info for a glTF location: the slot's info plus a scale/strength unless default. */
function info(slot, extra = {}) {
    if (slot === undefined) {
        return undefined;
    }
    const result = clone(slot);
    for (const [key, v] of Object.entries(extra)) {
        if (v !== undefined) result[key] = v;
    }
    return result;
}

const unlessDefault = (v, fallback) => (v === fallback ? undefined : v);
// Removes undefined values (JSON.stringify would too, but structuredClone keeps them)
function compact(object) {
    for (const key of Object.keys(object)) {
        if (object[key] === undefined) delete object[key];
    }
    return object;
}

/**
 * Max parameters (readMaterial's model) -> glTF material JSON, as the exporter writes it.
 * Values at their default keep the presence they had in model.original (the material as read),
 * and keys of handled extensions this module does not know are kept, so unchanged values stay
 * as they are in the file (exporter versions differ in which defaults they write).
 */
function writeMaterial(model) {
    const json = writeExporterMaterial(model);
    if (model.original !== undefined) {
        reconcileWithOriginal(json, model.original, model.params);
    }
    return json;
}

function writeExporterMaterial(model) {
    const { type, params: p, textures: t } = model;
    const json = {};
    const ext = {};

    // pbrMetallicRoughness
    const pbr = {};
    const alpha = type === "Invisible" ? 0.7 : p.baseColor[3];
    const baseColor = [p.baseColor[0], p.baseColor[1], p.baseColor[2], alpha];
    if (baseColor.some((c, i) => c !== [1, 1, 1, 1][i])) pbr.baseColorFactor = baseColor;
    pbr.baseColorTexture = info(t.BaseColor);
    pbr.metallicFactor = unlessDefault(p.metallic, 1);
    pbr.roughnessFactor = unlessDefault(p.roughness, 1);
    pbr.metallicRoughnessTexture = info(t.OcclusionRoughnessMetallic);
    compact(pbr);
    if (Object.keys(pbr).length > 0) json.pbrMetallicRoughness = pbr;

    if (t.Normal) json.normalTexture = info(t.Normal, { scale: unlessDefault(p.normalScale, 1) });
    const aoStrength = unlessDefault(p.aoTextureStrength, 1);
    if (t.OcclusionRoughnessMetallic) {
        // compiled packages: the occlusion texture is the (sqrt encoded) extra occlusion map
        const occlusionSource = model.compiledOcclusion && t.Occlusion ? { ...t.Occlusion, texCoord: 1 } : t.OcclusionRoughnessMetallic;
        json.occlusionTexture = info(occlusionSource, { strength: aoStrength });
        if (t.Occlusion) {
            ext.ASOBO_extra_occlusion = { extraOcclusionTexture: info({ ...t.Occlusion, texCoord: 1 }) };
        }
    } else if (t.Occlusion) {
        json.occlusionTexture = info({ ...t.Occlusion, texCoord: 1 }, { strength: aoStrength });
    }
    if (t.Emissive) json.emissiveTexture = info(t.Emissive);
    const emissive = p.emissive.map((c) => c * p.emissiveMul);
    if (emissive.some((c) => c !== 0)) json.emissiveFactor = emissive;

    // alpha mode: forced for some types
    let alphaMode = p.alphaMode;
    if (is(type, "Decal", "GeoDecal Frosted", "GeoDecal BlendMasked", "WindShield", "Glass")) alphaMode = "BLEND";
    else if (is(type, "PortHole", "Propeller")) alphaMode = "OPAQUE";
    if (alphaMode === "DITHER") {
        ext.ASOBO_material_alphamode_dither = { enabled: true };
    } else if (alphaMode !== "OPAQUE") {
        json.alphaMode = alphaMode;
    }
    if (alphaMode === "MASK" && p.alphaCutoff !== 0.5) json.alphaCutoff = p.alphaCutoff;
    if (p.doubleSided) json.doubleSided = true;
    if (model.name !== undefined) json.name = model.name;

    // extensions, roughly in the exporter's order
    if (p.occlusionStrength !== 1) ext.ASOBO_occlusion_strength = { strength: p.occlusionStrength };
    if (p.drawOrder !== 0) ext.ASOBO_material_draw_order = { drawOrderOffset: Math.round(p.drawOrder) };
    if (p.responsiveAA) ext.ASOBO_material_antialiasing_options = { responsiveAA: true };
    if (p.noCastShadow) ext.ASOBO_material_shadow_options = { noCastShadow: true };
    const tags = [p.collisionMaterial && "Collision", p.roadMaterial && "Road", p.groundMaterial && "Ground"].filter(Boolean);
    if (tags.length > 0) ext.ASOBO_tags = { tags };
    ext.ASOBO_material_emissive = { emissiveDayMultiplier: p.emissiveDayMul, emissiveNightMultiplier: p.emissiveNightMul };

    if (is(type, "ClearCoat", "WindShield") && p.canReceiveRain) {
        ext.ASOBO_material_rain_options = compact({
            rainDropScale: unlessDefault(p.rainDropScale, 1),
            rainDropSide: type === "WindShield" ? unlessDefault(p.rainDropSide, false) : undefined
        });
    }
    if (type === "Standard" && p.pearlescent) {
        ext.ASOBO_material_pearlescent = { pearlShift: p.pearlShift, pearlRange: p.pearlRange, pearlBrightness: p.pearlBrightness };
    }
    if (type === "WindShield" && p.iridescent) {
        ext.ASOBO_material_iridescent = compact({
            iridescentMinThickness: unlessDefault(p.iridescentMinThickness, 10),
            iridescentMaxThickness: unlessDefault(p.iridescentMaxThickness, 400),
            iridescentBrightness: unlessDefault(p.iridescentBrightness, 1),
            iridescentThicknessTexture: info(t.IridescentThickness)
        });
    }
    if (is(type, "Standard", "ClearCoat")) {
        if (t.Dirt) {
            ext.ASOBO_material_dirt = compact({
                dirtTexture: info(t.Dirt),
                dirtOcclusionRoughnessMetallicTexture: info(t.DirtOcclusionRoughnessMetallic),
                dirtUvScale: unlessDefault(p.dirtUvScale, 1),
                dirtBlendSharpness: unlessDefault(p.dirtBlendSharpness, 0),
                dirtBlendAmount: p.dirtBlendAmount
            });
        }
        if (p.dayNightCycle) ext.ASOBO_material_day_night_switch = {};
    }
    if (p.disableMotionBlur) ext.ASOBO_material_disable_motion_blur = { enabled: true };
    if (p.flipBackFace && !is(type, "Sail", "Environment Occluder") && p.doubleSided) ext.ASOBO_material_flip_back_face = {};
    if (is(type, "Anisotropic", "Hair") && t.AnisoDirectionRoughness) {
        ext.ASOBO_material_anisotropic_v2 = { anisoDirectionRoughnessTexture: info(t.AnisoDirectionRoughness) };
    }
    if (type === "Tree" && t.FoliageMask) ext.ASOBO_material_foliage_mask = { foliageMaskTexture: info(t.FoliageMask) };
    if (type === "Vegetation") ext.ASOBO_material_vegetation = compact({ foliageMaskTexture: info(t.FoliageMask) });
    if (type === "Tire") {
        ext.ASOBO_material_tire = compact({
            tireDetailsTexture: info(t.TireDetails),
            tireMudCutoutTexture: info(t.BlendMask),
            // tire details are needed for the mud normal
            tireMudNormalTexture: t.TireDetails ? info(t.TireMudNormal) : undefined,
            tireMudNormalTiling: p.tireMudNormalTiling,
            tireMudAnimState: p.tireMudAnimState,
            tireDustAnimState: p.tireDustAnimState
        });
    }
    if (type === "WindShield") {
        const shield = {
            wiperLines: unlessDefault(p.wiperLines, false),
            detail1Rough: unlessDefault(p.detail1Rough, 0),
            detail2Rough: unlessDefault(p.detail2Rough, 0),
            detail1Opacity: unlessDefault(p.detail1Opacity, 0),
            detail2Opacity: unlessDefault(p.detail2Opacity, 0),
            microScratchesTiling: unlessDefault(p.microScratchesTiling, 1),
            microScratchesStrength: unlessDefault(p.microScratchesStrength, 1),
            detailNormalRefractScale: unlessDefault(p.detailNormalRefractScale, 1),
            UVScale: unlessDefault(p.detailUVScale, 1),
            wiper1State: p.wiperAnimState1,
            cubemapReflectionMasking: unlessDefault(p.cubemapReflectionMasking, false),
            ssrAttenuation: unlessDefault(p.ssrAttenuation, 1),
            wiperMaskTexture: info(t.WiperMask),
            windshieldDetailNormalTexture: info(t.WindshieldDetailNormal, { scale: unlessDefault(p.detailNormalScale, 1) }),
            scratchesNormalTexture: info(t.ScratchesNormal),
            windshieldInsectsTexture: info(t.WindshieldInsects),
            windshieldInsectsMaskTexture: t.WindshieldInsects ? info(t.WindshieldInsectsMask) : undefined
        };
        if (p.wiperLines && t.WiperMask) {
            shield.wiperLinesTiling = unlessDefault(p.wiperLinesTiling, 1);
            shield.wiperLinesStrength = unlessDefault(p.wiperLinesStrength, 1);
        }
        ext.ASOBO_material_windshield_v3 = compact(shield);
    }
    if (is(type, "SSS", "Hair")) {
        const sssColor = p.SSSColor.every((c) => c === 1) ? undefined : [...p.SSSColor];
        ext.ASOBO_material_SSS = compact({ SSSColor: sssColor, opacityTexture: info(t.Opacity) });
    }
    if (type === "Parallax Window") {
        ext.ASOBO_material_parallax_window = compact({
            parallaxScale: p.parallaxScale,
            roomSizeXScale: p.roomSizeXScale,
            roomSizeYScale: p.roomSizeYScale,
            roomNumberXY: p.roomNumberXY,
            corridor: p.corridor,
            behindWindowMapTexture: info(t.BehindWindowMap)
        });
    }
    const uvUsed = p.clampUVX || p.clampUVY || p.clampUVZ || p.UVOffsetU !== 0 || p.UVOffsetV !== 0 || p.UVTilingU !== 1 || p.UVTilingV !== 1 || p.UVRotation !== 0;
    if (uvUsed) {
        // zeros and false are left out (missing tiling = 0)
        ext.ASOBO_material_UV_options = compact({
            clampUVX: p.clampUVX || undefined,
            clampUVY: p.clampUVY || undefined,
            clampUVZ: p.clampUVZ || undefined,
            UVOffsetU: unlessDefault(p.UVOffsetU, 0),
            UVOffsetV: unlessDefault(p.UVOffsetV, 0),
            UVTilingU: unlessDefault(p.UVTilingU, 0),
            UVTilingV: unlessDefault(p.UVTilingV, 0),
            UVRotation: unlessDefault(p.UVRotation, 0)
        });
    }
    if (type === "Fresnel Fade") ext.ASOBO_material_fresnel_fade = { fresnelFactor: p.fresnelFactor, fresnelOpacityOffset: p.fresnelOpacityOffset };
    if (type === "Ghost") ext.ASOBO_material_ghost_effect = { bias: p.ghostBiasFactor, power: p.ghostPowerFactor, scale: p.ghostScaleFactor };
    if (type === "Glass") ext.ASOBO_material_glass_v2 = { glassWidth: p.glassWidth };
    if (type === "Sail") ext.ASOBO_material_sail = compact({ sailLightAbsorption: unlessDefault(p.sailLightAbsorption, 1) });
    if (type === "ClearCoat") {
        ext.ASOBO_material_clear_coat_v2 = compact({
            clearcoatColorRoughnessTexture: p.clearcoatInverseRoughness ? undefined : info(t.ClearcoatColorRoughness),
            clearcoatNormalTexture: info(t.ClearcoatNormal),
            clearcoatRoughnessFactor: p.clearcoatRoughnessFactor,
            clearcoatNormalFactor: p.clearcoatNormalFactor,
            clearcoatColorRoughnessTiling: p.clearcoatColorRoughnessTiling,
            clearcoatNormalTiling: p.clearcoatNormalTiling,
            clearcoatInverseRoughness: p.clearcoatInverseRoughness,
            clearcoatBaseRoughness: p.clearcoatInverseRoughness ? p.clearcoatBaseRoughness : undefined,
            clearcoatBaseAffectCoat: p.clearcoatBaseAffectCoat
        });
    }
    if (type !== "Parallax Window" && (t.DetailColor || t.DetailNormal || t.DetailOcclusionRoughnessMetallic || t.BlendMask)) {
        const blendMaskInDetail = !is(type, "GeoDecal BlendMasked", "Tire");
        const detail = compact({
            UVScale: unlessDefault(p.detailUVScale, 1),
            blendThreshold: unlessDefault(p.blendThreshold, 0),
            detailColorTexture: info(t.DetailColor),
            detailNormalTexture: info(t.DetailNormal, { scale: unlessDefault(p.detailNormalScale, 1) }),
            detailMetalRoughAOTexture: info(t.DetailOcclusionRoughnessMetallic),
            blendMaskTexture: blendMaskInDetail ? info(t.BlendMask) : undefined
        });
        // a blend mask that went to the decal/tire extension leaves an empty detail map behind
        // in the exporter only if another detail texture exists
        if (detail.detailColorTexture || detail.detailNormalTexture || detail.detailMetalRoughAOTexture || detail.blendMaskTexture) {
            ext.ASOBO_material_detail_map = detail;
        }
    }
    if (DecalModes[type] !== undefined) {
        const decal = {
            mode: DecalModes[type],
            baseColorBlendFactor: unlessDefault(p.decalColorFactor, 1),
            metallicBlendFactor: unlessDefault(p.decalMetalFactor, 1),
            roughnessBlendFactor: unlessDefault(p.decalRoughnessFactor, 1),
            normalBlendFactor: unlessDefault(p.decalNormalFactor, 1),
            emissiveBlendFactor: unlessDefault(p.decalEmissiveFactor, 1),
            occlusionBlendFactor: unlessDefault(p.decalOcclusionFactor, 1),
            blendSharpnessFactor: p.decalBlendSharpnessFactor,
            normalOverrideFactor: unlessDefault(p.decalNormalOverrideFactor, 1),
            underClearcoat: p.decalRenderOnClearcoat ? false : undefined
        };
        if (type === "Decal") {
            decal.decalChan0 = p.decalChan0;
            decal.decalChan1 = p.decalChan1;
            decal.decalChan2 = p.decalChan2;
        }
        if (type === "GeoDecal BlendMasked") decal.blendMaskTexture = info(t.BlendMask);
        ext.ASOBO_material_geometry_decal = compact(decal);
    }
    if (type === "Invisible") ext.ASOBO_material_invisible = { enabled: true };
    if (type === "Fake Terrain") ext.ASOBO_material_fake_terrain = { enabled: true };
    if (type === "Environment Occluder") ext.ASOBO_material_environment_occluder = { enabled: true };

    // extensions this module does not handle, as they were
    Object.assign(ext, clone(model.extensions ?? {}));
    json.extensions = ext;

    const extras = { ...clone(model.extras ?? {}) };
    if (MaterialCodes[type] !== undefined) extras.ASOBO_material_code = MaterialCodes[type];
    if (Object.keys(extras).length > 0) json.extras = extras;
    return json;
}

// Default values of the keys the writer produces, per extension (exporter Defaults)
const ExtensionDefaults = {
    ASOBO_material_emissive: { emissiveDayMultiplier: 1, emissiveNightMultiplier: 1 },
    ASOBO_occlusion_strength: { strength: 1 },
    ASOBO_material_draw_order: { drawOrderOffset: 0 },
    ASOBO_material_shadow_options: { noCastShadow: false },
    ASOBO_material_antialiasing_options: { responsiveAA: false },
    ASOBO_material_disable_motion_blur: { enabled: true },
    ASOBO_material_alphamode_dither: { enabled: true },
    ASOBO_material_invisible: { enabled: true },
    ASOBO_material_fake_terrain: { enabled: true },
    ASOBO_material_environment_occluder: { enabled: true },
    ASOBO_material_UV_options: { clampUVX: false, clampUVY: false, clampUVZ: false, UVOffsetU: 0, UVOffsetV: 0, UVTilingU: 0, UVTilingV: 0, UVRotation: 0 },
    ASOBO_material_detail_map: { UVScale: 1, blendThreshold: 0 },
    ASOBO_material_dirt: { dirtUvScale: 1, dirtBlendSharpness: 0, dirtBlendAmount: 0 },
    ASOBO_material_geometry_decal: {
        baseColorBlendFactor: 1, metallicBlendFactor: 1, roughnessBlendFactor: 1, normalBlendFactor: 1, emissiveBlendFactor: 1,
        occlusionBlendFactor: 1, blendSharpnessFactor: 1, normalOverrideFactor: 1, underClearcoat: true,
        decalChan0: true, decalChan1: false, decalChan2: true, mode: "default"
    },
    ASOBO_material_flip_back_face: { enabled: true },
    ASOBO_material_pearlescent: { pearlShift: 0, pearlRange: 0, pearlBrightness: 0 },
    ASOBO_material_iridescent: { iridescentMinThickness: 10, iridescentMaxThickness: 400, iridescentBrightness: 1 },
    ASOBO_material_rain_options: { rainDropScale: 1, rainDropSide: false },
    ASOBO_material_clear_coat_v2: {
        clearcoatRoughnessFactor: 1, clearcoatNormalFactor: 1, clearcoatColorRoughnessTiling: 1, clearcoatNormalTiling: 1,
        clearcoatInverseRoughness: false, clearcoatBaseRoughness: 0.5, clearcoatBaseAffectCoat: true
    },
    ASOBO_material_windshield_v3: {
        detail1Rough: 0, detail2Rough: 0, detail1Opacity: 0, detail2Opacity: 0, microScratchesTiling: 1, microScratchesStrength: 1,
        detailNormalRefractScale: 1, wiperLines: false, wiperLinesTiling: 1, wiperLinesStrength: 1, UVScale: 1, wiper1State: 0,
        cubemapReflectionMasking: false, ssrAttenuation: 1
    },
    ASOBO_material_SSS: { SSSColor: [1, 1, 1] },
    ASOBO_material_parallax_window: { parallaxScale: 0, roomSizeXScale: 0.5, roomSizeYScale: 0.5, roomNumberXY: 5, corridor: false },
    ASOBO_material_glass_v2: { glassWidth: 0 },
    ASOBO_material_fresnel_fade: { fresnelFactor: 1, fresnelOpacityOffset: 1 },
    ASOBO_material_ghost_effect: { bias: 0, power: 1, scale: 1 },
    ASOBO_material_sail: { sailLightAbsorption: 1 },
    ASOBO_material_tire: { tireMudNormalTiling: 1, tireMudAnimState: 0, tireDustAnimState: 0 }
};
// Keys the writer may produce besides the defaults above (textures, tags)
const ExtensionStructureKeys = new Set(["tags"]);
// Marker extensions kept from the original while their parameter is still set (see reconcile)
const MarkerExtensions = {
    ASOBO_material_flip_back_face: (params) => params.flipBackFace === true
};
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isTextureKey = (key) => key.endsWith("Texture");

/** Aligns default-valued keys with their presence in the original (see writeMaterial). */
function reconcileWithOriginal(json, original, params) {
    const topDefaults = { alphaMode: "OPAQUE", emissiveFactor: [0, 0, 0], doubleSided: false };
    if (json.alphaMode === "MASK" || original.alphaMode === "MASK") topDefaults.alphaCutoff = 0.5;
    alignDefaults(json, original, topDefaults);
    if (original.pbrMetallicRoughness !== undefined || json.pbrMetallicRoughness !== undefined) {
        json.pbrMetallicRoughness ??= {};
        alignDefaults(json.pbrMetallicRoughness, original.pbrMetallicRoughness ?? {}, {
            metallicFactor: 1,
            roughnessFactor: 1,
            baseColorFactor: [1, 1, 1, 1]
        });
        if (Object.keys(json.pbrMetallicRoughness).length === 0) delete json.pbrMetallicRoughness;
    }
    if (json.normalTexture && original.normalTexture) alignDefaults(json.normalTexture, original.normalTexture, { scale: 1 });
    if (json.occlusionTexture && original.occlusionTexture) alignDefaults(json.occlusionTexture, original.occlusionTexture, { strength: 1 });
    // compiled packages leave out the occlusion texture that repeats the comp map
    const comp = json.pbrMetallicRoughness?.metallicRoughnessTexture;
    if (original.occlusionTexture === undefined && json.occlusionTexture !== undefined && comp !== undefined &&
        json.occlusionTexture.index === comp.index && (json.occlusionTexture.texCoord ?? 0) === (comp.texCoord ?? 0)) {
        delete json.occlusionTexture;
    }
    if (original.extras !== undefined && json.extras === undefined && Object.keys(original.extras).length === 0) {
        json.extras = {};
    }

    const originalExtensions = original.extensions ?? {};
    json.extensions ??= {};
    for (const [name, defaults] of Object.entries(ExtensionDefaults)) {
        const written = json.extensions[name];
        const before = originalExtensions[name];
        const onlyDefaults = (object) => Object.entries(object).every(([key, v]) => v === null || sameValue(v, defaults[key]));
        // the emissive extension (always written by the exporter) keeps its presence when default
        if (name === "ASOBO_material_emissive") {
            if (written !== undefined && before === undefined && onlyDefaults(written)) {
                delete json.extensions[name];
                continue;
            }
            if (written === undefined && before !== undefined && onlyDefaults(before)) {
                json.extensions[name] = clone(before);
                continue;
            }
        }
        // a marker extension the exporter would leave out now (e.g. flip back face without
        // double sided) stays as long as its parameter is still on
        if (written === undefined && before !== undefined && MarkerExtensions[name]?.(params)) {
            json.extensions[name] = clone(before);
            continue;
        }
        if (written === undefined || before === undefined) {
            continue;
        }
        // windshields: the detail tiling may only be in the detail map (compiled packages)
        if (name === "ASOBO_material_windshield_v3" && !("UVScale" in before) &&
            written.UVScale === (original.extensions?.ASOBO_material_detail_map?.UVScale ?? 1)) {
            delete written.UVScale;
        }
        for (const [key, v] of Object.entries(before)) {
            if (key in written) {
                continue;
            }
            const known = key in defaults || ExtensionStructureKeys.has(key) || isTextureKey(key);
            if (!known) {
                written[key] = clone(v); // e.g. a key of an older exporter
            } else if (!isTextureKey(key) && (v === null || sameValue(v, defaults[key])) && keepsDefault(name, key, written)) {
                written[key] = clone(v);
            }
        }
        for (const [key, v] of Object.entries(written)) {
            if (!(key in before) && key in defaults && sameValue(v, defaults[key])) {
                delete written[key];
            }
        }
    }
    if (Object.keys(json.extensions).length === 0) {
        delete json.extensions;
    }
}

// A default value the original had is kept unless the writer left it out on purpose
// (e.g. clearcoat base roughness without uniform base roughness).
function keepsDefault(extension, key, written) {
    if (extension === "ASOBO_material_clear_coat_v2" && key === "clearcoatBaseRoughness") {
        return written.clearcoatInverseRoughness === true;
    }
    return true;
}

function alignDefaults(target, original, defaults) {
    for (const [key, fallback] of Object.entries(defaults)) {
        if (key in original && !(key in target) && (original[key] === null || sameValue(original[key], fallback))) {
            target[key] = clone(original[key]);
        } else if (!(key in original) && key in target && sameValue(target[key], fallback)) {
            delete target[key];
        }
    }
}

/**
 * Changes the material type like the 3ds Max material does (updateUI): some types force
 * values (Windshield/Glass metallic 0, Vegetation metallic 1, Parallax/Propeller opaque,
 * Ghost and GeoDecal Frosted blended, Ghost casts no shadow).
 * @returns {string[]} the parameters that changed besides the type
 */
function setMaterialType(model, type) {
    const p = model.params;
    const before = { ...p };
    model.type = type;
    if (type === "WindShield" || type === "Glass") p.metallic = 0;
    if (type === "Vegetation") p.metallic = 1;
    if (type === "Parallax Window" || type === "Propeller") p.alphaMode = "OPAQUE";
    if (type === "Ghost") {
        p.noCastShadow = true;
        p.alphaMode = "BLEND";
    }
    if (type === "GeoDecal Frosted") p.alphaMode = "BLEND";
    return Object.keys(p).filter((key) => p[key] !== before[key]);
}

/** Texture indices (glTF textures) a material model uses. */
function usedTextureIndices(model) {
    return new Set(Object.values(model.textures).map((slot) => slot.index));
}

export {
    MaterialTypes,
    TextureSlots,
    ParameterDefaults,
    detectMaterialType,
    readMaterial,
    writeMaterial,
    setMaterialType,
    usedTextureIndices
};
