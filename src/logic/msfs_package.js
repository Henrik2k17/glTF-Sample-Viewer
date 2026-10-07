// MSFS 2024 modular SimObject packages: a preset (presets/<author>/<name>/config/attached_objects.cfg)
// lists sim_attachments (an attachment folder with a model XML, attached to a node of the
// exterior or interior model) and merge_models (glTFs merged into a model, e.g. the attach point
// nodes). Attachments list further attachments in their own config/attached_objects.cfg, and
// attachment.cfg can [inherit] those of another attachment. The base exterior/interior models
// come from common/model/model.cfg.
//
// The viewer loads LOD 0 of every model and merges all glTFs into one, so that the Inspector,
// Materials and Animations tabs work on the whole SimObject. Every attachment gets a wrapper node
// (KHR_node_visibility, to toggle it) under its attach_to_node.

const VirtualPrefix = "/__msfs_package__/";

/** Normalizes a package path: forward slashes, no "." or ".." segments, no leading slash. */
function normalizePath(path) {
    const parts = [];
    for (const part of path.replace(/\\/g, "/").split("/")) {
        if (part === "" || part === ".") {
            continue;
        }
        if (part === "..") {
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    return parts.join("/");
}

const folderOf = (path) => path.substring(0, path.lastIndexOf("/") + 1);
const baseName = (path) => path.substring(path.lastIndexOf("/") + 1);
const joinPath = (folder, relative) => normalizePath(folder + "/" + relative);

/** The files of one package, looked up case-insensitively like the sim does. */
class PackageFiles {
    /**
     * @param {string[]} paths all file paths relative to the package root
     * @param {(path: string) => string} urlFor absolute URL of a file
     * @param {string} label shown in the UI
     */
    constructor(paths, urlFor, label) {
        this.paths = new Map(paths.map((path) => [normalizePath(path).toLowerCase(), normalizePath(path)]));
        this.urlFor = urlFor;
        this.label = label;
    }

    /** @returns {string|undefined} the path as stored in the package */
    resolve(path) {
        return this.paths.get(normalizePath(path).toLowerCase());
    }

    has(path) {
        return this.resolve(path) !== undefined;
    }

    /** True if a folder contains files. */
    hasFolder(path) {
        if (this.folders === undefined) {
            this.folders = new Set();
            for (const key of this.paths.keys()) {
                for (let end = key.indexOf("/"); end >= 0; end = key.indexOf("/", end + 1)) {
                    this.folders.add(key.substring(0, end));
                }
            }
        }
        return this.folders.has(normalizePath(path).toLowerCase());
    }

    url(path) {
        return this.urlFor(this.resolve(path) ?? normalizePath(path));
    }

    async text(path) {
        const response = await fetch(this.url(path));
        if (!response.ok) {
            throw new Error(`${path}: ${response.status} ${response.statusText}`);
        }
        return await response.text();
    }

    /** Paths below a folder ("" for all). */
    list(folder = "") {
        const prefix = normalizePath(folder).toLowerCase();
        return [...this.paths.entries()]
            .filter(([key]) => prefix === "" || key.startsWith(prefix + "/"))
            .map(([, path]) => path);
    }

    /**
     * A package served over HTTP. Built packages list all their files in layout.json.
     * @param {string} url the package root (the folder with layout.json) or layout.json itself
     */
    static async fromUrl(url) {
        const base = new URL(url.replace(/layout\.json$/i, "").replace(/\/?$/, "/"), location.href);
        const response = await fetch(new URL("layout.json", base));
        if (!response.ok) {
            throw new Error(
                `No layout.json in ${base.href}. Use the root of a built package (the folder with layout.json and manifest.json).`
            );
        }
        const layout = await response.json();
        const paths = (layout.content ?? []).map((entry) => entry.path);
        const label = base.pathname.split("/").filter((part) => part !== "").pop() ?? base.href;
        return [new PackageFiles(paths, (path) => new URL(encodePath(path), base).href, label)];
    }

    /**
     * Packages in local files (a picked or dropped folder). A folder can hold several packages
     * (e.g. Packages/ and PackageSources/ of an SDK project): every folder that contains a
     * SimObjects folder is one. The files are served to fetch() under a virtual URL.
     * @param {Array<[string, File]>} entries paths relative to the picked folder
     * @param {string} label
     */
    static async fromFiles(entries, label) {
        entries = entries.map(([path, file]) => [normalizePath(path), file]);
        const roots = new Map(); // root prefix -> [relative path, File][]
        const addFile = (root, relativePath, file) => {
            if (!roots.has(root)) {
                roots.set(root, []);
            }
            roots.get(root).push([relativePath, file]);
        };
        for (const [path, file] of entries) {
            const match = /(^|\/)simobjects\//i.exec(path);
            if (match !== null) {
                const root = path.substring(0, match.index + match[1].length);
                addFile(root, path.substring(root.length), file);
            }
        }
        // A folder inside a package (the SimObjects folder, a category, a SimObject): the
        // SimObject is the folder with presets/; its package path comes from the configs.
        if (roots.size === 0) {
            for (const [simObject, inside] of await findSimObjectFolders(entries, label)) {
                for (const [path, file] of entries) {
                    if (path.toLowerCase().startsWith(simObject.toLowerCase())) {
                        addFile("", inside + path.substring(simObject.length), file);
                    }
                }
            }
        }
        return [...roots.entries()].map(([root, files]) => {
            const id = registerVirtualFiles(files);
            const base = `${location.origin}${VirtualPrefix}${id}/`;
            return new PackageFiles(
                files.map(([path]) => path),
                (path) => base + encodePath(path),
                (label + "/" + root).replace(/\/$/, "")
            );
        });
    }
}

const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

/**
 * SimObject folders (those with presets/.../config/attached_objects.cfg) among files picked
 * below a package root, with the package path they have: SimObjects/<category>/<name>/, read
 * from the preset's attachment paths (e.g. attachment_root = "SimObjects/Airplanes/DA62_SDK/...").
 * @returns {Promise<Array<[string, string]>>} [folder in the picked files, package path]
 */
async function findSimObjectFolders(entries, label) {
    const found = new Map();
    for (const [path, file] of entries) {
        const match = /(^|\/)presets\/.+\/config\/attached_objects\.cfg$/i.exec(path);
        if (match === null) {
            continue;
        }
        const folder = path.substring(0, match.index + match[1].length);
        if (found.has(folder.toLowerCase())) {
            continue;
        }
        const segments = folder.split("/").filter((segment) => segment !== "");
        const name = segments.at(-1) ?? label;
        let category = segments.at(-2);
        try {
            const blob = typeof file.getFile === "function" ? await file.getFile() : file;
            const text = await blob.text();
            for (const reference of text.matchAll(/simobjects[\\/]+([^\\/"]+)[\\/]+([^\\/"]+)/gi)) {
                if (reference[2].toLowerCase() === name.toLowerCase()) {
                    category = reference[1];
                    break;
                }
            }
        } catch {
            // keep the folder's parent as the category
        }
        found.set(folder.toLowerCase(), [folder, `SimObjects/${category ?? "Airplanes"}/${name}/`]);
    }
    return [...found.values()];
}

// Virtual files: fetch() of <origin>/__msfs_package__/<id>/<path> is answered from local files,
// so the renderer can resolve relative URIs (buffers, textures, texture.cfg fallbacks) as usual.
const virtualFiles = new Map(); // id -> Map(lower case path -> File)
let nextVirtualId = 1;

function registerVirtualFiles(files) {
    installFetchShim();
    const id = String(nextVirtualId++);
    virtualFiles.set(id, new Map(files.map(([path, file]) => [path.toLowerCase(), file])));
    return id;
}

/** Forgets earlier local packages (their File objects). */
function releaseVirtualFiles() {
    virtualFiles.clear();
}

let fetchShimInstalled = false;
function installFetchShim() {
    if (fetchShimInstalled) {
        return;
    }
    fetchShimInstalled = true;
    const originalFetch = globalThis.fetch.bind(globalThis);
    const prefix = location.origin + VirtualPrefix;
    globalThis.fetch = (input, init) => {
        const url = typeof input === "string" ? input : (input?.url ?? String(input));
        if (!url.startsWith(prefix)) {
            return originalFetch(input, init);
        }
        const rest = new URL(url).pathname.substring(VirtualPrefix.length);
        const id = rest.substring(0, rest.indexOf("/"));
        const path = normalizePath(decodeURIComponent(rest.substring(id.length + 1))).toLowerCase();
        const entry = virtualFiles.get(id)?.get(path);
        if (entry === undefined) {
            return Promise.resolve(new Response(null, { status: 404, statusText: "Not Found" }));
        }
        // a File, or a FileSystemFileHandle of a picked folder (read on demand)
        const file = typeof entry.getFile === "function" ? entry.getFile() : Promise.resolve(entry);
        return file.then(
            (contents) => new Response(contents, { status: 200 }),
            () => new Response(null, { status: 404, statusText: "Not Found" })
        );
    };
}

/**
 * Lists a picked folder (File System Access API) as [relative path, FileSystemFileHandle].
 * Version control and build cache folders are skipped.
 */
const ProbedCfgNames = ["attached_objects.cfg", "aircraft.cfg", "model.cfg", "attachment.cfg", "texture.cfg"];

async function scanDirectory(directory, onProgress) {
    // Each folder is listed completely before its subfolders are (no listing is held open
    // while another one runs), and a folder that can't be listed doesn't end the scan.
    const entries = [];
    const failed = [];
    const queue = [[directory, ""]];
    const visited = [];
    let folders = 0;
    while (queue.length > 0) {
        const [folder, prefix] = queue.shift();
        visited.push([folder, prefix]);
        const listing = [];
        try {
            for await (const handle of folder.values()) {
                listing.push(handle);
            }
        } catch (error) {
            failed.push(`${prefix || "./"}: ${error?.name ?? "Error"} ${error?.message ?? ""}`);
        }
        folders++;
        for (const handle of listing) {
            if (handle.kind === "directory") {
                if (!/^(\.git|\.svn|node_modules|_temp)$/i.test(handle.name)) {
                    queue.push([handle, prefix + handle.name + "/"]);
                }
            } else {
                entries.push([prefix + handle.name, handle]);
            }
        }
        onProgress?.(entries.length);
    }
    // Chrome and Edge leave .cfg files out of picked folders' listings (seen with the MSFS SDK
    // samples). Ask for the config files the package reader needs by name instead.
    entries.cfgHidden = false;
    if (!entries.some(([path]) => /\.cfg$/i.test(path)) && visited.length > 1) {
        entries.cfgHidden = true;
        let probed = 0;
        for (const [folder, prefix] of visited) {
            for (const name of ProbedCfgNames) {
                try {
                    entries.push([prefix + name, await folder.getFileHandle(name)]);
                    probed++;
                } catch {
                    // not there, or refused as well
                }
            }
        }
        entries.cfgProbed = probed;
        console.info(`Package folder scan: no .cfg files listed; ${probed} found by name`);
    }
    console.info(`Package folder scan: ${entries.length} files in ${folders} folders`, failed);
    entries.failedFolders = failed;
    return entries;
}

/**
 * Parses an MSFS .cfg file.
 * @returns {Map<string, Map<string, string>>} lower case section -> lower case key -> value
 */
function parseCfg(text) {
    const sections = new Map();
    let section = new Map();
    sections.set("", section);
    for (const rawLine of text.split(/\r?\n/)) {
        const line = stripCfgComment(rawLine).trim();
        if (line === "") {
            continue;
        }
        const header = /^\[(.+)\]$/.exec(line);
        if (header !== null) {
            section = new Map();
            sections.set(header[1].trim().toLowerCase(), section);
            continue;
        }
        const equals = line.indexOf("=");
        if (equals < 0) {
            continue;
        }
        const key = line.substring(0, equals).trim().toLowerCase();
        let value = line.substring(equals + 1).trim();
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
            value = value.substring(1, value.length - 1);
        }
        section.set(key, value);
    }
    return sections;
}

/** Removes a ";" comment outside of quotes. */
function stripCfgComment(line) {
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') {
            quoted = !quoted;
        } else if (line[i] === ";" && !quoted) {
            return line.substring(0, i);
        }
    }
    return line;
}

/** Numbered sections "<name>.<n>" in order of n. */
function numberedSections(cfg, name) {
    return [...cfg.entries()]
        .map(([key, values]) => [new RegExp(`^${name}\\.(\\d+)$`).exec(key), values])
        .filter(([match]) => match !== null)
        .sort(([a], [b]) => Number(a[1]) - Number(b[1]))
        .map(([, values]) => values);
}

async function readCfg(files, path) {
    if (!files.has(path)) {
        return undefined;
    }
    return parseCfg(await files.text(path));
}

/** All presets of all SimObjects in the packages. */
async function findPresets(packages) {
    const presets = [];
    for (const files of packages) {
        for (const path of files.list()) {
            const match = /^(simobjects\/[^/]+\/[^/]+)\/presets\/(.+)\/config\/attached_objects\.cfg$/i.exec(path);
            if (match === null) {
                continue;
            }
            const simObject = path.substring(0, match[1].length);
            const presetFolder = path.substring(0, path.length - "config/attached_objects.cfg".length);
            let title = baseName(match[2]);
            try {
                const aircraft = await readCfg(files, presetFolder + "config/aircraft.cfg");
                const fltsim = aircraft?.get("fltsim.0");
                // title is unique per preset; ui_variation is not (e.g. "Standard")
                title = fltsim?.get("title") || fltsim?.get("ui_variation") || title;
            } catch {
                // keep the folder name
            }
            presets.push({
                id: `${files.label}|${presetFolder}`,
                files,
                simObject,
                folder: presetFolder,
                name: baseName(match[2]),
                title,
                group: `${files.label} › ${baseName(simObject)}`
            });
        }
    }
    return presets.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

const elementsByName = (parent, name) =>
    [...parent.children].filter((element) => element.localName.toLowerCase() === name);

/**
 * The glTFs of LOD 0 of a model XML (<LODS Template="..."> plus the LOD's ModelFile and
 * MergeModel entries). Paths relative to the package root.
 */
async function readModelXml(files, xmlPath, depth = 0) {
    if (!files.has(xmlPath)) {
        throw new Error(`model file ${xmlPath} not found`);
    }
    const doc = new DOMParser().parseFromString(await files.text(xmlPath), "text/xml");
    if (doc.querySelector("parsererror") !== null) {
        throw new Error(`${xmlPath} is not valid XML`);
    }
    const folder = folderOf(xmlPath);
    const lods = elementsByName(doc.documentElement, "lods")[0];
    if (lods === undefined) {
        return [];
    }
    const gltfs = [];
    const template = lods.getAttribute("Template") ?? lods.getAttribute("template");
    if (template && depth < 8) {
        gltfs.push(...(await readModelXml(files, joinPath(folder, template), depth + 1)));
    }
    const lodElements = elementsByName(lods, "lod");
    const first =
        lodElements.find((lod) => (lod.getAttribute("Index") ?? lod.getAttribute("index")) === "0") ??
        lodElements[0];
    if (first !== undefined) {
        const modelFile = first.getAttribute("ModelFile") ?? first.getAttribute("modelfile");
        if (modelFile) {
            gltfs.push(joinPath(folder, modelFile));
        }
        for (const merge of elementsByName(first, "mergemodel")) {
            gltfs.push(joinPath(folder, merge.textContent.trim()));
        }
    }
    return gltfs;
}

const parseVector = (value, fallback) => {
    const numbers = (value ?? "").split(",").map((part) => Number(part.trim()));
    return numbers.length === 3 && numbers.every(Number.isFinite) ? numbers : fallback;
};

/**
 * Builds the attachment tree of a preset.
 * @returns {Promise<{items: object[], models: Map<string, object>}>} items: tree of
 *   { id, kind: "model"|"merge"|"attachment", name, model, node, gltfs, children, problems, ... }
 */
async function buildPresetTree(preset) {
    const files = preset.files;
    let nextId = 0;
    const items = [];

    // Base models (common/model/model.cfg [models] exterior = exterior.xml)
    const modelFolder = preset.simObject + "/common/model/";
    const modelCfg = await readCfg(files, modelFolder + "model.cfg").catch(() => undefined);
    const modelEntries = [...(modelCfg?.get("models") ?? new Map()).entries()];
    for (const [model, xml] of modelEntries) {
        const item = {
            id: `i${nextId++}`,
            kind: "model",
            name: model.charAt(0).toUpperCase() + model.substring(1),
            model,
            gltfs: [],
            children: [],
            problems: [],
            path: modelFolder + xml
        };
        try {
            item.gltfs = await readModelXml(files, modelFolder + xml);
        } catch (error) {
            item.problems.push(error.message);
        }
        items.push(item);
    }

    // attached_objects.cfg of the preset, then recursively of every attachment
    const readAttachedObjects = async (cfgPaths, stack) => {
        const children = [];
        for (const cfgPath of cfgPaths) {
            const cfg = await readCfg(files, cfgPath).catch(() => undefined);
            if (cfg === undefined) {
                continue;
            }
            for (const merge of numberedSections(cfg, "merge_model")) {
                const file = normalizePath(merge.get("merge_file") ?? "");
                children.push({
                    id: `i${nextId++}`,
                    kind: "merge",
                    name: baseName(file).replace(/\.gltf$/i, ""),
                    model: (merge.get("merge_to_model") ?? "exterior").toLowerCase(),
                    gltfs: file ? [file] : [],
                    children: [],
                    problems: [],
                    path: file,
                    source: cfgPath
                });
            }
            for (const attachment of numberedSections(cfg, "sim_attachment")) {
                children.push(await readAttachment(attachment, cfgPath, stack));
            }
        }
        return children;
    };

    const readAttachment = async (values, cfgPath, stack) => {
        const root = normalizePath(values.get("attachment_root") ?? "");
        const item = {
            id: `i${nextId++}`,
            kind: "attachment",
            name:
                values.get("alias") ||
                baseName(root) ||
                baseName(normalizePath(values.get("attachment") ?? "")).replace(/\.xml$/i, "") ||
                "attachment",
            model: (values.get("attach_to_model") ?? "exterior").toLowerCase(),
            node: values.get("attach_to_node") || undefined,
            offset: parseVector(values.get("attach_offset"), [0, 0, 0]),
            pbh: parseVector(values.get("attach_pbh"), [0, 0, 0]),
            scale: Number(values.get("attach_scale") ?? 1) || 1,
            texture: values.get("texture") || undefined,
            root,
            gltfs: [],
            children: [],
            problems: [],
            tags: [],
            source: cfgPath
        };
        if (values.get("attach_to_reference_point")) {
            item.problems.push("attach_to_reference_point is not supported");
        }
        let xml = undefined;
        if (root && values.get("attachment_file")) {
            xml = joinPath(root, values.get("attachment_file"));
        } else if (values.get("attachment")) {
            xml = normalizePath(values.get("attachment"));
        }
        // Shared sim content (SimAttachments/...) ships with the sim, not with the package
        item.external = xml !== undefined && !files.has(xml) && /^simattachments\//i.test(xml);
        item.path = xml ?? root;
        if (xml !== undefined) {
            if (item.external) {
                item.note = "Sim content (SimAttachments), not part of this package";
            } else {
                try {
                    item.gltfs = await readModelXml(files, xml);
                } catch (error) {
                    item.problems.push(error.message);
                }
            }
        }
        if (root && !item.external) {
            if (stack.includes(root.toLowerCase())) {
                item.problems.push("attaches itself (cycle), children skipped");
                return item;
            }
            // attachment.cfg: tags, and [inherit] base = another attachment whose attached objects apply too
            const cfgPaths = [root + "/config/attached_objects.cfg"];
            const attachmentCfg = await readCfg(files, root + "/attachment.cfg").catch(() => undefined);
            for (const [key, value] of attachmentCfg?.get("tags") ?? []) {
                if (key.startsWith("tag")) {
                    item.tags.push(value);
                }
            }
            const base = attachmentCfg?.get("inherit")?.get("base");
            if (base) {
                item.inherits = normalizePath(base);
                cfgPaths.unshift(normalizePath(base) + "/config/attached_objects.cfg");
            }
            item.children = await readAttachedObjects(cfgPaths, [...stack, root.toLowerCase()]);
        }
        return item;
    };

    items.push(...(await readAttachedObjects([preset.folder + "config/attached_objects.cfg"], [])));
    return items;
}

// ---------------------------------------------------------------------------------------------
// Merging glTFs

const TopLevelArrays = [
    "accessors",
    "animations",
    "buffers",
    "bufferViews",
    "cameras",
    "images",
    "materials",
    "meshes",
    "nodes",
    "samplers",
    "skins",
    "textures"
];

const PointerArrays = new Set(TopLevelArrays);

// Images, textures and samplers that are equal are shared between the merged glTFs (many parts
// use the same textures); everything else is appended with an index offset.
const SharedArrays = new Set(["images", "samplers", "textures"]);

/** Index offsets of everything a glTF appends to the merged one. */
function offsetsOf(merged) {
    const offsets = {};
    for (const key of TopLevelArrays) {
        offsets[key] = merged[key].length;
    }
    offsets.lights = merged.extensions.KHR_lights_punctual.lights.length;
    offsets.variants = merged.extensions.KHR_materials_variants.variants.length;
    return offsets;
}

/** Remaps "/nodes/3/translation" style pointers (KHR_animation_pointer, ASOBO_property_animation). */
function remapPointer(pointer, mapIndex, o) {
    if (typeof pointer !== "string") {
        return pointer;
    }
    return pointer
        .replace(/^(\/?)([A-Za-z]+)\/(\d+)/, (match, slash, array, index) =>
            PointerArrays.has(array) ? `${slash}${array}/${mapIndex(array, Number(index))}` : match
        )
        .replace(/^(\/?extensions\/KHR_lights_punctual\/lights\/)(\d+)/, (match, head, index) => head + (Number(index) + o.lights));
}

/** Remaps every texture info ({ index, texCoord, ... }) inside a material. */
function remapTextureInfos(value, textureMap, isRoot = true) {
    if (Array.isArray(value)) {
        value.forEach((entry) => remapTextureInfos(entry, textureMap, false));
    } else if (value !== null && typeof value === "object") {
        if (!isRoot && typeof value.index === "number") {
            value.index = textureMap[value.index];
        }
        for (const [key, child] of Object.entries(value)) {
            if (key !== "extras") {
                remapTextureInfos(child, textureMap, false);
            }
        }
    }
}

/** Appends an entry unless an equal one (same key) was appended before. */
function shareEntry(merged, shared, array, key, value) {
    const registry = (shared[array] ??= new Map());
    if (key !== undefined && registry.has(key)) {
        return registry.get(key);
    }
    merged[array].push(value);
    const index = merged[array].length - 1;
    if (key !== undefined) {
        registry.set(key, index);
    }
    return index;
}

/**
 * Appends a glTF JSON to the merged glTF.
 * @param {object} merged
 * @param {object} json the glTF (modified)
 * @param {object} options sourcePath: absolute URL of the file; textureFolders: texture folders
 *   relative to it, for images that were not resolved; resolvedImages: per image
 *   { key, sourcePath, uri } of the file found in the package, or undefined; shared: registries
 *   of shared entries
 * @returns {number[]} the merged indices of the glTF's scene root nodes
 */
function appendGltf(merged, json, { sourcePath, textureFolders, resolvedImages, shared }) {
    const o = offsetsOf(merged);
    const add = (index, key) => (typeof index === "number" ? index + o[key] : index);
    const compiled = json.asset?.extensions?.ASOBO_asset_optimized !== undefined;
    const convention = json.asset?.extensions?.ASOBO_normal_map_convention?.tangent_space_convention;

    const samplerMap = (json.samplers ?? []).map((sampler) =>
        shareEntry(merged, shared, "samplers", JSON.stringify({ ...sampler, name: undefined }), sampler)
    );
    const imageMap = (json.images ?? []).map((image, index) => {
        const resolved = resolvedImages?.[index];
        if (resolved !== undefined) {
            image.uri = resolved.uri;
            image.extras = { ...image.extras, sourcePath: resolved.sourcePath };
            return shareEntry(merged, shared, "images", `${resolved.key}|${image.mimeType ?? ""}`, image);
        }
        image.bufferView = add(image.bufferView, "bufferViews");
        image.extras = { ...image.extras, sourcePath, ...(textureFolders ? { textureFolders } : {}) };
        // Not in the package (e.g. the sim's shared materials): every copy would end in the same
        // lookup by file name (texture folders), so one is enough.
        const name = typeof image.uri === "string" && !image.uri.startsWith("data:")
            ? image.uri.replace(/\\/g, "/").split("/").pop().toLowerCase()
            : undefined;
        return shareEntry(merged, shared, "images", name && `unresolved|${name}|${image.mimeType ?? ""}`, image);
    });
    const textureMap = (json.textures ?? []).map((texture) => {
        if (typeof texture.source === "number") {
            texture.source = imageMap[texture.source];
        }
        if (typeof texture.sampler === "number") {
            texture.sampler = samplerMap[texture.sampler];
        }
        for (const extension of Object.values(texture.extensions ?? {})) {
            if (typeof extension?.source === "number") {
                extension.source = imageMap[extension.source];
            }
        }
        const key = JSON.stringify({ source: texture.source, sampler: texture.sampler, extensions: texture.extensions });
        return shareEntry(merged, shared, "textures", key, texture);
    });
    const maps = { images: imageMap, samplers: samplerMap, textures: textureMap };
    const mapIndex = (array, index) => (SharedArrays.has(array) ? maps[array][index] : index + o[array]);

    for (const accessor of json.accessors ?? []) {
        accessor.bufferView = add(accessor.bufferView, "bufferViews");
        if (accessor.sparse !== undefined) {
            accessor.sparse.indices.bufferView = add(accessor.sparse.indices.bufferView, "bufferViews");
            accessor.sparse.values.bufferView = add(accessor.sparse.values.bufferView, "bufferViews");
        }
    }
    for (const bufferView of json.bufferViews ?? []) {
        bufferView.buffer = add(bufferView.buffer, "buffers");
        for (const name of ["EXT_meshopt_compression", "KHR_meshopt_compression"]) {
            const extension = bufferView.extensions?.[name];
            if (extension !== undefined) {
                extension.buffer = add(extension.buffer, "buffers");
            }
        }
    }
    for (const buffer of json.buffers ?? []) {
        buffer.extras = { ...buffer.extras, sourcePath };
    }
    for (const material of json.materials ?? []) {
        remapTextureInfos(material, textureMap);
        if (convention !== undefined) {
            material.extras = { ...material.extras, tangentSpaceConvention: convention };
        }
    }
    for (const mesh of json.meshes ?? []) {
        if (compiled) {
            mesh.extras = { ...mesh.extras, msfsCompiled: true };
        }
        for (const primitive of mesh.primitives ?? []) {
            for (const name of Object.keys(primitive.attributes ?? {})) {
                primitive.attributes[name] += o.accessors;
            }
            primitive.indices = add(primitive.indices, "accessors");
            primitive.material = add(primitive.material, "materials");
            for (const target of primitive.targets ?? []) {
                for (const name of Object.keys(target)) {
                    target[name] += o.accessors;
                }
            }
            const draco = primitive.extensions?.KHR_draco_mesh_compression;
            if (draco !== undefined) {
                draco.bufferView += o.bufferViews;
            }
            for (const mapping of primitive.extensions?.KHR_materials_variants?.mappings ?? []) {
                mapping.material += o.materials;
                mapping.variants = mapping.variants.map((variant) => variant + o.variants);
            }
        }
    }
    for (const node of json.nodes ?? []) {
        node.children = node.children?.map((child) => child + o.nodes);
        node.mesh = add(node.mesh, "meshes");
        node.skin = add(node.skin, "skins");
        node.camera = add(node.camera, "cameras");
        const light = node.extensions?.KHR_lights_punctual;
        if (typeof light?.light === "number") {
            light.light += o.lights;
        }
        const instancing = node.extensions?.EXT_mesh_gpu_instancing?.attributes;
        for (const name of Object.keys(instancing ?? {})) {
            instancing[name] += o.accessors;
        }
    }
    for (const skin of json.skins ?? []) {
        skin.inverseBindMatrices = add(skin.inverseBindMatrices, "accessors");
        skin.skeleton = add(skin.skeleton, "nodes");
        skin.joints = skin.joints?.map((joint) => joint + o.nodes);
    }
    for (const animation of json.animations ?? []) {
        for (const sampler of animation.samplers ?? []) {
            sampler.input += o.accessors;
            sampler.output += o.accessors;
        }
        for (const channel of animation.channels ?? []) {
            if (channel.target?.node !== undefined) {
                channel.target.node += o.nodes;
            }
            const pointer = channel.target?.extensions?.KHR_animation_pointer;
            if (pointer !== undefined) {
                pointer.pointer = remapPointer(pointer.pointer, mapIndex, o);
            }
        }
        for (const channel of animation.extensions?.ASOBO_property_animation?.channels ?? []) {
            channel.target = remapPointer(channel.target, mapIndex, o);
        }
    }

    for (const key of TopLevelArrays) {
        if (!SharedArrays.has(key)) {
            merged[key].push(...(json[key] ?? []));
        }
    }
    merged.extensions.KHR_lights_punctual.lights.push(...(json.extensions?.KHR_lights_punctual?.lights ?? []));
    merged.extensions.KHR_materials_variants.variants.push(
        ...(json.extensions?.KHR_materials_variants?.variants ?? [])
    );
    for (const name of json.extensionsUsed ?? []) {
        if (!merged.extensionsUsed.includes(name)) {
            merged.extensionsUsed.push(name);
        }
    }
    for (const name of json.extensionsRequired ?? []) {
        if (!merged.extensionsRequired.includes(name)) {
            merged.extensionsRequired.push(name);
        }
    }

    const scene = json.scenes?.[json.scene ?? 0];
    if (scene !== undefined) {
        return (scene.nodes ?? []).map((node) => node + o.nodes);
    }
    // no scene: all nodes that are nobody's child
    const children = new Set((json.nodes ?? []).flatMap((node) => node.children ?? []));
    return (json.nodes ?? []).map((_, index) => index).filter((index) => !children.has(index)).map((index) => index + o.nodes);
}

/** Quaternion of MSFS pitch/bank/heading in degrees (heading about Y, pitch about X, bank about Z). */
function pbhToQuaternion([pitch, bank, heading]) {
    const toHalfRad = Math.PI / 360;
    const [hx, hy, hz] = [pitch * toHalfRad, heading * toHalfRad, bank * toHalfRad];
    const qx = [Math.sin(hx), 0, 0, Math.cos(hx)];
    const qy = [0, Math.sin(hy), 0, Math.cos(hy)];
    const qz = [0, 0, Math.sin(hz), Math.cos(hz)];
    const mul = (a, b) => [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
    return mul(mul(qy, qx), qz);
}

/**
 * Loads the glTFs of a preset tree and merges them into one glTF.
 * @param {object} preset from findPresets
 * @param {object[]} items from buildPresetTree (wrapperNode and problems are filled in)
 * @param {(done: number, total: number) => void} [progress]
 * @returns {Promise<object>} the merged glTF JSON
 */
async function assemblePreset(preset, items, progress) {
    const files = preset.files;
    const merged = {
        asset: { version: "2.0", generator: "glTF Sample Viewer: MSFS package assembly" },
        extensionsUsed: ["KHR_node_visibility"],
        extensionsRequired: [],
        extensions: { KHR_lights_punctual: { lights: [] }, KHR_materials_variants: { variants: [] } },
        scene: 0,
        scenes: [{ name: preset.title, nodes: [0] }],
        nodes: [{ name: baseName(preset.simObject), children: [] }]
    };
    for (const key of TopLevelArrays) {
        merged[key] ??= [];
    }

    const all = [];
    const walk = (list, parent) => {
        for (const item of list) {
            item.parent = parent;
            all.push(item);
            walk(item.children, item);
        }
    };
    walk(items, undefined);
    const total = all.reduce((sum, item) => sum + item.gltfs.length, 0);
    let done = 0;

    // Texture lookup of a model: its own texture folder (model/../texture, or texture.<name>
    // first when the attachment selects a variant), then the texture folders of the attachment
    // and of the attachments it hangs below, each with its texture.cfg fallbacks. (A32X parts
    // without a texture.cfg rely on their parent Function attachment's fallbacks.)
    const textureFoldersOf = (item) => {
        const folders = [];
        const add = (folder) => {
            if (!folders.includes(folder)) {
                folders.push(folder);
            }
        };
        if (item.texture) {
            add(`../texture.${item.texture}/`);
        }
        add("../texture/");
        for (let owner = item; owner !== undefined; owner = owner.parent) {
            if (!owner.root) {
                continue;
            }
            for (const name of [owner.texture ? `texture.${owner.texture}` : undefined, "texture"]) {
                if (name !== undefined && files.hasFolder(`${owner.root}/${name}`)) {
                    add(files.url(`${owner.root}/${name}`) + "/");
                }
            }
        }
        return folders.length === 1 ? undefined : folders;
    };

    // The same lookup on the package's file list, so that images point at the file the sim
    // would use and images resolving to the same file are loaded once.
    const fallbackCache = new Map(); // folder -> Promise<folders listed in its texture.cfg>
    const fallbacksOf = (folder) => {
        const key = folder.toLowerCase();
        if (!fallbackCache.has(key)) {
            fallbackCache.set(
                key,
                readCfg(files, folder + "/texture.cfg")
                    .catch(() => undefined)
                    .then((cfg) =>
                        [...(cfg?.get("fltsim") ?? new Map()).entries()]
                            .map(([name, value]) => [/^fallback\.(\d+)$/.exec(name), value])
                            .filter(([match]) => match !== null)
                            .sort(([a], [b]) => Number(a[1]) - Number(b[1]))
                            .map(([, value]) => joinPath(folder, value))
                            .filter((path) => files.hasFolder(path))
                    )
            );
        }
        return fallbackCache.get(key);
    };
    const searchFoldersOf = async (item, gltfPath) => {
        const modelFolder = folderOf(gltfPath);
        const candidates = [];
        if (item.texture) {
            candidates.push(joinPath(modelFolder, `../texture.${item.texture}`));
        }
        candidates.push(joinPath(modelFolder, "../texture"));
        for (let owner = item; owner !== undefined; owner = owner.parent) {
            if (owner.root) {
                if (owner.texture) {
                    candidates.push(`${owner.root}/texture.${owner.texture}`);
                }
                candidates.push(`${owner.root}/texture`);
            }
        }
        const folders = [];
        const add = (folder) => {
            if (!folders.some((other) => other.toLowerCase() === folder.toLowerCase())) {
                folders.push(folder);
            }
        };
        for (const folder of candidates.map(normalizePath)) {
            if (files.hasFolder(folder)) {
                add(folder);
                (await fallbacksOf(folder)).forEach(add);
            }
        }
        return folders;
    };
    const resolveImages = async (json, item, gltfPath) => {
        let folders = undefined;
        return await Promise.all(
            (json.images ?? []).map(async (image) => {
                if (typeof image.uri !== "string" || image.uri.startsWith("data:")) {
                    return undefined;
                }
                let uri = image.uri;
                try {
                    uri = decodeURIComponent(uri);
                } catch {
                    // keep it as is
                }
                uri = uri.replace(/\\/g, "/");
                // the URI itself (unless absolute, e.g. an exporter's C:\... path), then by name
                let found = /^[a-z]+:/i.test(uri) ? undefined : files.resolve(joinPath(folderOf(gltfPath), uri));
                if (found === undefined) {
                    folders ??= await searchFoldersOf(item, gltfPath);
                    const name = baseName(uri);
                    for (const folder of folders) {
                        found = files.resolve(`${folder}/${name}`);
                        if (found !== undefined) {
                            break;
                        }
                    }
                }
                return found === undefined
                    ? undefined
                    : { key: found.toLowerCase(), sourcePath: files.url(found), uri: encodeURIComponent(baseName(found)) };
            })
        );
    };
    const shared = {};

    // One root node per model (exterior, interior)
    const modelRoots = new Map();
    const modelRoot = (model) => {
        if (!modelRoots.has(model)) {
            merged.nodes.push({ name: model.charAt(0).toUpperCase() + model.substring(1), children: [] });
            merged.nodes[0].children.push(merged.nodes.length - 1);
            modelRoots.set(model, merged.nodes.length - 1);
        }
        return modelRoots.get(model);
    };
    for (const item of items.filter((item) => item.kind === "model")) {
        modelRoot(item.model);
    }

    // Pass 1: every item's glTFs below its own wrapper node
    const owner = []; // merged node index -> item that added it
    for (const item of all) {
        // A model's own node is the root of everything in that model, so hiding it hides all
        // attachments of the model too.
        const isModel = item.kind === "model";
        const wrapper = isModel
            ? merged.nodes[modelRoot(item.model)]
            : { name: item.kind === "attachment" ? `[${item.name}]` : item.name, children: [] };
        wrapper.extras = { msfsPackageItem: item.id };
        wrapper.extensions = { KHR_node_visibility: { visible: true } };
        if (item.kind === "attachment") {
            if (item.offset.some((value) => value !== 0) || item.pbh.some((value) => value !== 0)) {
                item.problems.push("attach_offset/attach_pbh applied, axis convention not verified against the sim");
            }
            if (item.offset.some((value) => value !== 0)) {
                wrapper.translation = item.offset;
            }
            if (item.pbh.some((value) => value !== 0)) {
                wrapper.rotation = pbhToQuaternion(item.pbh);
            }
            if (item.scale !== 1) {
                wrapper.scale = [item.scale, item.scale, item.scale];
            }
        }
        if (isModel) {
            item.wrapperNode = modelRoot(item.model);
        } else {
            merged.nodes.push(wrapper);
            item.wrapperNode = merged.nodes.length - 1;
        }
        owner[item.wrapperNode] = item;

        const textureFolders = textureFoldersOf(item);
        for (const gltfPath of item.gltfs) {
            progress?.(done++, total);
            const problem = await checkGltf(files, gltfPath);
            if (problem !== undefined) {
                item.problems.push(problem);
                continue;
            }
            let json;
            try {
                json = JSON.parse(await files.text(gltfPath));
            } catch (error) {
                item.problems.push(`${baseName(gltfPath)}: ${error.message}`);
                continue;
            }
            const missing = (json.buffers ?? []).filter(
                (buffer) => buffer.uri !== undefined && !buffer.uri.startsWith("data:") &&
                    !files.has(joinPath(folderOf(gltfPath), decodeURIComponent(buffer.uri)))
            );
            if (missing.length > 0) {
                item.problems.push(`${baseName(gltfPath)}: buffer ${missing[0].uri} not found`);
                continue;
            }
            const first = merged.nodes.length;
            const resolvedImages = await resolveImages(json, item, gltfPath);
            // the entry each material comes from (Materials tab groups by it)
            for (const material of json.materials ?? []) {
                material.extras = { ...material.extras, msfsPackageItem: item.id };
            }
            const roots = appendGltf(merged, json, {
                sourcePath: files.url(gltfPath),
                textureFolders,
                resolvedImages,
                shared
            });
            for (let node = first; node < merged.nodes.length; node++) {
                owner[node] = item;
            }
            // one node per file when an item has several (template + merged models)
            if (item.gltfs.length > 1) {
                merged.nodes.push({ name: baseName(gltfPath), children: roots });
                owner[merged.nodes.length - 1] = item;
                wrapper.children.push(merged.nodes.length - 1);
            } else {
                wrapper.children.push(...roots);
            }
        }
    }
    progress?.(total, total);

    // Pass 2: parent the wrappers. Attach nodes are looked up by name in the target model, in
    // order of appearance (base model, merged models, then the attachments in config order).
    const parents = new Map();
    merged.nodes.forEach((node, index) => node.children?.forEach((child) => parents.set(child, index)));
    // the nodes an item adds belong to the model it attaches or merges into
    const modelOf = (item) => item.model;
    const isInside = (node, wrapper) => {
        for (let current = node; current !== undefined; current = parents.get(current)) {
            if (current === wrapper) {
                return true;
            }
        }
        return false;
    };
    const setParent = (child, parent) => {
        (merged.nodes[parent].children ??= []).push(child);
        parents.set(child, parent);
    };
    for (const item of all) {
        if (item.kind === "merge" || (item.kind === "attachment" && item.node === undefined)) {
            setParent(item.wrapperNode, modelRoot(item.model));
        }
    }
    for (const item of all) {
        if (item.kind !== "attachment" || item.node === undefined) {
            continue;
        }
        const wanted = item.node.toLowerCase();
        let target = undefined;
        for (let index = 0; index < merged.nodes.length && target === undefined; index++) {
            const nodeOwner = owner[index];
            if (
                merged.nodes[index].name?.toLowerCase() === wanted &&
                nodeOwner !== undefined &&
                modelOf(nodeOwner) === item.model &&
                index !== item.wrapperNode &&
                !isInside(index, item.wrapperNode)
            ) {
                target = index;
            }
        }
        if (target === undefined) {
            if (!item.external) {
                item.problems.push(`attach node "${item.node}" not found in the ${item.model} model`);
            }
            target = modelRoot(item.model);
        }
        setParent(item.wrapperNode, target);
    }

    for (const key of [...TopLevelArrays, "extensionsRequired"]) {
        if (merged[key].length === 0) {
            delete merged[key];
        }
    }
    for (const [name, array] of [["KHR_lights_punctual", "lights"], ["KHR_materials_variants", "variants"]]) {
        if (merged.extensions[name][array].length === 0) {
            delete merged.extensions[name];
        } else if (!merged.extensionsUsed.includes(name)) {
            merged.extensionsUsed.push(name);
        }
    }
    return merged;
}

async function checkGltf(files, path) {
    if (!files.has(path)) {
        return `${baseName(path)} not found`;
    }
    if (/\.glb$/i.test(path)) {
        return `${baseName(path)}: .glb files are not supported in packages`;
    }
    return undefined;
}

/** Flattens the tree into rows for the Models tab. */
function flattenTree(items, depth = 0, rows = []) {
    for (const item of items) {
        rows.push({ item, depth });
        flattenTree(item.children, depth + 1, rows);
    }
    return rows;
}

export {
    PackageFiles,
    assemblePreset,
    buildPresetTree,
    findPresets,
    flattenTree,
    normalizePath,
    parseCfg,
    releaseVirtualFiles,
    scanDirectory
};
