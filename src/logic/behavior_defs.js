// Model behavior definitions outside a package: the MSFS SDK's ModelBehaviorDefs folder, which
// holds the Asobo templates (ASOBO_EX1\..., Asobo\...) that source behaviors include. The sim
// finds them in its own files; the viewer needs the folder once (File System Access API, the
// handle is kept in IndexedDB next to the texture folders) or a URL (?behaviorDefs=).

const DbName = "gltf-sample-viewer";
const StoreName = "textureFolders"; // the viewer's one store (see texture_folders.js)
const HandleKey = "behaviorDefs";

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

class BehaviorDefs {
    /** @param {function} onChange called with the UI state when it changes */
    constructor(onChange) {
        this.onChange = onChange;
        this.url = undefined; // base URL ending in "/"
        this.handle = undefined; // the folder picked (FileSystemDirectoryHandle)
        this.status = "none"; // none | needsAccess | scanning | ready | error
        this.files = new Map(); // lower-case path under ModelBehaviorDefs -> FileSystemFileHandle
        this.error = undefined;
        this.scan = Promise.resolve();
    }

    static isSupported() {
        return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
    }

    /** Whether includes can be read (a URL, or a scanned folder). */
    get available() {
        return this.url !== undefined || this.status === "ready";
    }

    state() {
        return {
            name: this.url ?? this.handle?.name ?? "",
            status: this.url !== undefined ? "ready" : this.status,
            fileCount: this.url !== undefined ? undefined : this.files.size,
            error: this.error
        };
    }

    notify() {
        this.onChange(this.state());
    }

    setUrl(url) {
        this.url = url.endsWith("/") ? url : `${url}/`;
        this.notify();
    }

    async restore() {
        if (!BehaviorDefs.isSupported()) {
            return;
        }
        try {
            this.handle = await dbAccess("readonly", (store) => store.get(HandleKey));
        } catch (error) {
            console.warn("The behavior definitions folder could not be restored", error);
        }
        if (this.handle === undefined) {
            this.notify();
            return;
        }
        // never prompts: requestPermission needs a click (requestAccess)
        if ((await this.handle.queryPermission({ mode: "read" })) === "granted") {
            this.startScan();
        } else {
            this.status = "needsAccess";
        }
        this.notify();
    }

    /** Opens the folder picker; must run from a click. Returns false when cancelled. */
    async pick() {
        let handle;
        try {
            handle = await window.showDirectoryPicker({ id: "behaviorDefs", mode: "read" });
        } catch (error) {
            if (error?.name === "AbortError") {
                return false;
            }
            throw error;
        }
        this.handle = handle;
        try {
            await dbAccess("readwrite", (store) => store.put(handle, HandleKey));
        } catch (error) {
            console.warn("The behavior definitions folder could not be saved", error);
        }
        this.startScan();
        await this.scan;
        return true;
    }

    /** Must run from a click handler: the browser shows its permission prompt. */
    async requestAccess() {
        if (this.handle !== undefined && (await this.handle.requestPermission({ mode: "read" })) === "granted") {
            this.startScan();
            await this.scan;
        }
        this.notify();
    }

    async clear() {
        this.handle = undefined;
        this.files = new Map();
        this.status = "none";
        try {
            await dbAccess("readwrite", (store) => store.delete(HandleKey));
        } catch (error) {
            console.warn("The behavior definitions folder could not be removed", error);
        }
        this.notify();
    }

    startScan() {
        this.status = "scanning";
        this.error = undefined;
        this.notify();
        this.scan = this.scanFolder().finally(() => this.notify());
    }

    async scanFolder() {
        const files = new Map();
        const walk = async (directory, path) => {
            for await (const entry of directory.values()) {
                if (entry.kind === "directory") {
                    await walk(entry, `${path}${entry.name.toLowerCase()}/`);
                } else if (entry.name.toLowerCase().endsWith(".xml")) {
                    files.set(path + entry.name.toLowerCase(), entry);
                }
            }
        };
        try {
            // the SDK folder itself or the ModelBehaviorDefs folder in it
            let root = this.handle;
            for await (const entry of this.handle.values()) {
                if (entry.kind === "directory" && entry.name.toLowerCase() === "modelbehaviordefs") {
                    root = entry;
                }
            }
            await walk(root, "");
            this.files = files;
            this.status = files.size > 0 ? "ready" : "error";
            this.error = files.size > 0 ? undefined : "no behavior XML files in this folder";
        } catch (error) {
            this.status = "error";
            this.error = error?.message ?? String(error);
        }
    }

    /** A file under ModelBehaviorDefs ("Asobo_EX1/Index.xml"), or undefined. */
    async text(path) {
        path = path.replace(/\\+/g, "/").replace(/^\/+/, "");
        if (this.url !== undefined) {
            try {
                const response = await fetch(this.url + path.split("/").map(encodeURIComponent).join("/"));
                return response.ok ? await response.text() : undefined;
            } catch {
                return undefined;
            }
        }
        await this.scan;
        const handle = this.files.get(path.toLowerCase());
        return handle === undefined ? undefined : await (await handle.getFile()).text();
    }
}

export { BehaviorDefs };
