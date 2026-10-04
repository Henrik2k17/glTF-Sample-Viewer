import { ResourceLoaderUtils } from "@khronosgroup/gltf-viewer";

// Texture lookup folders: local folders (File System Access API) searched, in list order, for
// textures a model references but that were neither dropped with it nor fetchable. Exporters
// such as the MSFS one point textures outside the model folder ("../../texture/x.png").
// Folder handles are kept in IndexedDB; the browser asks again for read access each session.

const DbName = "gltf-sample-viewer";
const StoreName = "textureFolders";
const ListKey = "list";

const ImageExtensions = new Set(["png", "jpg", "jpeg", "webp", "ktx2", "ktx", "dds", "tga", "tif", "tiff"]);
// Folders that never hold source textures but can be huge
const SkippedFolders = new Set([".git", "node_modules", "_packagescache", "__pycache__"]);
const MaxIndexedFiles = 200000;

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DbName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(StoreName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function dbAccess(mode, action) {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction(StoreName, mode);
            const request = action(transaction.objectStore(StoreName));
            transaction.oncomplete = () => resolve(request?.result);
            transaction.onerror = () => reject(transaction.error);
        });
    } finally {
        db.close();
    }
}

class TextureFolders {
    /**
     * @param {function} onChange - Called whenever folder state changes, with the UI rows.
     */
    constructor(onChange) {
        this.onChange = onChange;
        // { id, handle, status: "needsAccess"|"scanning"|"ready"|"error", byName: Map, fileCount, error, scan }
        this.folders = [];
        this.nextId = 1;
    }

    static isSupported() {
        return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
    }

    rows() {
        return this.folders.map((folder) => ({
            id: folder.id,
            name: folder.handle.name,
            status: folder.status,
            fileCount: folder.fileCount,
            truncated: folder.truncated,
            error: folder.error
        }));
    }

    notify() {
        this.onChange(this.rows());
    }

    needsAccess() {
        return this.folders.some((folder) => folder.status === "needsAccess");
    }

    async restore() {
        if (!TextureFolders.isSupported()) {
            return;
        }
        let handles = [];
        try {
            handles = (await dbAccess("readonly", (store) => store.get(ListKey))) ?? [];
        } catch (error) {
            console.warn("Texture folders could not be restored", error);
        }
        this.folders = handles.map((handle) => this.newFolder(handle));
        this.notify();
        for (const folder of this.folders) {
            // Never prompts: requestPermission needs a click, see requestAccess.
            if ((await folder.handle.queryPermission({ mode: "read" })) === "granted") {
                this.startScan(folder);
            } else {
                folder.status = "needsAccess";
            }
        }
        this.notify();
    }

    newFolder(handle) {
        return { id: this.nextId++, handle, status: "needsAccess", byName: new Map(), fileCount: 0 };
    }

    async save() {
        try {
            const handles = this.folders.map((folder) => folder.handle);
            await dbAccess("readwrite", (store) => store.put(handles, ListKey));
        } catch (error) {
            console.warn("Texture folders could not be saved", error);
        }
    }

    /**
     * Opens the folder picker. Returns "added", "cancelled" or "duplicate"; throws if the
     * browser refuses the folder (e.g. access denied after picking).
     */
    async add() {
        let handle;
        try {
            handle = await window.showDirectoryPicker({ id: "textureFolders", mode: "read" });
        } catch (error) {
            if (error?.name === "AbortError" && /abort|cancel/i.test(error.message ?? "")) {
                console.info("Texture folder picker closed:", error.message);
                return "cancelled";
            }
            throw error;
        }
        for (const folder of this.folders) {
            if (await folder.handle.isSameEntry(handle)) {
                return "duplicate";
            }
        }
        const folder = this.newFolder(handle);
        this.folders.push(folder);
        await this.save();
        this.startScan(folder);
        return "added";
    }

    async remove(id) {
        this.folders = this.folders.filter((folder) => folder.id !== id);
        await this.save();
        this.notify();
    }

    async move(id, offset) {
        const index = this.folders.findIndex((folder) => folder.id === id);
        const target = index + offset;
        if (index < 0 || target < 0 || target >= this.folders.length) {
            return;
        }
        const [folder] = this.folders.splice(index, 1);
        this.folders.splice(target, 0, folder);
        await this.save();
        this.notify();
    }

    /** Must run from a click handler: the browser shows its permission prompt. */
    async requestAccess() {
        for (const folder of this.folders) {
            if (folder.status !== "needsAccess") {
                continue;
            }
            if ((await folder.handle.requestPermission({ mode: "read" })) === "granted") {
                this.startScan(folder);
            }
        }
        this.notify();
    }

    rescan(id) {
        const folder = this.folders.find((folder) => folder.id === id);
        if (folder !== undefined && folder.status !== "needsAccess") {
            this.startScan(folder);
        }
    }

    startScan(folder) {
        folder.status = "scanning";
        folder.error = undefined;
        this.notify();
        folder.scan = this.scanFolder(folder).finally(() => this.notify());
    }

    async scanFolder(folder) {
        const byName = new Map();
        let fileCount = 0;
        let truncated = false;
        const walk = async (directory, path) => {
            for await (const entry of directory.values()) {
                if (fileCount >= MaxIndexedFiles) {
                    truncated = true;
                    return;
                }
                if (entry.kind === "directory") {
                    if (!SkippedFolders.has(entry.name.toLowerCase())) {
                        await walk(entry, `${path}${entry.name}/`);
                    }
                    continue;
                }
                const name = entry.name.toLowerCase();
                if (!ImageExtensions.has(ResourceLoaderUtils.getExtension(name))) {
                    continue;
                }
                if (!byName.has(name)) {
                    byName.set(name, []);
                }
                byName.get(name).push([path + entry.name, entry]);
                fileCount++;
            }
        };
        try {
            await walk(folder.handle, `${folder.handle.name}/`);
            folder.byName = byName;
            folder.fileCount = fileCount;
            folder.truncated = truncated;
            folder.status = "ready";
        } catch (error) {
            folder.status = "error";
            folder.error = error?.message ?? String(error);
        }
    }

    /**
     * Finds a texture for a glTF image URI: the first folder (in list order) with a file of the
     * same name wins; within a folder the path sharing the most trailing segments with the URI.
     * Also accepts compiled MSFS textures, which append ".dds" to the source name.
     * @returns {Promise<[string, File] | undefined>}
     */
    async resolve(uri) {
        let decoded = uri;
        try {
            decoded = decodeURI(uri);
        } catch {
            // keep the raw URI
        }
        const fileName = decoded.replace(/\\/g, "/").split("/").pop().toLowerCase();
        if (fileName === "") {
            return undefined;
        }
        for (const folder of this.folders) {
            await folder.scan;
            if (folder.status !== "ready") {
                continue;
            }
            for (const [candidateUri, candidateName] of [
                [decoded, fileName],
                [`${decoded}.dds`, `${fileName}.dds`]
            ]) {
                const candidates = folder.byName.get(candidateName);
                if (candidates === undefined) {
                    continue;
                }
                // findFile skips the suffix ranking for absolute URIs (e.g. "C:/textures/x.png")
                const [path, handle] =
                    ResourceLoaderUtils.findFile(candidates, candidateUri, "") ?? candidates[0];
                return [path, await handle.getFile()];
            }
        }
        return undefined;
    }
}

export { TextureFolders };
