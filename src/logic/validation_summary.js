// Validator tab: groups the glTF Validator's messages by issue, separates the ones that are
// expected or harmless for MSFS exports from real problems, and resolves JSON pointers to
// the nodes, materials and images they refer to.

const SeverityNames = ["error", "warning", "info", "hint"];

// Vertex colours a little outside 0..1 are float rounding from the exporter.
const MinorClampTolerance = 0.06;

function parseValue(message) {
    const match = /(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\.?$/i.exec(message ?? "");
    return match ? Number(match[1]) : undefined;
}

/**
 * How one message is reported: {key, label, note, harmless}. Messages with the same key are
 * one group in the list.
 */
function classify(message, compiled, gltf) {
    const code = message.code;
    const pointer = message.pointer ?? "";
    if (compiled) {
        // Compiled by the MSFS 2024 package builder (ASOBO_asset_optimized), see msfs_compiled.js
        switch (code) {
            case "MESH_PRIMITIVE_ATTRIBUTES_ACCESSOR_INVALID_FORMAT":
                return {
                    key: "compiled:vertex-format",
                    label: "Compiled vertex formats",
                    note: "Packed normals and tangents, 16 bit float UVs and colors of the MSFS compiler; the viewer decodes them.",
                    harmless: true
                };
            case "IMAGE_UNRECOGNIZED_FORMAT": {
                const image = gltf?.images[Number(/^\/images\/(\d+)/.exec(pointer)?.[1])];
                if (/\.ktx2$/i.test(image?.uri ?? "")) {
                    return {
                        key: "compiled:ktx2",
                        label: "Compiled KTX2 textures",
                        note: "Block-compressed (BC1/BC5/BC7) KTX2 from the MSFS compiler; the validator only reads Basis KTX2. The viewer uploads them directly.",
                        harmless: true
                    };
                }
                break;
            }
            case "NON_OBJECT_EXTRAS":
                return {
                    key: "compiled:extras",
                    label: "Text extras",
                    note: "The MSFS compiler marks converted images with a text extras value.",
                    harmless: true
                };
        }
    }
    switch (code) {
        case "ACCESSOR_NON_CLAMPED": {
            const value = parseValue(message.message);
            const outside = value === undefined ? Infinity : Math.max(value - 1, -value);
            if (outside <= MinorClampTolerance) {
                return {
                    key: "ACCESSOR_NON_CLAMPED:minor",
                    label: "Values slightly outside 0–1",
                    note: `Rounding from the exporter (at most ${MinorClampTolerance} outside the range); no visible effect.`,
                    harmless: true
                };
            }
            return {
                key: "ACCESSOR_NON_CLAMPED:major",
                label: "Values far outside 0–1",
                note: "Probably broken data, e.g. a corrupted vertex colour channel. Vertex alpha is the detail map mask in MSFS materials.",
                harmless: false
            };
        }
        case "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE":
            return {
                key: code,
                label: "No tangents exported",
                note: "The viewer generates them (MikkTSpace).",
                harmless: true
            };
        case "UNSUPPORTED_EXTENSION":
            if (/'ASOBO_/.test(message.message ?? "")) {
                return {
                    key: "UNSUPPORTED_EXTENSION:ASOBO",
                    label: "MSFS extensions",
                    note: "The validator does not know the ASOBO_* extensions; see the Inspector for how the viewer handles them.",
                    harmless: true
                };
            }
            break;
        case "UNUSED_OBJECT":
            if (/\/attributes\/TEXCOORD_\d+$/.test(pointer)) {
                return {
                    key: "UNUSED_OBJECT:TEXCOORD",
                    label: "UV sets no material uses",
                    note: "Extra UV sets are common in MSFS exports.",
                    harmless: true
                };
            }
            break;
        case "VALUE_NOT_IN_RANGE":
            if (/^\/materials\/\d+\/emissiveFactor\//.test(pointer)) {
                return {
                    key: "VALUE_NOT_IN_RANGE:emissive",
                    label: "Emissive factor above 1",
                    note: "The MSFS exporter writes the emissive colour times the material's emissive multiplier.",
                    harmless: true
                };
            }
            break;
        case "UNUSED_MESH_TANGENT":
            return { key: code, label: "Tangents without normal map", note: "Unused, but harmless.", harmless: true };
        case "BUFFER_VIEW_TARGET_MISSING":
            return { key: code, label: "Buffer view target not set", note: "Only a hint for loaders.", harmless: true };
        case "IO_ERROR": {
            // The viewer finds MSFS textures by file name in the model's texture folder and the
            // fallback folders of its texture.cfg, as the sim does; the validator only tries the URI.
            const imageIndex = /^[/]images[/](\d+)/.exec(pointer)?.[1];
            if (imageIndex !== undefined && gltf?.images[Number(imageIndex)]?.isLoaded?.() === true) {
                return {
                    key: "IO_ERROR:resolved",
                    label: "Textures found elsewhere",
                    note: "Not at the path in the file, but found by file name in the model's texture folder or a texture.cfg fallback folder, as in the sim.",
                    harmless: true
                };
            }
            return { key: code, label: "Files that could not be loaded", note: "Missing or unreadable files, e.g. textures.", harmless: false };
        }
    }
    return {
        key: code,
        label: code,
        note: "",
        harmless: message.severity >= 2 // infos and hints
    };
}

function nodeName(gltf, index) {
    return gltf.nodes[index]?.name ?? `Node ${index}`;
}

function fileName(uri) {
    return typeof uri === "string" ? decodeURIComponent(uri.substring(uri.lastIndexOf("/") + 1)) : undefined;
}

/**
 * Describes what a JSON pointer refers to: {text, node?, material?} where node/material is
 * an index to show in the Inspector or Materials tab.
 */
function describePointer(gltf, pointer, meshNodes) {
    if (gltf === undefined || !pointer) {
        return { text: pointer || "(file)" };
    }
    let match = /^\/meshes\/(\d+)\/primitives\/(\d+)(\/.*)?$/.exec(pointer);
    if (match) {
        const mesh = Number(match[1]);
        const primitive = gltf.meshes[mesh]?.primitives[Number(match[2])];
        const nodes = meshNodes.get(mesh) ?? [];
        const owner = nodes.length > 0 ? nodeName(gltf, nodes[0]) + (nodes.length > 1 ? ` (+${nodes.length - 1})` : "") : `Mesh ${mesh}`;
        const material = gltf.materials[primitive?.material]?.name;
        const attribute = match[3]?.replace(/^\/attributes\//, "") ?? "";
        return {
            text: `${owner} · primitive ${match[2]}${material ? ` (${material})` : ""}${attribute ? ` · ${attribute}` : ""}`,
            node: nodes[0]
        };
    }
    match = /^\/materials\/(\d+)/.exec(pointer);
    if (match) {
        const index = Number(match[1]);
        return { text: `Material ${gltf.materials[index]?.name ?? index}${pointer.slice(match[0].length)}`, material: index };
    }
    match = /^\/images\/(\d+)/.exec(pointer);
    if (match) {
        const image = gltf.images[Number(match[1])];
        return { text: `Image ${fileName(image?.uri) ?? match[1]}` };
    }
    match = /^\/nodes\/(\d+)/.exec(pointer);
    if (match) {
        return { text: `Node ${nodeName(gltf, Number(match[1]))}${pointer.slice(match[0].length)}`, node: Number(match[1]) };
    }
    return { text: pointer };
}

function formatValue(value) {
    return Math.abs(value) >= 1000 ? value.toFixed(0) : String(Math.round(value * 10000) / 10000);
}

/**
 * @returns {{problems, expected, counts: {numErrors, numWarnings, numInfos}, messageCount, truncated}}
 *   or undefined without a report. counts are affected objects (pointers) of the problems, not
 *   messages: thousands of out-of-range vertex colours of one primitive count once. problems/expected: [{key, code, severity, label, note, count,
 *   items: [{pointer, text, node, material, count, range}]}], most severe and frequent first.
 */
function summarizeValidation(report, gltf) {
    const messages = report?.issues?.messages;
    if (messages === undefined) {
        return undefined;
    }
    const meshNodes = new Map();
    gltf?.nodes.forEach((node, index) => {
        if (node.mesh !== undefined) {
            meshNodes.set(node.mesh, [...(meshNodes.get(node.mesh) ?? []), index]);
        }
    });

    const compiled = gltf?.asset?.extensions?.ASOBO_asset_optimized !== undefined;
    const groups = new Map();
    for (const message of messages) {
        const info = classify(message, compiled, gltf);
        let group = groups.get(info.key);
        if (group === undefined) {
            group = { ...info, code: message.code, severity: message.severity, count: 0, pointers: new Map() };
            groups.set(info.key, group);
        }
        group.severity = Math.min(group.severity, message.severity);
        group.count++;
        const pointer = message.pointer ?? "";
        let item = group.pointers.get(pointer);
        if (item === undefined) {
            item = { pointer, count: 0, message: message.message, min: Infinity, max: -Infinity };
            group.pointers.set(pointer, item);
        }
        item.count++;
        const value = message.code === "ACCESSOR_NON_CLAMPED" ? parseValue(message.message) : undefined;
        if (value !== undefined) {
            item.min = Math.min(item.min, value);
            item.max = Math.max(item.max, value);
        }
    }

    const result = [...groups.values()]
        .map((group) => ({
            key: group.key,
            code: group.code,
            severity: SeverityNames[group.severity] ?? "info",
            severityRank: group.severity,
            label: group.label,
            note: group.note,
            harmless: group.harmless,
            count: group.count,
            items: [...group.pointers.values()]
                .sort((a, b) => b.count - a.count)
                .map((item) => ({
                    ...describePointer(gltf, item.pointer, meshNodes),
                    pointer: item.pointer,
                    count: item.count,
                    message: item.message,
                    range: item.min <= item.max ? `${formatValue(item.min)} … ${formatValue(item.max)}` : undefined
                }))
        }))
        .sort((a, b) => a.severityRank - b.severityRank || b.count - a.count);

    const problems = result.filter((group) => !group.harmless);
    const counts = { numErrors: 0, numWarnings: 0, numInfos: 0 };
    for (const group of problems) {
        const key = ["numErrors", "numWarnings", "numInfos", "numInfos"][group.severityRank];
        counts[key] += group.items.length;
    }
    return {
        problems,
        expected: result.filter((group) => group.harmless),
        counts,
        messageCount: problems.reduce((sum, group) => sum + group.count, 0),
        truncated: report.issues.truncated === true
    };
}

export { summarizeValidation };
