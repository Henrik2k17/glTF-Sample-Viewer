// Material debugger: lists the loaded glTF's materials with their texture slots for the
// Materials tab (editing: msfs_material_model.js / msfs_material_editor.js).

import { formatNumber } from "./inspector.js";

const FilterNames = {
    9728: "nearest",
    9729: "linear",
    9984: "nearest, mip nearest",
    9985: "linear, mip nearest",
    9986: "nearest, mip linear",
    9987: "linear, mip linear"
};
const WrapNames = { 33071: "clamp", 33648: "mirror", 10497: "repeat" };

const CoreSlots = [
    ["pbrMetallicRoughness.baseColorTexture", "Base color"],
    ["pbrMetallicRoughness.metallicRoughnessTexture", "Metallic / roughness"],
    ["normalTexture", "Normal"],
    ["occlusionTexture", "Occlusion"],
    ["emissiveTexture", "Emissive"]
];

function getPath(object, path) {
    return path.split(".").reduce((value, key) => value?.[key], object);
}

function shortExtensionName(name) {
    return name.replace(/^KHR_materials_|^ASOBO_material_|^ASOBO_/, "").replace(/_/g, " ");
}

// "detailMetalRoughAOTexture" -> "Detail metal rough AO"
function humanize(key) {
    const words = key
        .replace(/Texture$/, "")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(" ")
        .map((word) => (/^[A-Z]{2,}$/.test(word) ? word : word.toLowerCase()));
    const text = words.join(" ");
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function isTextureInfo(key, value) {
    return key.endsWith("Texture") && typeof value?.index === "number";
}

function fileName(uri) {
    if (typeof uri !== "string") {
        return undefined;
    }
    if (uri.startsWith("data:")) {
        return "data URI";
    }
    const clean = uri.split(/[?#]/)[0];
    try {
        return decodeURIComponent(clean.substring(clean.lastIndexOf("/") + 1));
    } catch {
        return clean.substring(clean.lastIndexOf("/") + 1);
    }
}

function describeTransform(transform) {
    if (transform === undefined) {
        return undefined;
    }
    const parts = [];
    if (transform.offset !== undefined) {
        parts.push(
            `offset ${formatNumber(transform.offset[0])}, ${formatNumber(transform.offset[1])}`
        );
    }
    if (transform.rotation !== undefined) {
        parts.push(`rotation ${formatNumber((transform.rotation * 180) / Math.PI)}°`);
    }
    if (transform.scale !== undefined) {
        parts.push(
            `scale ${formatNumber(transform.scale[0])}, ${formatNumber(transform.scale[1])}`
        );
    }
    return parts.join(", ");
}

/**
 * All texture slots of a material, including textures whose image failed to load and
 * extension textures the renderer does not use.
 * @returns {{slot: object, bound: object | undefined}[]} slot: plain data for the UI;
 *   bound: the renderer's textureInfo in material.textures (not for the UI, it is not reactive-safe)
 */
function getMaterialTextureSlots(gltf, materialIndex) {
    const material = gltf.materials[materialIndex];
    if (material === undefined) {
        return [];
    }
    const entries = [];
    for (const [path, label] of CoreSlots) {
        const info = getPath(material, path) ?? material.droppedTextures?.[path];
        if (info !== undefined) {
            entries.push({ path, label, info });
        }
    }
    for (const [extensionName, extension] of Object.entries(material.extensions ?? {})) {
        if (extension === null || typeof extension !== "object") {
            continue;
        }
        for (const [key, value] of Object.entries(extension)) {
            if (isTextureInfo(key, value)) {
                entries.push({
                    path: `extensions.${extensionName}.${key}`,
                    label: `${humanize(key)}`,
                    group: shortExtensionName(extensionName),
                    info: value
                });
            }
        }
    }

    return entries.map(({ path, label, group, info }) => {
        const texture = gltf.textures[info.index];
        const imageIndex = texture?.source;
        const image = gltf.images[imageIndex];
        const sampler = gltf.samplers[texture?.sampler];
        const bound = material.textures.find((t) => t === info || t.sourceJson === info);
        const loaded = image?.isLoaded() === true;
        let status = "ok";
        if (!loaded) {
            status = "missing";
        } else if (bound === undefined) {
            status = "unused";
        } else if (bound.debugDisabled) {
            status = "off";
        }
        const rows = [];
        rows.push([
            "Texture",
            `#${info.index}${imageIndex !== undefined ? `, image #${imageIndex}` : ""}`
        ]);
        if (image?.mimeType) {
            const compressed = image.image?.compressed?.format;
            const format = image.mimeType.replace(/^image\//, "");
            rows.push(["Format", compressed ? `${format} · ${compressed.replace("_", " ")}` : format]);
        }
        rows.push(["UV set", String(info.texCoord ?? 0)]);
        const transform = describeTransform(info.extensions?.KHR_texture_transform);
        if (transform) {
            rows.push(["UV transform", transform]);
        }
        if (info.scale !== undefined && path.toLowerCase().includes("normal")) {
            rows.push(["Scale", formatNumber(info.scale)]);
        }
        if (info.strength !== undefined && path.toLowerCase().includes("occlusion")) {
            rows.push(["Strength", formatNumber(info.strength)]);
        }
        rows.push([
            "Sampler",
            sampler === undefined
                ? "default"
                : `${WrapNames[sampler.wrapS] ?? "repeat"} / ${WrapNames[sampler.wrapT] ?? "repeat"}, ` +
                  `${FilterNames[sampler.minFilter] ?? "auto"}`
        ]);
        if (bound !== undefined) {
            rows.push(["Color space", bound.linear === false ? "sRGB" : "linear"]);
        }
        return {
            slot: {
                id: path,
                label,
                group,
                textureIndex: loaded ? info.index : undefined,
                file:
                    fileName(image?.uri) ??
                    (image?.bufferView !== undefined ? "embedded" : `image #${imageIndex}`),
                name: image?.name,
                width: image?.image?.width,
                height: image?.image?.height,
                status,
                rows
            },
            bound
        };
    });
}

/** What the channels of a texture slot hold, for the texture viewer's channel buttons. */
function getChannelHints(slotId) {
    if (
        /metallicRoughnessTexture$|MetalRoughAOTexture$|OcclusionRoughnessMetallicTexture$/.test(
            slotId
        )
    ) {
        // MSFS comp maps and glTF ORM textures; glTF itself only defines G and B here.
        return { r: "occlusion", g: "roughness", b: "metallic" };
    }
    if (/occlusionTexture$/i.test(slotId)) {
        return { r: "occlusion" };
    }
    if (/normalTexture$/i.test(slotId)) {
        return { r: "X", g: "Y", b: "Z" };
    }
    if (/tireDetailsTexture$/.test(slotId)) {
        return { r: "mud", g: "dust" };
    }
    if (/blendMaskTexture$/.test(slotId)) {
        return { r: "mask" };
    }
    if (/baseColorTexture$|ColorTexture$|dirtTexture$/.test(slotId)) {
        return { a: "alpha" };
    }
    return {};
}

/** Map from material index to the nodes (and their primitives) drawn with it. */
function getMaterialUsage(gltf) {
    const usage = new Map();
    gltf.nodes.forEach((node, nodeIndex) => {
        const mesh = gltf.meshes[node.mesh];
        mesh?.primitives.forEach((primitive, primitiveIndex) => {
            if (primitive.material === undefined) {
                return;
            }
            let users = usage.get(primitive.material);
            if (users === undefined) {
                users = new Map();
                usage.set(primitive.material, users);
            }
            const primitives = users.get(nodeIndex) ?? [];
            primitives.push(primitiveIndex);
            users.set(nodeIndex, primitives);
        });
    });
    return usage;
}

/**
 * Indices of the materials drawn by nodes that are not hidden with KHR_node_visibility
 * (themselves or by an ancestor).
 */
function getShownMaterials(gltf, sceneIndex) {
    const shown = new Set();
    const visit = (nodeIndex) => {
        const node = gltf.nodes[nodeIndex];
        if (node === undefined || node.extensions?.KHR_node_visibility?.visible === false) {
            return;
        }
        for (const primitive of gltf.meshes[node.mesh]?.primitives ?? []) {
            if (primitive.material !== undefined) {
                shown.add(primitive.material);
            }
        }
        node.children.forEach(visit);
    };
    (gltf.scenes[sceneIndex]?.nodes ?? []).forEach(visit);
    return shown;
}

/**
 * Rows for the material list: [{index, name, badges, missing, nodeCount, textureCount, group}]
 * @param {(material) => {key, label, order} | undefined} [groupOf] optional grouping (MSFS
 *   packages: the attachment a material comes from)
 */
function buildMaterialList(gltf, groupOf) {
    const usage = getMaterialUsage(gltf);
    // The renderer appends a default material for primitives without one; list it only if used.
    const defaultIndex = gltf.materials.length - 1;
    return gltf.materials
        .map((material, index) => ({ material, index }))
        .filter(({ index }) => index !== defaultIndex || usage.has(index))
        .map(({ material, index }) => {
            const slots = getMaterialTextureSlots(gltf, index).map(({ slot }) => slot);
            const badges = [];
            if (material.alphaMode && material.alphaMode !== "OPAQUE") {
                badges.push(material.alphaMode.toLowerCase());
            }
            if (material.extensions?.ASOBO_material_geometry_decal !== undefined) {
                badges.push("decal");
            }
            if (material.extensions?.ASOBO_material_invisible !== undefined) {
                badges.push("invisible");
            }
            const code = material.extras?.ASOBO_material_code;
            const name = material.name ?? `Material ${index}`;
            return {
                index,
                name,
                // for the filter: material name, MSFS type and texture file names
                search: [name, code ?? "", ...slots.map((slot) => slot.file)]
                    .join(" ")
                    .toLowerCase(),
                code: code === undefined ? undefined : String(code),
                badges,
                textureCount: slots.length,
                missing: slots.filter((slot) => slot.status === "missing").length,
                nodeCount: usage.get(index)?.size ?? 0,
                group: groupOf?.(material)
            };
        });
}

export {
    buildMaterialList,
    getShownMaterials,
    getChannelHints,
    getMaterialTextureSlots,
    getMaterialUsage
};
