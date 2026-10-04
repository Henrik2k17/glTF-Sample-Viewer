// Runs the glTF Validator off the main thread. It reads the whole asset including all
// buffers and images, which takes several seconds for large models.
//
// Message in:  { mainFile: String (URL) | [path, File], additionalFiles: [path, File][], options }
// Message out: the validation report, or { error }

import { validateBytes } from "gltf-validator";
import { ResourceLoaderUtils } from "../glTF-Sample-Renderer/source/ResourceLoader/loader_utils.js";

async function validate({ mainFile, additionalFiles, options }) {
    if (typeof mainFile === "string") {
        const parent = mainFile.substring(0, mainFile.lastIndexOf("/") + 1);
        const response = await fetch(mainFile);
        const buffer = await response.arrayBuffer();
        return await validateBytes(new Uint8Array(buffer), {
            ...options,
            uri: mainFile,
            externalResourceFunction: async (uri) =>
                new Uint8Array(await (await fetch(parent + uri)).arrayBuffer())
        });
    }
    const buffer = await mainFile[1].arrayBuffer();
    return await validateBytes(new Uint8Array(buffer), {
        ...options,
        uri: mainFile[0],
        externalResourceFunction: async (uri) => {
            const file = ResourceLoaderUtils.findFile(additionalFiles, uri, mainFile[0])?.[1];
            if (file === undefined) {
                throw "File not found";
            }
            return new Uint8Array(await file.arrayBuffer());
        }
    });
}

self.onmessage = async (event) => {
    try {
        self.postMessage(await validate(event.data));
    } catch (error) {
        self.postMessage({ error: `Validation failed: ${error}` });
    }
};
