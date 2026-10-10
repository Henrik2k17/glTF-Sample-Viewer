// Writing edited materials back into glTF files. Only the edited materials (and
// extensionsUsed, when it changes) are replaced in the file's text; everything else stays byte
// for byte as it was (the exporter writes e.g. 1.0, which JSON.stringify would turn into 1).

import { readMaterial, writeMaterial } from "./msfs_material_model.js";

/** Ranges [start, end) of the values of a JSON object's keys, without parsing the values. */
function objectValueSpans(text, start = text.indexOf("{")) {
    const spans = new Map();
    let i = start + 1;
    while (i < text.length) {
        i = skipWhitespace(text, i);
        if (text[i] === "}") break;
        if (text[i] === ",") {
            i++;
            continue;
        }
        const keyEnd = stringEnd(text, i);
        const key = JSON.parse(text.slice(i, keyEnd));
        i = skipWhitespace(text, keyEnd);
        i = skipWhitespace(text, i + 1); // ':'
        const valueEnd = valueEndAt(text, i);
        spans.set(key, [i, valueEnd]);
        i = valueEnd;
    }
    return spans;
}

/** Ranges [start, end) of the elements of the JSON array starting at start. */
function arrayElementSpans(text, start) {
    const spans = [];
    let i = start + 1;
    while (i < text.length) {
        i = skipWhitespace(text, i);
        if (text[i] === "]") break;
        if (text[i] === ",") {
            i++;
            continue;
        }
        const end = valueEndAt(text, i);
        spans.push([i, end]);
        i = end;
    }
    return spans;
}

function skipWhitespace(text, i) {
    while (i < text.length && /\s/.test(text[i])) i++;
    return i;
}

function stringEnd(text, i) {
    for (let j = i + 1; j < text.length; j++) {
        if (text[j] === "\\") j++;
        else if (text[j] === '"') return j + 1;
    }
    throw new Error("Unterminated string in JSON");
}

function valueEndAt(text, i) {
    const c = text[i];
    if (c === '"') return stringEnd(text, i);
    if (c === "{" || c === "[") {
        let depth = 0;
        for (let j = i; j < text.length; j++) {
            const d = text[j];
            if (d === '"') {
                j = stringEnd(text, j) - 1;
            } else if (d === "{" || d === "[") {
                depth++;
            } else if (d === "}" || d === "]") {
                depth--;
                if (depth === 0) return j + 1;
            }
        }
        throw new Error("Unbalanced JSON");
    }
    let j = i;
    while (j < text.length && !/[,}\]\s]/.test(text[j])) j++;
    return j;
}

// Extensions only materials use: listed in extensionsUsed exactly while a material uses them
const MaterialOnlyExtensions = [
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
    "ASOBO_material_rain_options"
];

/**
 * The file's text with some materials replaced.
 * @param {string} text the .gltf file
 * @param {Map<number, object>} materials material index -> new material JSON
 * @returns {{ text: string, extensionsUsed: string[] | undefined }} the new text; the new
 *   extensionsUsed if it changed
 */
function replaceMaterialsInText(text, materials) {
    const json = JSON.parse(text);
    for (const [index, material] of materials) {
        if (json.materials?.[index] === undefined) {
            throw new Error(`The file has no material ${index}`);
        }
        json.materials[index] = material;
    }
    // extensionsUsed: material extensions in use now; the others as they were
    const used = new Set();
    for (const material of json.materials ?? []) {
        Object.keys(material.extensions ?? {}).forEach((name) => used.add(name));
    }
    const before = json.extensionsUsed ?? [];
    const after = before.filter((name) => !MaterialOnlyExtensions.includes(name) || used.has(name));
    for (const name of used) {
        if (!after.includes(name)) after.push(name);
    }
    const extensionsChanged = JSON.stringify(before) !== JSON.stringify(after);

    // splice: edited materials and extensionsUsed, from the end so earlier offsets stay valid
    const top = objectValueSpans(text);
    const edits = [];
    const materialsSpan = top.get("materials");
    const elements = arrayElementSpans(text, materialsSpan[0]);
    for (const [index, material] of materials) {
        edits.push([...elements[index], JSON.stringify(material)]);
    }
    if (extensionsChanged) {
        if (top.has("extensionsUsed")) {
            edits.push([...top.get("extensionsUsed"), JSON.stringify(after)]);
        } else {
            const at = text.indexOf("{") + 1;
            edits.push([at, at, `"extensionsUsed":${JSON.stringify(after)},`]);
        }
    }
    edits.sort((a, b) => b[0] - a[0]);
    let result = text;
    for (const [start, end, replacement] of edits) {
        result = result.slice(0, start) + replacement + result.slice(end);
    }
    JSON.parse(result); // still valid
    return { text: result, extensionsUsed: extensionsChanged ? after : undefined };
}

/**
 * The material as it should be saved into its source file: the source file's material with
 * the edited parameters, type and texture slots applied (diff based, so everything the user
 * did not touch stays as it is in the file, e.g. no livery tint of a package).
 * @param {object} sourceJson the material in the source file
 * @param {object} model the edited model (readMaterial of the loaded material, then edited)
 * @param {Set<string>} changed edited keys: parameter names, "type", "texture:<slot>"
 * @param {(index: number) => number | undefined} toSourceTexture loaded texture index -> the
 *   source file's (undefined: the texture is not in that file)
 */
function materialForSource(sourceJson, model, changed, toSourceTexture) {
    const source = readMaterial(sourceJson);
    for (const key of changed) {
        if (key === "type") {
            source.type = model.type;
        } else if (key.startsWith("texture:")) {
            const slot = key.substring("texture:".length);
            const info = model.textures[slot];
            if (info === undefined) {
                delete source.textures[slot];
            } else {
                const index = toSourceTexture(info.index);
                if (index === undefined) {
                    throw new Error(`The texture in slot ${slot} is not part of the material's file`);
                }
                source.textures[slot] = { ...structuredClone(info), index };
            }
        } else {
            source.params[key] = structuredClone(model.params[key]);
        }
    }
    return writeMaterial(source);
}

/** Starts a download of a text file. */
function downloadText(fileName, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "model/gltf+json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Writes files below a directory (File System Access API); each overwritten file is copied to
 * "<name>.bak" first. Paths are relative to the directory, "/" separated, matched without case.
 * @returns {Promise<string[]>} the written paths
 */
async function writeFilesToDirectory(directory, files) {
    const written = [];
    for (const { path, text } of files) {
        const parts = path.split("/").filter((part) => part !== "");
        let folder = directory;
        for (const part of parts.slice(0, -1)) {
            folder = await childHandle(folder, part, "directory");
        }
        const name = parts[parts.length - 1];
        const file = await childHandle(folder, name, "file");
        const backup = await folder.getFileHandle(`${file.name}.bak`, { create: true });
        await writeHandle(backup, await (await file.getFile()).text());
        await writeHandle(file, text);
        written.push(path);
    }
    return written;
}

async function childHandle(folder, name, kind) {
    for await (const [entryName, handle] of folder.entries()) {
        if (handle.kind === kind && entryName.toLowerCase() === name.toLowerCase()) {
            return handle;
        }
    }
    throw new Error(`${name} not found in the chosen folder (${folder.name})`);
}

async function writeHandle(handle, text) {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
}

export { replaceMaterialsInText, materialForSource, downloadText, writeFilesToDirectory, objectValueSpans, arrayElementSpans };
