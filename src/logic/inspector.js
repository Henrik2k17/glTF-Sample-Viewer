// Scene inspector: turns the loaded glTF into a flat node tree and per-node detail sections
// for the Inspector tab. Covers MSFS (ASOBO_*) data such as unique ids, tags, gizmos and lights.

const MsfsNodeLightExtensions = ["ASOBO_street_light", "ASOBO_advanced_light", "ASOBO_sky_portal"];
const MsfsMeshObjectExtensions = {
    ASOBO_gizmo_object: "gizmo_objects",
    ASOBO_fade_object: "fade_objects"
};

// How the viewer handles each MSFS material extension:
// "as Max" follows Asobo's 3ds Max viewport shaders, "approx." approximates the sim,
// "sim only" is not rendered (nothing defines how the sim draws it), "no effect" has nothing
// to show in a viewer.
const MsfsMaterialSupport = {
    ASOBO_material_UV_options: ["as Max", "tiling, offset, rotation; clamp as clamp-to-edge"],
    ASOBO_material_detail_map: ["as Max", "color, normal, blend mask; metal/rough/AO map only in debug channels (unused in Max)"],
    ASOBO_occlusion_strength: ["as Max", ""],
    ASOBO_extra_occlusion: ["as Max", ""],
    ASOBO_material_pearlescent: ["as Max", ""],
    ASOBO_material_dirt: ["as Max", "roughness/metal read from G/B, not alpha"],
    ASOBO_material_tire: ["as Max", "mud cutout and mud normal unused (as in Max)"],
    ASOBO_material_parallax_window: ["as Max", ""],
    ASOBO_material_emissive: ["as Max", "day/night multiplier (Display tab: night lighting)"],
    ASOBO_material_invisible: ["as Max", "hidden unless shown in the Display tab"],
    ASOBO_material_draw_order: ["approx.", "depth bias and sort order"],
    ASOBO_material_geometry_decal: ["approx.", "color and normal blend factors; metal/rough/AO factors and modes ignored"],
    ASOBO_material_clear_coat_v2: ["approx.", "as KHR clearcoat; coat color not supported"],
    ASOBO_material_iridescent: ["approx.", "as KHR iridescence"],
    ASOBO_material_alphamode_dither: ["approx.", "alpha blended instead of dithered"],
    ASOBO_material_windshield_v3: ["sim only", "wipers, rain, scratches"],
    ASOBO_material_glass_v2: ["sim only", "glass thickness"],
    ASOBO_material_rain_options: ["sim only", "rain drops"],
    ASOBO_material_SSS: ["sim only", "subsurface scattering"],
    ASOBO_material_anisotropic_v2: ["sim only", "anisotropic reflections"],
    ASOBO_material_fresnel_fade: ["sim only", ""],
    ASOBO_material_ghost_effect: ["sim only", ""],
    ASOBO_material_sail: ["sim only", "light absorption"],
    ASOBO_material_vegetation: ["sim only", ""],
    ASOBO_material_foliage_mask: ["sim only", ""],
    ASOBO_material_fake_terrain: ["sim only", ""],
    ASOBO_material_environment_occluder: ["sim only", ""],
    ASOBO_material_day_night_switch: ["sim only", ""],
    ASOBO_material_shadow_options: ["no effect", "the viewer casts no shadows"],
    ASOBO_material_antialiasing_options: ["no effect", ""],
    ASOBO_material_disable_motion_blur: ["no effect", ""],
    ASOBO_material_flip_back_face: ["no effect", "back faces are lit with flipped normals anyway"],
    ASOBO_tags: ["no effect", "metadata"]
};

function getMsfsSupport(extensionName) {
    return MsfsMaterialSupport[extensionName] ?? ["unknown", ""];
}

/**
 * Model-wide overview of the MSFS material extensions: how many materials use each and how
 * the viewer handles it, least supported first.
 * @returns {{name: string, count: number, status: string, note: string}[]}
 */
function getMsfsMaterialSummary(gltf) {
    const counts = new Map();
    for (const material of gltf?.materials ?? []) {
        for (const name of Object.keys(material.extensions ?? {})) {
            if (name.startsWith("ASOBO_")) {
                counts.set(name, (counts.get(name) ?? 0) + 1);
            }
        }
    }
    const order = ["sim only", "unknown", "approx.", "as Max", "no effect"];
    return [...counts.entries()]
        .map(([name, count]) => {
            const [status, note] = getMsfsSupport(name);
            return { name, count, status, note };
        })
        .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.count - a.count);
}

const PrimitiveModes = ["POINTS", "LINES", "LINE_LOOP", "LINE_STRIP", "TRIANGLES", "TRIANGLE_STRIP", "TRIANGLE_FAN"];

// Only extensions still in their JSON form are shown verbatim; ones the renderer parsed into
// classes (KHR_*) carry GL state and are listed by name.
function isPlainJson(value) {
    return (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) === Object.prototype
    );
}

function formatJson(value) {
    return JSON.stringify(value, null, 2);
}

function formatNumber(value) {
    const rounded = Math.round(value * 10000) / 10000;
    return Object.is(rounded, -0) ? "0" : String(rounded);
}

function formatVector(vector) {
    return Array.from(vector, formatNumber).join(", ");
}

function quaternionToEulerDegrees([x, y, z, w]) {
    const toDegrees = 180 / Math.PI;
    const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
    const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    return [roll * toDegrees, pitch * toDegrees, yaw * toDegrees];
}

function nodeTitle(node, index) {
    return node.name ?? `Node ${index}`;
}

function materialTitle(gltf, index) {
    return gltf.materials[index]?.name ?? `Material ${index}`;
}

function getUniqueId(node) {
    return node.extensions?.ASOBO_unique_id?.id;
}

function getMeshObjects(mesh) {
    const objects = [];
    for (const [extension, listKey] of Object.entries(MsfsMeshObjectExtensions)) {
        for (const object of mesh?.extensions?.[extension]?.[listKey] ?? []) {
            objects.push({ extension, object });
        }
    }
    return objects;
}

function getNodeLight(gltf, node) {
    const index = node.extensions?.KHR_lights_punctual?.light;
    if (index === undefined) {
        return undefined;
    }
    return { index, light: gltf.extensions?.KHR_lights_punctual?.lights?.[index] };
}

function getNodeTags(gltf, node) {
    const tags = new Set();
    const mesh = gltf.meshes[node.mesh];
    for (const primitive of mesh?.primitives ?? []) {
        for (const tag of gltf.materials[primitive.material]?.extensions?.ASOBO_tags?.tags ?? []) {
            tags.add(tag);
        }
    }
    for (const { object } of getMeshObjects(mesh)) {
        for (const tag of object.extensions?.ASOBO_tags?.tags ?? []) {
            tags.add(tag);
        }
    }
    return [...tags];
}

function getAnimatedNodeIndices(gltf) {
    const indices = new Set();
    for (const animation of gltf.animations) {
        for (const channel of animation.channels ?? []) {
            if (channel.target?.node !== undefined) {
                indices.add(channel.target.node);
            }
        }
    }
    return indices;
}

/**
 * Depth-first list of the scene's nodes with what the tree needs to draw a row.
 * @returns {{index: number, name: string, uniqueId: string|undefined, depth: number,
 *   parent: number|undefined, childCount: number, badges: string[], tags: string[]}[]}
 */
function buildNodeTree(gltf, sceneIndex) {
    const scene = gltf?.scenes?.[sceneIndex];
    if (scene === undefined) {
        return [];
    }
    const animated = getAnimatedNodeIndices(gltf);
    const rows = [];
    const visit = (index, depth, parent) => {
        const node = gltf.nodes[index];
        const mesh = gltf.meshes[node.mesh];
        const badges = [];
        if (mesh !== undefined) {
            badges.push("mesh");
        }
        if (getNodeLight(gltf, node) !== undefined || MsfsNodeLightExtensions.some((e) => node.extensions?.[e])) {
            badges.push("light");
        }
        if (getMeshObjects(mesh).length > 0) {
            badges.push("gizmo");
        }
        if (node.camera !== undefined) {
            badges.push("camera");
        }
        if (node.skin !== undefined) {
            badges.push("skin");
        }
        if (animated.has(index)) {
            badges.push("anim");
        }
        rows.push({
            index,
            name: nodeTitle(node, index),
            uniqueId: getUniqueId(node),
            depth,
            parent,
            childCount: node.children.length,
            badges,
            tags: getNodeTags(gltf, node)
        });
        for (const child of node.children) {
            visit(child, depth + 1, index);
        }
    };
    for (const root of scene.nodes) {
        visit(root, 0, undefined);
    }
    return rows;
}

/** The node and all its descendants, for highlighting a whole subtree. */
function collectSubtree(gltf, nodeIndex) {
    const indices = new Set();
    const stack = [nodeIndex];
    while (stack.length > 0) {
        const index = stack.pop();
        indices.add(index);
        stack.push(...gltf.nodes[index].children);
    }
    return indices;
}

function extensionSections(owner, extensions, skip = []) {
    const sections = [];
    const parsed = [];
    for (const [name, value] of Object.entries(extensions ?? {})) {
        if (skip.includes(name)) {
            continue;
        }
        if (isPlainJson(value)) {
            sections.push({ title: `${owner} · ${name}`, json: formatJson(value) });
        } else {
            parsed.push(name);
        }
    }
    if (parsed.length > 0) {
        sections.push({ title: `${owner} · other extensions`, rows: [["Parsed", parsed.join(", ")]] });
    }
    return sections;
}

function primitiveRows(gltf, primitive) {
    const rows = [];
    const position = gltf.accessors[primitive.attributes?.POSITION];
    if (position !== undefined) {
        rows.push(["Vertices", String(position.count)]);
    }
    const indices = gltf.accessors[primitive.indices];
    const mode = primitive.mode ?? 4;
    if (mode === 4) {
        rows.push(["Triangles", String((indices?.count ?? position?.count ?? 0) / 3)]);
    } else {
        rows.push(["Mode", PrimitiveModes[mode] ?? String(mode)]);
    }
    rows.push(["Attributes", Object.keys(primitive.attributes ?? {}).join(", ")]);
    return rows;
}

function materialSections(gltf, materialIndex) {
    const material = gltf.materials[materialIndex];
    if (material === undefined) {
        return [];
    }
    const title = `Material ${materialIndex}: ${materialTitle(gltf, materialIndex)}`;
    const rows = [
        ["Alpha mode", material.alphaMode ?? "OPAQUE"],
        ["Double sided", String(material.doubleSided ?? false)]
    ];
    const tags = material.extensions?.ASOBO_tags?.tags;
    if (tags?.length) {
        rows.push(["Tags", tags.join(", ")]);
    }
    const materialCode = material.extras?.ASOBO_material_code;
    if (materialCode !== undefined) {
        rows.push(["MSFS type", String(materialCode)]);
    }
    for (const name of Object.keys(material.extensions ?? {}).filter((key) => key.startsWith("ASOBO_"))) {
        const [status, note] = getMsfsSupport(name);
        rows.push([name.replace(/^ASOBO_(material_)?/, ""), note === "" ? status : `${status}: ${note}`]);
    }
    const asobo = Object.fromEntries(
        Object.entries(material.extensions ?? {}).filter(([name]) => name.startsWith("ASOBO_"))
    );
    const section = { title, rows, materialIndex };
    if (Object.keys(asobo).length > 0) {
        section.json = formatJson(asobo);
    }
    return [section];
}

function meshObjectSection({ extension, object }, index) {
    const rows = [["Type", object.type ?? "?"]];
    for (const [key, value] of Object.entries(object.params ?? {})) {
        rows.push([key, formatNumber(value)]);
    }
    if (object.translation) {
        rows.push(["Translation", formatVector(object.translation)]);
    }
    if (object.rotation) {
        rows.push(["Rotation (xyzw)", formatVector(object.rotation)]);
    }
    const tags = object.extensions?.ASOBO_tags?.tags;
    if (tags?.length) {
        rows.push(["Tags", tags.join(", ")]);
    }
    const kind = extension === "ASOBO_fade_object" ? "Fade object" : "Gizmo";
    return { title: `${kind} ${index}`, rows };
}

function lightSection({ index, light }) {
    if (light === undefined) {
        return { title: `Light ${index}`, rows: [["Error", "missing in KHR_lights_punctual"]] };
    }
    const rows = [
        ["Type", light.type],
        ["Color", formatVector(light.color)],
        ["Intensity", formatNumber(light.intensity)]
    ];
    if (light.range !== undefined && light.range > 0) {
        rows.push(["Range", formatNumber(light.range)]);
    }
    if (light.type === "spot" && light.spot) {
        rows.push(["Inner cone", formatNumber(light.spot.innerConeAngle ?? 0)]);
        rows.push(["Outer cone", formatNumber(light.spot.outerConeAngle ?? Math.PI / 4)]);
    }
    return { title: `Light ${index}: ${light.name ?? light.type}`, rows };
}

/**
 * Detail sections for one node: [{title, rows?: [label, value][], json?: string}].
 */
function getNodeDetails(gltf, nodeIndex) {
    const node = gltf.nodes[nodeIndex];
    const sections = [];

    const nodeRows = [["Index", String(nodeIndex)]];
    const uniqueId = getUniqueId(node);
    if (uniqueId !== undefined) {
        nodeRows.push(["Unique id", uniqueId]);
    }
    if (node.parentNode !== undefined) {
        nodeRows.push(["Parent", nodeTitle(node.parentNode, node.parentNode.gltfObjectIndex)]);
    }
    nodeRows.push(["Children", String(node.children.length)]);
    const tags = getNodeTags(gltf, node);
    if (tags.length > 0) {
        nodeRows.push(["Tags", tags.join(", ")]);
    }
    sections.push({ title: "Node", rows: nodeRows });

    const transformRows = [];
    if (node.matrix) {
        transformRows.push(["Matrix", formatVector(node.matrix)]);
    } else {
        transformRows.push(["Translation", formatVector(node.translation)]);
        transformRows.push(["Rotation (xyzw)", formatVector(node.rotation)]);
        transformRows.push(["Rotation (° xyz)", formatVector(quaternionToEulerDegrees(node.rotation))]);
        transformRows.push(["Scale", formatVector(node.scale)]);
    }
    const world = node.getRenderedWorldTransform();
    transformRows.push(["World position", formatVector([world[12], world[13], world[14]])]);
    sections.push({ title: "Transform (local, current pose)", rows: transformRows });

    const mesh = gltf.meshes[node.mesh];
    if (mesh !== undefined) {
        sections.push({
            title: `Mesh ${node.mesh}: ${mesh.name ?? "unnamed"}`,
            rows: [["Primitives", String(mesh.primitives.length)]]
        });
        mesh.primitives.forEach((primitive, index) => {
            const rows = [["Material", primitive.material === undefined ? "default" : materialTitle(gltf, primitive.material)]];
            sections.push({ title: `Primitive ${index}`, rows: rows.concat(primitiveRows(gltf, primitive)) });
        });
        const materialIndices = [...new Set(mesh.primitives.map((p) => p.material).filter((m) => m !== undefined))];
        for (const materialIndex of materialIndices) {
            sections.push(...materialSections(gltf, materialIndex));
        }
        getMeshObjects(mesh).forEach((object, index) => sections.push(meshObjectSection(object, index)));
        sections.push(...extensionSections("Mesh", mesh.extensions, Object.keys(MsfsMeshObjectExtensions)));
    }

    const light = getNodeLight(gltf, node);
    if (light !== undefined) {
        sections.push(lightSection(light));
    }
    if (node.camera !== undefined) {
        const camera = gltf.cameras[node.camera];
        sections.push({ title: `Camera ${node.camera}`, rows: [["Name", camera?.name ?? "unnamed"], ["Type", camera?.type ?? "?"]] });
    }
    if (node.skin !== undefined) {
        const skin = gltf.skins[node.skin];
        sections.push({ title: `Skin ${node.skin}`, rows: [["Joints", String(skin?.joints?.length ?? 0)]] });
    }

    const animations = gltf.animations
        .map((animation, index) => ({ animation, index }))
        .filter(({ animation }) => animation.channels?.some((c) => c.target?.node === nodeIndex));
    if (animations.length > 0) {
        sections.push({
            title: "Animations",
            rows: animations.map(({ animation, index }) => [
                String(index),
                `${animation.name ?? "unnamed"} (${[...new Set(animation.channels.filter((c) => c.target?.node === nodeIndex).map((c) => c.target.path))].join(", ")})`
            ])
        });
    }

    sections.push(...extensionSections("Node", node.extensions, ["ASOBO_unique_id", "KHR_lights_punctual"]));
    if (node.extras !== undefined) {
        sections.push({ title: "Extras", json: formatJson(node.extras) });
    }
    return sections;
}

export {
    buildNodeTree,
    collectSubtree,
    formatNumber,
    getMsfsMaterialSummary,
    getNodeDetails,
    isPlainJson,
    materialSections,
    nodeTitle
};
