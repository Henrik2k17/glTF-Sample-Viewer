// Performance overlay on top of the canvas: frame statistics from the renderer's FrameProfiler
// (view.profiler) averaged over the last second, plus scene and texture sizes. The viewer only
// redraws on changes (camera moves, animations), so "redraws/s" is not a frame rate while idle.

const Window = 1000; // ms of frames the averages cover
const UpdateInterval = 250; // ms between text updates

const ms = (value) => (value === undefined ? "–" : value < 10 ? value.toFixed(1) : value.toFixed(0));
const count = (value) =>
    value >= 1e6 ? `${(value / 1e6).toFixed(2)} M` : value >= 1e4 ? `${(value / 1e3).toFixed(0)} k` : String(Math.round(value));
const megabytes = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`);

/** Approximate GPU memory of the loaded images (compressed: exact mip data; else RGBA8 + mips). */
function textureBytes(gltf) {
    let bytes = 0;
    for (const image of gltf?.images ?? []) {
        const data = image.image;
        if (data === undefined || image.mimeType === "image/gltexture") {
            continue; // not loaded, or a renderer-internal texture
        }
        if (data.compressed !== undefined) {
            // levels are released once on the GPU (see gltfWebGl.releaseUploadedImage)
            bytes +=
                data.compressed.byteLength ??
                data.compressed.levels.reduce((sum, level) => sum + level.data.byteLength, 0);
        } else if (data.width && data.height) {
            bytes += (data.width * data.height * 4 * 4) / 3;
        }
    }
    return bytes;
}

class PerfOverlay {
    constructor(parent) {
        this.element = document.createElement("div");
        this.element.className = "perfOverlay";
        this.element.hidden = true;
        parent.appendChild(this.element);
        this.frames = [];
        this.lastUpdate = 0;
        this.textureCache = { gltf: undefined, bytes: 0 };
    }

    setVisible(visible) {
        this.element.hidden = !visible;
        this.frames = [];
        this.lastUpdate = 0;
    }

    get visible() {
        return !this.element.hidden;
    }

    /** Call after each renderFrame. */
    recordFrame(profiler, time) {
        if (!this.visible || profiler.lastFrame === undefined) {
            return;
        }
        this.frames.push({ time, frame: profiler.lastFrame });
    }

    /** Call every animation frame; updates the text a few times a second. */
    update(time, profiler, state, renderer, canvas) {
        if (!this.visible || time - this.lastUpdate < UpdateInterval) {
            return;
        }
        this.lastUpdate = time;
        this.frames = this.frames.filter((entry) => time - entry.time <= Window);
        const frames = this.frames.map((entry) => entry.frame);
        const last = profiler.lastFrame;
        const average = (pick) =>
            frames.length === 0 ? pick(last ?? {}) : frames.reduce((sum, frame) => sum + (pick(frame) ?? 0), 0) / frames.length;
        const max = (pick) => (frames.length === 0 ? pick(last ?? {}) : Math.max(...frames.map(pick)));

        const sections = ["prepare", "transforms", "skins", "draw", "helpers", "animation", "physics"]
            .map((name) => [name, average((frame) => frame.sections?.[name])])
            .filter(([, value]) => value >= 0.05)
            .map(([name, value]) => `${name} ${ms(value)}`);
        const passes = Object.entries(last?.passes ?? {}).map(
            ([name, pass]) => `${name} ${count(pass.draws)}`
        );

        if (this.textureCache.gltf !== state.gltf) {
            this.textureCache = { gltf: state.gltf, bytes: textureBytes(state.gltf) };
        }
        const gltf = state.gltf;
        const nodes = gltf?.nodes.length ?? 0;
        const shownNodes = renderer.nodes?.length ?? 0;
        const dpr = window.devicePixelRatio || 1;
        const gpu = profiler.gpuSupported === false ? "n/a" : `${ms(profiler.lastGpuMs)} ms`;

        const lines = [
            `<b>${frames.length}</b> redraws/s · CPU <b>${ms(average((frame) => frame.cpu))} ms</b> (max ${ms(max((frame) => frame.cpu))}) · GPU ${gpu}`,
            sections.length > 0 ? `&nbsp; ${sections.join(" · ")}` : undefined,
            `Draw calls <b>${count(last?.draws ?? 0)}</b> · triangles ${count(last?.triangles ?? 0)}`,
            passes.length > 0 ? `&nbsp; ${passes.join(" · ")}` : undefined,
            `Nodes ${count(shownNodes)} shown of ${count(nodes)} · textures ${gltf?.images.length ?? 0} (~${megabytes(this.textureCache.bytes)})`,
            `Canvas ${canvas.width}×${canvas.height} (DPR ${dpr})`
        ];
        this.element.innerHTML = lines.filter((line) => line !== undefined).join("<br>");
    }
}

export { PerfOverlay };
