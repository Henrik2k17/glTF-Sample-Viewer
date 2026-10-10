import { GltfView, Msfs } from "@khronosgroup/gltf-viewer";

import { UIModel } from "./logic/uimodel.js";
import {
    buildNodeTree,
    collectSubtree,
    getMsfsMaterialSummary,
    getNodeDetails,
    materialSections,
    nodeTitle
} from "./logic/inspector.js";
import {
    buildMaterialList,
    getShownMaterials,
    getChannelHints,
    getMaterialTextureSlots,
    getMaterialUsage,
} from "./logic/materials.js";
import { buildMaterialEditor, hexToLinear } from "./logic/msfs_material_editor.js";
import { readMaterial, writeMaterial, setMaterialType } from "./logic/msfs_material_model.js";
import { materialForSource, replaceMaterialsInText, downloadText, writeFilesToDirectory } from "./logic/material_save.js";
import { buildMsfsAnimationEntries, findAnimationsForNode, getAnimatedTargets } from "./logic/msfs_animations.js";
import { summarizeValidation } from "./logic/validation_summary.js";
import { TextureFolders } from "./logic/texture_folders.js";
import { PerfOverlay } from "./logic/perf_overlay.js";
import {
    PackageFiles,
    assemblePreset,
    buildPresetTree,
    findLiveries,
    findPresets,
    flattenTree,
    releaseVirtualFiles,
    scanDirectory
} from "./logic/msfs_package.js";
import { app } from "./ui/ui.js";
import { EMPTY, Observable, from, merge, of } from "rxjs";
import { mergeMap, map, share, catchError, switchMap, tap } from "rxjs/operators";
import { fillEnvironmentWithPaths } from "./model_path_provider.js";
import { VariableStore, buildBehaviors, evaluateVisibility } from "./logic/msfs_behavior.js";

export default async () => {
    const canvas = document.getElementById("canvas");
    const context = canvas.getContext("webgl2", {
        alpha: false,
        antialias: true
    });
    // e.g. the GPU ran out of memory: the view stays black, so say why
    canvas.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        console.error("WebGL context lost", event.statusMessage ?? "");
        app.error(
            "The GPU ran out of memory or was reset (WebGL context lost), so nothing can be drawn any more. " +
                "Reload the page; for MSFS packages, try a smaller preset.",
            60000
        );
    });
    app.supportsFloatingPointFramebuffer =
        !!context.getExtension("EXT_color_buffer_half_float") ||
        !!context.getExtension("EXT_color_buffer_float");

    const view = new GltfView(context);
    const resourceLoader = view.createResourceLoader();

    // Texture lookup folders: searched for textures a model references but doesn't ship with
    const textureFolders = new TextureFolders((rows) => (app.textureFolders = rows));
    app.textureFoldersSupported = TextureFolders.isSupported();
    const textureFoldersRestored = textureFolders.restore();
    resourceLoader.textureFileResolver = async (uri) => {
        await textureFoldersRestored;
        return textureFolders.resolve(uri);
    };

    // Max texture size (Display tab, or ?maxTextureSize=): larger textures are shrunk while
    // loading, e.g. to fit an MSFS package into GPU memory. Remembered per browser; a change
    // reloads the model.
    const MaxTextureSizeStorageKey = "maxTextureSize";
    const applyMaxTextureSize = (size) => {
        size = Number(size);
        if (!app.maxTextureSizes.some((option) => option.value === size)) {
            return false;
        }
        resourceLoader.maxTextureSize = size;
        app.maxTextureSize = size;
        return true;
    };
    try {
        applyMaxTextureSize(
            new URLSearchParams(window.location.search).get("maxTextureSize") ??
                window.localStorage.getItem(MaxTextureSizeStorageKey)
        );
    } catch {
        // no limit
    }
    app.maxTextureSizeChanged.subscribe((size) => {
        if (!applyMaxTextureSize(size)) {
            return;
        }
        try {
            window.localStorage.setItem(MaxTextureSizeStorageKey, String(size));
        } catch {
            // not remembered, still applied
        }
        app.modelReloadRequested.next(undefined);
    });
    const state = view.createState();

    // The loaded MSFS package preset (see "MSFS packages" below); the Materials tab uses it too.
    const NoLivery = "none"; // livery selection: load without a livery
    const msfsPackage = {
        packages: [],
        presets: [],
        items: [], // tree of the loaded preset
        byId: new Map(),
        objectUrl: undefined,
        liveryParam: new URLSearchParams(window.location.search).get("livery") ?? undefined, // until used once
        loading: 0 // generation, to drop results of superseded loads
    };

    state.renderingParameters.useDirectionalLightsWithDisabledIBL = true;
    // MSFS assets have no behaviour graphs (KHR_interactivity); the physics engine
    // (KHR_physics_rigid_bodies) is not loaded at all.
    state.renderingParameters.enabledExtensions.KHR_interactivity = false;

    const emptyGltf = await resourceLoader.loadGltf(undefined, undefined, false);

    const environmentPaths = fillEnvironmentWithPaths(
        {
            Cannon_Exterior: "Cannon Exterior",
            footprint_court: "Footprint Court",
            pisa: "Pisa",
            doge2: "Doge's palace",
            ennis: "Dining room",
            field: "Field",
            helipad: "Helipad Goldenhour",
            papermill: "Papermill Ruins",
            neutral: "Studio Neutral",
            Colorful_Studio: "Colorful Studio",
            Wide_Street: "Wide Street"
        },
        "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Environments/low_resolution_hdrs/"
    );

    const uiModel = new UIModel(app, environmentPaths);

    // The validator reads the whole asset again, so it runs in a worker to keep the main
    // thread free for loading and rendering.
    let validatorWorker = undefined;
    const validation = uiModel.model.pipe(
        switchMap((model) => {
            validatorWorker?.terminate();
            validatorWorker = undefined;
            if (model.package) {
                // The merged glTF only exists in memory; the validator checks files.
                return of({
                    error: "The validator checks single glTF files. Load a part in Single file mode to validate it."
                });
            }
            const worker = new Worker("./validator.worker.js");
            validatorWorker = worker;
            return new Observable((subscriber) => {
                const finish = (report) => {
                    subscriber.next(report);
                    subscriber.complete();
                    worker.terminate();
                };
                worker.onmessage = (event) => {
                    if (event.data?.error !== undefined) {
                        console.error(event.data.error);
                    }
                    finish(event.data);
                };
                worker.onerror = (event) => {
                    console.error(`Validation failed: ${event.message}`);
                    finish({ error: `Validation failed: ${event.message}` });
                };
                worker.postMessage({
                    mainFile: model.mainFile,
                    additionalFiles: model.additionalFiles,
                    options: {
                        // TODO: Remove ignoredIssues once validator is updated to support KHR_gaussian_splatting extension
                        ignoredIssues: ["MESH_PRIMITIVE_INVALID_ATTRIBUTE"],
                        // all messages, for the per-issue breakdown in the Validator tab
                        maxIssues: 0
                    }
                });
                return () => worker.terminate();
            });
        })
    );

    // Frees the shown model before the next one loads: two MSFS packages (~2 GB of textures
    // each) don't fit in memory at the same time.
    function releaseShownModel() {
        const shown = state.gltf;
        if (shown === undefined || shown === emptyGltf) {
            return;
        }
        state.gltf = emptyGltf;
        state.sceneIndex = 0;
        state.cameraNodeIndex = undefined;
        state.animationIndices = [];
        state.animationTimeOverrides.clear();
        setupInspector(emptyGltf, 0);
        setupMaterials(emptyGltf);
        setupBehaviors(undefined);
        app.msfsAnimationMode = false;
        app.msfsAnimations = [];
        selectMsfsAnimations([]);
        refreshValidationSummary();
        resourceLoader.unloadGltf(shown);
        redraw = true;
    }

    let loadedModelSource = undefined; // { mainFile, package } of the shown model (material editor: saving)

    // whenever a new model is selected, load it and when complete pass the loaded gltf
    // into a stream back into the UI
    let modelLoadGeneration = 0;
    const gltfLoaded = uiModel.model.pipe(
        mergeMap((model) => {
            uiModel.goToLoadingState();
            const generation = ++modelLoadGeneration;
            releaseShownModel();

            // Workaround for errors in ktx lib after loading an asset with ktx2 files for the second time:
            resourceLoader.initKtxLib();

            return from(
                resourceLoader
                    .loadGltf(model.mainFile, model.additionalFiles, false)
                    .then((gltf) => {
                        if (generation !== modelLoadGeneration) {
                            // another model was chosen while this one loaded
                            resourceLoader.unloadGltf(gltf);
                            return state;
                        }
                        state.gltf = gltf;
                        loadedModelSource = model;
                        const missingImages = gltf.images.filter((image) => !image.isLoaded());
                        if (missingImages.length > 0) {
                            app.warn(
                                `${missingImages.length} of ${gltf.images.length} textures could not be loaded. ` +
                                    (textureFolders.needsAccess()
                                        ? "Allow access to your texture folders (Models tab), then reload the model."
                                        : "Add their folder under Texture folders (Models tab), then reload the model.")
                            );
                        }
                        const defaultScene = state.gltf.scene;
                        state.sceneIndex = defaultScene === undefined ? 0 : defaultScene;
                        state.cameraNodeIndex = undefined;

                        if (state.gltf.scenes.length != 0) {
                            if (state.sceneIndex > state.gltf.scenes.length - 1) {
                                state.sceneIndex = 0;
                            }
                            const scene = state.gltf.scenes[state.sceneIndex];
                            scene.applyTransformHierarchy(state.gltf);
                            state.userCamera.perspective.aspectRatio = canvas.width / canvas.height;
                            state.userCamera.resetView(state.gltf, state.sceneIndex);

                            const queryString = window.location.search;
                            const urlParams = new URLSearchParams(queryString);
                            let yaw = urlParams.get("yaw") ?? 0;
                            yaw = (yaw * (Math.PI / 180)) / state.userCamera.orbitSpeed;
                            let pitch = urlParams.get("pitch") ?? 0;
                            pitch = (pitch * (Math.PI / 180)) / state.userCamera.orbitSpeed;
                            const distance = urlParams.get("distance") ?? 0;
                            state.userCamera.orbit(yaw, pitch);
                            state.userCamera.zoomBy(distance);

                            state.animationIndices = [];
                            state.animationTimeOverrides.clear();
                            if (Msfs.isMsfsAsset(gltf)) {
                                // MSFS animations are driven by sim variables, not played as
                                // clips: start in the rest pose and let the user scrub them.
                                setupMsfsAnimations(gltf);
                            } else {
                                app.msfsAnimationMode = false;
                                app.msfsAnimations = [];
                                selectMsfsAnimations([]);
                                for (let i = 0; i < gltf.animations.length; i++) {
                                    if (
                                        !gltf
                                            .nonDisjointAnimations(state.animationIndices)
                                            .includes(i)
                                    ) {
                                        state.animationIndices.push(i);
                                    }
                                }
                            }
                            state.animationTimer.start();
                        }
                        setupInspector(gltf, state.sceneIndex);
                        setupMaterials(gltf);
                        refreshValidationSummary();
                        setupPackageTree(model);
                        setupBehaviors(model);

                        uiModel.exitLoadingState();

                        return state;
                    })
                    .catch((error) => {
                        if (generation !== modelLoadGeneration) {
                            return state;
                        }
                        console.error("Loading failed: " + error);
                        state.gltf = emptyGltf;
                        state.sceneIndex = 0;
                        state.cameraNodeIndex = undefined;
                        setupInspector(emptyGltf, 0);
                        setupMaterials(emptyGltf);
                        refreshValidationSummary();
                        setupPackageTree(undefined);
                        setupBehaviors(undefined);
                        if (model.package) {
                            app.packageError = `Loading the assembled model failed: ${error}`;
                        }
                        uiModel.exitLoadingState();
                        redraw = true;
                        return state;
                    })
            );
        }),
        catchError((error) => {
            console.error(error);
            uiModel.exitLoadingState();
            return EMPTY;
        }),
        share()
    );

    // Disable all animations which are not disjoint to the current selection of animations.
    uiModel.disabledAnimations(
        uiModel.activeAnimations.pipe(
            map((animationIndices) => state.gltf.nonDisjointAnimations(animationIndices))
        )
    );

    const sceneChangedObservable = uiModel.scene.pipe(
        map((sceneIndex) => {
            state.sceneIndex = sceneIndex;
            state.cameraNodeIndex = undefined;
            const scene = state.gltf.scenes[state.sceneIndex];
            if (scene !== undefined) {
                scene.applyTransformHierarchy(state.gltf);
                state.userCamera.resetView(state.gltf, state.sceneIndex);
            }
        }),
        share()
    );

    const statisticsUpdateObservable = merge(sceneChangedObservable, gltfLoaded).pipe(
        map(() => view.gatherStatistics(state))
    );

    const cameraExportChangedObservable = uiModel.cameraValuesExport.pipe(
        map(() => {
            const camera =
                state.cameraNodeIndex === undefined
                    ? state.userCamera
                    : state.gltf.cameras[state.cameraNodeIndex];
            return camera.getDescription(state.gltf);
        })
    );

    const downloadDataURL = (filename, dataURL) => {
        const element = document.createElement("a");
        element.setAttribute("href", dataURL);
        element.setAttribute("download", filename);
        element.style.display = "none";
        document.body.appendChild(element);
        element.click();
        document.body.removeChild(element);
    };

    cameraExportChangedObservable.subscribe((cameraDesc) => {
        const gltf = JSON.stringify(cameraDesc, undefined, 4);
        const dataURL = "data:text/plain;charset=utf-8," + encodeURIComponent(gltf);
        downloadDataURL("camera.gltf", dataURL);
    });

    uiModel.captureCanvas.subscribe(() => {
        view.renderFrame(state, canvas.width, canvas.height);
        const dataURL = canvas.toDataURL();
        downloadDataURL("capture.png", dataURL);
    });

    // Only redraw glTF view upon user inputs, or when an animation is playing.
    let redraw = false;
    const listenForRedraw = (stream) => stream.subscribe(() => (redraw = true));

    uiModel.scene.subscribe((scene) => (state.sceneIndex = scene !== -1 ? scene : undefined));
    listenForRedraw(uiModel.scene);

    uiModel.tonemap.subscribe((tonemap) => (state.renderingParameters.toneMap = tonemap));
    listenForRedraw(uiModel.tonemap);

    uiModel.debugchannel.subscribe(
        (debugchannel) => (state.renderingParameters.debugOutput = debugchannel)
    );
    listenForRedraw(uiModel.debugchannel);

    uiModel.skinningEnabled.subscribe(
        (skinningEnabled) => (state.renderingParameters.skinning = skinningEnabled)
    );
    listenForRedraw(uiModel.skinningEnabled);

    uiModel.exposure.subscribe(
        (exposure) => (state.renderingParameters.exposure = 1.0 / Math.pow(2.0, exposure))
    );
    listenForRedraw(uiModel.exposure);

    uiModel.floatingPointFramebufferEnabled.subscribe(
        (enabled) => (state.renderingParameters.floatingPointFramebuffer = enabled)
    );
    listenForRedraw(uiModel.floatingPointFramebufferEnabled);

    uiModel.showMsfsInvisibleMaterials.subscribe(
        (show) => (state.renderingParameters.showMsfsInvisibleMaterials = show)
    );
    listenForRedraw(uiModel.showMsfsInvisibleMaterials);

    uiModel.msfsNightLighting.subscribe(
        (night) => (state.renderingParameters.msfsNightLighting = night)
    );
    listenForRedraw(uiModel.msfsNightLighting);

    // Emissive multiplier (Advanced Controls, or ?emissive=): scales the emissive of every
    // material, to tune the brightness by eye. Remembered per browser.
    const EmissiveStorageKey = "emissiveMultiplier";
    const applyEmissiveMultiplier = (value) => {
        value = Number(value);
        if (!Number.isFinite(value) || value <= 0) {
            return false;
        }
        app.emissiveMultiplier = value;
        state.renderingParameters.emissiveMultiplier = value;
        redraw = true;
        return true;
    };
    {
        let stored = new URLSearchParams(window.location.search).get("emissive");
        if (stored === null) {
            try {
                stored = window.localStorage.getItem(EmissiveStorageKey);
            } catch {
                stored = null;
            }
        }
        if (stored === null || !applyEmissiveMultiplier(stored)) {
            applyEmissiveMultiplier(app.emissiveMultiplierDefault);
        }
    }
    app.emissiveMultiplierChanged.subscribe((value) => {
        if (!applyEmissiveMultiplier(value)) {
            return;
        }
        try {
            window.localStorage.setItem(EmissiveStorageKey, String(value));
        } catch {
            // not remembered, still applied
        }
    });

    uiModel.showMsfsColliders.subscribe(
        (show) => (state.renderingParameters.showMsfsColliders = show)
    );
    listenForRedraw(uiModel.showMsfsColliders);

    uiModel.showMsfsLights.subscribe((show) => (state.renderingParameters.showMsfsLights = show));
    listenForRedraw(uiModel.showMsfsLights);

    uiModel.iblEnabled.subscribe((iblEnabled) => (state.renderingParameters.useIBL = iblEnabled));
    listenForRedraw(uiModel.iblEnabled);

    uiModel.iblIntensity.subscribe(
        (iblIntensity) => (state.renderingParameters.iblIntensity = Math.pow(10, iblIntensity))
    );
    listenForRedraw(uiModel.iblIntensity);

    uiModel.renderEnvEnabled.subscribe(
        (renderEnvEnabled) => (state.renderingParameters.renderEnvironmentMap = renderEnvEnabled)
    );
    listenForRedraw(uiModel.renderEnvEnabled);

    uiModel.blurEnvEnabled.subscribe(
        (blurEnvEnabled) => (state.renderingParameters.blurEnvironmentMap = blurEnvEnabled)
    );
    listenForRedraw(uiModel.blurEnvEnabled);

    uiModel.punctualLightsEnabled.subscribe(
        (punctualLightsEnabled) => (state.renderingParameters.usePunctual = punctualLightsEnabled)
    );
    listenForRedraw(uiModel.punctualLightsEnabled);

    uiModel.environmentRotation.subscribe((environmentRotation) => {
        switch (environmentRotation) {
            case "+Z":
                state.renderingParameters.environmentRotation = 90.0;
                break;
            case "-X":
                state.renderingParameters.environmentRotation = 180.0;
                break;
            case "-Z":
                state.renderingParameters.environmentRotation = 270.0;
                break;
            case "+X":
                state.renderingParameters.environmentRotation = 0.0;
                break;
        }
    });
    listenForRedraw(uiModel.environmentRotation);

    uiModel.clearColor.subscribe(
        (clearColor) => (state.renderingParameters.clearColor = clearColor)
    );
    listenForRedraw(uiModel.clearColor);

    uiModel.animationPlay.subscribe((animationPlay) => {
        if (animationPlay) {
            state.animationTimer.unpause();
        } else {
            state.animationTimer.pause();
        }
    });

    uiModel.animationReset.subscribe(() => {
        state.animationTimer.reset();
        redraw = true;
    });

    uiModel.activeAnimations.subscribe((animations) => (state.animationIndices = animations));
    listenForRedraw(uiModel.activeAnimations);

    uiModel.hdr.subscribe((hdr) => {
        resourceLoader.loadEnvironment(hdr.hdr_path).then((environment) => {
            state.environment = environment;
            // We need to wait until the environment is loaded to redraw
            redraw = true;
        });
    });

    uiModel.attachGltfLoaded(gltfLoaded);
    // The breakdown names nodes and materials, so it is rebuilt when either the report or the
    // model arrives (the validator often finishes after the model on large files).
    let latestValidationReport = undefined;
    function refreshValidationSummary() {
        app.validationSummary = summarizeValidation(latestValidationReport, state.gltf);
    }
    uiModel.updateValidationReport(
        validation.pipe(
            tap((report) => {
                latestValidationReport = report;
                refreshValidationSummary();
            })
        )
    );
    uiModel.updateStatistics(statisticsUpdateObservable);

    // Smooths discrete drag/scroll input deltas into per-frame motion.
    // Each input delta becomes a short pulse that fades in then out following
    // easeInOutSine, so motion accelerates and decelerates smoothly instead of
    // snapping with raw mousemove/wheel timing.
    const dragSmoother = (() => {
        let smoothMs = 330;
        const easeInOutSine = (t) => 0.5 * (1 - Math.cos(Math.PI * t));
        const orbitPulses = [];
        const panPulses = [];
        const zoomPulses = [];
        const isEnabled = () => state.cameraNodeIndex === undefined;
        const push = (pulses, a, b) => {
            if (!isEnabled()) return;
            pulses.push({ a, b, startTime: performance.now(), appliedA: 0, appliedB: 0 });
        };
        const drain = (pulses, applyFn) => {
            if (pulses.length === 0) return false;
            const now = performance.now();
            let netA = 0;
            let netB = 0;
            for (let i = pulses.length - 1; i >= 0; i--) {
                const p = pulses[i];
                const t = smoothMs > 0 ? Math.min(1, (now - p.startTime) / smoothMs) : 1;
                const eased = easeInOutSine(t);
                const targetA = p.a * eased;
                const targetB = p.b * eased;
                netA += targetA - p.appliedA;
                netB += targetB - p.appliedB;
                p.appliedA = targetA;
                p.appliedB = targetB;
                if (t >= 1) pulses.splice(i, 1);
            }
            const moved = netA !== 0 || netB !== 0;
            if (moved) applyFn(netA, netB);
            return moved || pulses.length > 0;
        };
        return {
            pushOrbit: (dPhi, dTheta) => push(orbitPulses, dPhi, dTheta),
            pushPan: (dX, dY) => push(panPulses, dX, dY),
            pushZoom: (dZoom) => push(zoomPulses, dZoom, 0),
            setSmoothMs: (ms) => { smoothMs = Math.max(0, ms); },
            tick: () => {
                const o = drain(orbitPulses, (a, b) => state.userCamera.orbit(a, b));
                const p = drain(panPulses, (a, b) => state.userCamera.pan(a, b));
                const z = drain(zoomPulses, (a) => state.userCamera.zoomBy(a));
                return o || p || z;
            }
        };
    })();

    uiModel.orbit.subscribe((orbit) =>
        dragSmoother.pushOrbit(orbit.deltaPhi, orbit.deltaTheta)
    );
    listenForRedraw(uiModel.orbit);

    uiModel.pan.subscribe((pan) => dragSmoother.pushPan(pan.deltaX, -pan.deltaY));
    listenForRedraw(uiModel.pan);

    uiModel.zoom.subscribe((zoom) => dragSmoother.pushZoom(zoom.deltaZoom));
    listenForRedraw(uiModel.zoom);

    uiModel.inputSmoothingEnabled.subscribe((enabled) => dragSmoother.setSmoothMs(enabled ? 330 : 0));

    listenForRedraw(gltfLoaded);

    uiModel.selection.subscribe((selection) => {
        const devicePixelRatio = window.devicePixelRatio || 1;
        state.selectionPositions[0].x = Math.floor(selection.x * devicePixelRatio);
        state.selectionPositions[0].y = Math.floor(selection.y * devicePixelRatio);
        state.triggerSelection = true;
        selectionAdditive = selection.additive === true;
        selectionHide = selection.hide === true;
    });
    listenForRedraw(uiModel.selection);

    uiModel.moveSelection.subscribe((selection) => {
        if (selection.x === undefined || selection.y === undefined) {
            state.hoverPositions[0].x = undefined;
            state.hoverPositions[0].y = undefined;
            return;
        }
        const devicePixelRatio = window.devicePixelRatio || 1;
        state.hoverPositions[0].x = Math.floor(selection.x * devicePixelRatio);
        state.hoverPositions[0].y = Math.floor(selection.y * devicePixelRatio);
    });
    listenForRedraw(uiModel.moveSelection);

    // Folder picker and permission prompts need the click's user activation, so these
    // handlers must call into TextureFolders synchronously (no await before it).
    uiModel.textureFolderAdd.subscribe(async () => {
        try {
            const result = await textureFolders.add();
            if (result === "added") {
                app.$buefy.toast.open({
                    message: "Texture folder added. Reload the model to use it.",
                    type: "is-info"
                });
            } else if (result === "duplicate") {
                app.warn("That folder is already in the list.");
            }
        } catch (error) {
            console.error("Adding a texture folder failed", error);
            app.error(`The folder could not be added: ${error?.name ?? "Error"}: ${error?.message ?? error}`, 10000);
        }
    });
    uiModel.textureFolderAccess.subscribe(() => textureFolders.requestAccess());
    uiModel.textureFolderRemove.subscribe((id) => textureFolders.remove(id));
    uiModel.textureFolderMove.subscribe(({ id, offset }) => textureFolders.move(id, offset));
    uiModel.textureFolderRescan.subscribe((id) => textureFolders.rescan(id));

    // MSFS packages (Models tab, package mode): a preset's attachments are merged into one glTF
    // (logic/msfs_package.js) and loaded like any other model. State: msfsPackage (top).
    app.loadModeChanged.subscribe((mode) => (app.loadMode = mode));

    // Lists the presets; one is loaded when the user clicks Load, or right away for a ?preset=
    // URL parameter (autoLoad).
    async function openPackages(load, sourceLabel, autoLoad = false) {
        const generation = ++msfsPackage.loading;
        app.packageError = "";
        app.packageStatus = "Opening package…";
        app.packageSource = sourceLabel;
        app.packagePresets = [];
        app.selectedPackagePreset = "";
        app.loadedPackagePreset = "";
        app.packageLiveries = [];
        app.selectedPackageLivery = "";
        try {
            const packages = await load();
            if (generation !== msfsPackage.loading) {
                return;
            }
            app.packageStatus = "Looking for presets…";
            const presets = await findPresets(packages);
            if (generation !== msfsPackage.loading) {
                return;
            }
            msfsPackage.packages = packages;
            msfsPackage.presets = presets;
            app.packagePresets = presets.map(({ id, title, group }) => ({ id, title, group }));
            app.packageStatus = "";
            if (presets.length === 0) {
                const fileCount = packages.reduce((sum, files) => sum + files.paths.size, 0);
                console.info(
                    "MSFS package: no presets in",
                    packages.map((files) => `${files.label}: ${files.paths.size} files`),
                    msfsPackage.scannedFiles?.slice(0, 20)
                );
                if (msfsPackage.cfgBlocked) {
                    app.packageError =
                        `The browser doesn't let the viewer read the .cfg files in ${sourceLabel} (picked folders hide them). ` +
                        "Drop the folder onto the view instead, or open the package by URL.";
                    return;
                }
                app.packageError =
                    `No presets found in ${sourceLabel} (${msfsPackage.scannedCount ?? fileCount} files read, ` +
                    `${packages.length} package${packages.length === 1 ? "" : "s"} recognized). ` +
                    "Open a package (the folder with SimObjects), a SimObject folder or a project folder; " +
                    "presets are SimObjects/<category>/<name>/presets/<author>/<preset>/config/attached_objects.cfg.";
                return;
            }
            const wanted = autoLoad ? (new URLSearchParams(window.location.search).get("preset") ?? "").toLowerCase() : "";
            const wantedPreset = presets.find(
                (entry) => wanted !== "" && (entry.name.toLowerCase() === wanted || entry.title.toLowerCase() === wanted)
            );
            app.selectedPackagePreset = (wantedPreset ?? presets[0]).id;
            if (wantedPreset !== undefined) {
                await loadPreset(wantedPreset.id);
            } else {
                app.packageStatus =
                    `${presets.length} preset${presets.length === 1 ? "" : "s"} found. Choose one and click Load.`;
            }
        } catch (error) {
            console.error("Opening the package failed", error);
            app.packageStatus = "";
            app.packageError = error?.message ?? String(error);
        }
    }

    async function loadPreset(id) {
        const preset = msfsPackage.presets.find((entry) => entry.id === id);
        if (preset === undefined) {
            return;
        }
        const generation = ++msfsPackage.loading;
        app.packageError = "";
        app.packageStatus = `Reading the configuration of ${preset.title}…`;
        uiModel.goToLoadingState();
        try {
            const items = await buildPresetTree(preset);
            // Liveries whose required tags the preset has. The selection is kept while it is
            // available ("none" = without livery); otherwise ?livery= (once) or the first one.
            const liveries = (await findLiveries(preset, items)).filter((livery) => livery.available);
            const titleCount = (title) => liveries.filter((other) => other.title === title).length;
            const wantedLivery = (msfsPackage.liveryParam ?? "").toLowerCase();
            msfsPackage.liveryParam = undefined;
            const livery =
                app.selectedPackageLivery === NoLivery
                    ? undefined
                    : (liveries.find((entry) => entry.id === app.selectedPackageLivery) ??
                      liveries.find((entry) => wantedLivery !== "" &&
                          (entry.name.toLowerCase() === wantedLivery || entry.title.toLowerCase() === wantedLivery)) ??
                      liveries[0]);
            app.packageLiveries = liveries.map((entry) => ({
                id: entry.id,
                title: titleCount(entry.title) > 1 ? `${entry.title} (${entry.name})` : entry.title
            }));
            app.selectedPackageLivery = livery?.id ?? (liveries.length > 0 ? NoLivery : "");
            const json = await assemblePreset(
                preset,
                items,
                (done, total) => {
                    app.packageStatus = `Reading models ${done} / ${total}…`;
                },
                livery
            );
            if (generation !== msfsPackage.loading) {
                return;
            }
            msfsPackage.items = items;
            msfsPackage.byId = new Map(flattenTree(items).map(({ item }) => [item.id, item]));
            if (json.meshes === undefined) {
                // e.g. an SDK project's PackageSources: configs only, the models are elsewhere
                const hasModels = preset.files.list().some((path) => /\.gltf$/i.test(path));
                app.packageError = hasModels
                    ? "None of this preset's models were found (hover the ⚠ entries for details)."
                    : `${preset.files.label} has the configuration but no models (.gltf / .xml). ` +
                      "Open the built package instead (Packages\\<package name>, the folder with layout.json).";
            }
            if (msfsPackage.objectUrl !== undefined) {
                URL.revokeObjectURL(msfsPackage.objectUrl);
            }
            msfsPackage.objectUrl = URL.createObjectURL(
                new Blob([JSON.stringify(json)], { type: "model/gltf+json" })
            );
            app.packageStatus = "Loading textures and geometry…";
            app.loadedPackagePreset = id;
            msfsPackage.presetFiles = preset.files;
            msfsPackage.sourceTextures = json.extras?.msfsSourceTextures ?? {};
            uiModel.packageModels.next({ mainFile: msfsPackage.objectUrl, package: true, presetId: id });
        } catch (error) {
            console.error("Assembling the preset failed", error);
            app.packageStatus = "";
            app.packageError = error?.message ?? String(error);
            uiModel.exitLoadingState();
        }
    }

    function setupPackageTree(model) {
        if (!model?.package) {
            app.packageRows = [];
            return;
        }
        app.packageStatus = "";
        const kindLabels = { model: "model", merge: "merge", attachment: "part" };
        msfsPackage.parents = new Map();
        state.gltf.nodes.forEach((node, index) =>
            node.children.forEach((child) => msfsPackage.parents.set(child, index))
        );
        app.packageRows = flattenTree(msfsPackage.items).map(({ item, depth }) => {
            const lines = [
                item.note,
                item.path,
                item.node !== undefined ? `Attached to node ${item.node} (${item.model})` : `In the ${item.model} model`,
                item.inherits ? `Inherits ${item.inherits}` : undefined,
                item.texture ? `Texture variant: texture.${item.texture}` : undefined,
                item.tags?.length ? `Tags: ${item.tags.join(", ")}` : undefined,
                ...item.gltfs.map((gltf) => `glTF: ${gltf}`),
                ...item.problems.map((problem) => `⚠ ${problem}`)
            ];
            return {
                id: item.id,
                depth,
                name: item.name,
                kind: item.external ? "external" : item.kind,
                kindLabel: item.external ? "sim" : kindLabels[item.kind],
                visible: true,
                shown: true,
                problems: item.problems,
                hasChildren: item.children.length > 0,
                title: lines.filter((line) => line).join("\n")
            };
        });
        app.packageCollapsed = {};
        const problems = app.packageRows.filter((row) => row.problems.length > 0).length;
        if (problems > 0) {
            app.packageStatus = `${problems} entries have problems (⚠, hover for details).`;
        }
    }

    // Hiding an entry hides everything configured below it too.
    app.packageAttachmentToggled.subscribe(({ id, visible }) => {
        const item = msfsPackage.byId.get(id);
        if (item === undefined || state.gltf === undefined) {
            return;
        }
        const ids = new Set(flattenTree([item]).map(({ item: entry }) => entry.id));
        for (const entry of flattenTree([item]).map((row) => row.item)) {
            const extension = state.gltf.nodes[entry.wrapperNode]?.extensions?.KHR_node_visibility;
            if (extension !== undefined) {
                extension.visible = visible;
            }
        }
        // shown: not hidden by any node above it (attachments sit on nodes of other entries)
        const isShown = (nodeIndex) => {
            for (let node = nodeIndex; node !== undefined; node = msfsPackage.parents.get(node)) {
                if (state.gltf.nodes[node]?.extensions?.KHR_node_visibility?.visible === false) {
                    return false;
                }
            }
            return true;
        };
        app.packageRows = app.packageRows.map((row) => {
            const entry = msfsPackage.byId.get(row.id);
            return {
                ...row,
                visible: ids.has(row.id) ? visible : row.visible,
                shown: isShown(entry.wrapperNode)
            };
        });
        refreshShownMaterials();
        applyBehaviorVisibility(); // "hidden by a node above" states
        redraw = true;
    });
    app.packageAttachmentSelected.subscribe((id) => {
        const item = msfsPackage.byId.get(id);
        if (item?.wrapperNode !== undefined && state.gltf?.nodes[item.wrapperNode] !== undefined) {
            app.showInspectorNode(item.wrapperNode);
        }
    });
    app.packageLoadPreset.subscribe((id) => loadPreset(id));

    // ---------------------------------------------------------------- MSFS model behaviors
    // Behavior tab: the behaviors of the loaded package, expanded from the templates. The
    // visibility codes hide nodes with KHR_node_visibility, so a hidden node hides its children
    // like in the sim. Variable values are kept across preset reloads.
    const behavior = { data: undefined, rows: [], store: new VariableStore(), generation: 0 };

    async function setupBehaviors(model) {
        const generation = ++behavior.generation;
        behavior.data = undefined;
        behavior.rows = [];
        app.behaviorVisibility = [];
        app.behaviorVariables = [];
        app.behaviorProblems = [];
        app.behaviorFocus = "";
        const preset = model?.package ? msfsPackage.presets.find((entry) => entry.id === model.presetId) : undefined;
        app.behaviorAvailable = preset !== undefined;
        if (preset === undefined) {
            app.behaviorStatus = "";
            return;
        }
        app.behaviorStatus = "Expanding the behavior templates…";
        const gltf = state.gltf;
        const nodes = gltf.nodes.map((node) => ({ name: node.name, children: node.children }));
        let data;
        try {
            data = await buildBehaviors(preset, msfsPackage.items, nodes, (done, total) => {
                if (generation === behavior.generation) {
                    app.behaviorStatus = `Expanding the behavior templates ${done} / ${total}…`;
                }
            });
        } catch (error) {
            console.error("Expanding the behaviors failed", error);
            if (generation === behavior.generation) {
                app.behaviorStatus = `Expanding the behaviors failed: ${error.message}`;
            }
            return;
        }
        if (generation !== behavior.generation || state.gltf !== gltf) {
            return;
        }
        behavior.data = data;
        app.behaviorProblems = data.problems;
        app.behaviorStatus = data.visibility.length === 0 ? "The behaviors of this preset have no visibility codes." : "";
        behavior.rows = data.visibility.map((entry) => {
            const item = msfsPackage.byId.get(entry.itemId);
            return {
                id: entry.id,
                groupId: entry.itemId,
                groupName: entry.itemName,
                groupTitle: item?.path ?? entry.itemName,
                node: entry.node,
                nodeName: entry.nodeName,
                nodeTitle: entry.node === undefined
                    ? `${entry.nodeName}: no node with this name in ${entry.itemName}`
                    : `${entry.nodeName} (component ${entry.componentId})\nClick: show in the Inspector`,
                code: entry.code,
                keys: [...new Set(entry.program.references.filter((ref) => !ref.write).map((ref) => ref.key))]
            };
        });
        refreshBehaviorVariables();
        applyBehaviorVisibility();
    }

    function refreshBehaviorVariables() {
        const data = behavior.data;
        if (data === undefined) {
            app.behaviorVariables = [];
            return;
        }
        app.behaviorVariables = data.variables.map((variable) => {
            const label = variable.index !== "" ? `${variable.name}:${variable.index}` : variable.name;
            const reference = `(${variable.kind}:${label}${variable.unit ? ", " + variable.unit : ""})`;
            const users = variable.users.length;
            return {
                key: variable.key,
                kind: variable.kind,
                label,
                title: [
                    reference,
                    `Read by ${users} visibility code${users === 1 ? "" : "s"} (click: list them)`,
                    variable.values.length > 0 ? `Compared with ${variable.values.join(", ")}` : undefined
                ].filter((line) => line).join("\n"),
                users,
                boolean: variable.boolean,
                values: variable.values,
                value: Number(behavior.store.valueOf(variable.key)) || 0
            };
        });
    }

    /** Evaluates the visibility codes and shows / hides their nodes. */
    function applyBehaviorVisibility() {
        const data = behavior.data;
        if (data === undefined || state.gltf === undefined) {
            return;
        }
        const results = evaluateVisibility(data, behavior.store);
        for (const [nodeIndex, visible] of results) {
            const node = state.gltf.nodes[nodeIndex];
            if (node === undefined) {
                continue;
            }
            node.extensions ??= {};
            node.extensions.KHR_node_visibility ??= { visible: true };
            node.extensions.KHR_node_visibility.visible = app.behaviorApply ? visible : true;
        }
        // hidden by a node above it (another code, or an attachment switched off in the Models tab)
        const hiddenAbove = (nodeIndex) => {
            for (let node = msfsPackage.parents.get(nodeIndex); node !== undefined; node = msfsPackage.parents.get(node)) {
                if (state.gltf.nodes[node]?.extensions?.KHR_node_visibility?.visible === false) {
                    return true;
                }
            }
            return false;
        };
        app.behaviorVisibility = behavior.rows.map((row) => {
            const entry = data.visibility[row.id];
            let rowState = "shown";
            let stateTitle = "Shown: the code is not 0";
            if (entry.node === undefined) {
                rowState = "missing";
                stateTitle = "The node was not found, the code has no effect";
            } else if (!entry.visible) {
                rowState = "hidden";
                stateTitle = app.behaviorApply ? "Hidden: the code is 0" : "The code is 0 (not applied)";
            } else if (hiddenAbove(entry.node)) {
                rowState = "parent";
                stateTitle = "The code is not 0, but a node above it is hidden";
            }
            return {
                ...row,
                state: rowState,
                stateTitle,
                codeTitle: `${entry.code}\n= ${entry.value}${entry.error ? "\n⚠ " + entry.error : ""}`
            };
        });
        refreshShownMaterials();
        redraw = true;
    }

    app.behaviorVariableChanged.subscribe(({ key, value }) => {
        behavior.store.setKey(key, value);
        app.behaviorVariables = app.behaviorVariables.map((variable) =>
            variable.key === key ? { ...variable, value } : variable
        );
        applyBehaviorVisibility();
    });
    app.behaviorApplyChanged.subscribe((apply) => {
        app.behaviorApply = apply;
        applyBehaviorVisibility();
    });
    app.behaviorVariablesReset.subscribe(() => {
        behavior.store.values.clear();
        refreshBehaviorVariables();
        applyBehaviorVisibility();
    });
    // a different livery reloads the shown preset with it
    app.packageLiveryChanged.subscribe((id) => {
        app.selectedPackageLivery = id;
        if (app.loadedPackagePreset !== "") {
            loadPreset(app.loadedPackagePreset);
        }
    });
    app.packageOpenUrl.subscribe((url) => {
        url = url.trim();
        if (url !== "") {
            msfsPackage.scannedCount = undefined;
            msfsPackage.scannedFiles = undefined;
            releaseVirtualFiles();
            openPackages(() => PackageFiles.fromUrl(url), url);
        }
    });
    // The folder picker needs the click's user activation: no await before it.
    app.packageOpenFolder.subscribe(() => {
        const picked = window.showDirectoryPicker({ id: "msfsPackage", mode: "read" });
        picked.then(
            (handle) => {
                releaseVirtualFiles();
                openPackages(async () => {
                    const entries = await scanDirectory(handle, (count) => {
                        app.packageStatus = `Listing files… ${count}`;
                    });
                    msfsPackage.scannedCount = entries.length;
                    msfsPackage.scannedFiles = entries.map(([path]) => path);
                    msfsPackage.cfgBlocked = entries.cfgHidden && entries.cfgProbed === 0;
                    if (entries.failedFolders.length > 0) {
                        app.warn(
                            `${entries.failedFolders.length} folders could not be read: ${entries.failedFolders.slice(0, 3).join("; ")}`
                        );
                    }
                    return PackageFiles.fromFiles(entries, handle.name);
                }, handle.name);
            },
            (error) => {
                if (error?.name !== "AbortError") {
                    app.packageError = `The folder could not be opened: ${error?.message ?? error}`;
                }
            }
        );
    });
    uiModel.droppedPackage.subscribe((files) => {
        const entries = files.map(([path, file]) => [path.replaceAll("\\", "/").replace(/^\//, ""), file]);
        const top = entries[0]?.[0].split("/")[0] ?? "dropped files";
        msfsPackage.scannedCount = entries.length;
        msfsPackage.scannedFiles = entries.map(([path]) => path);
        msfsPackage.cfgBlocked = false;
        releaseVirtualFiles();
        openPackages(async () => PackageFiles.fromFiles(entries, top), top);
    });
    {
        const packageParam = new URLSearchParams(window.location.search).get("package");
        if (packageParam !== null) {
            app.loadMode = "package";
            app.packageUrl = packageParam;
            openPackages(() => PackageFiles.fromUrl(packageParam), packageParam, true);
        }
    }

    // Tinted nodes and materials come from several tabs; only the open tab's tint is shown.
    // Selections are kept, so the tint comes back when the tab is opened again.
    const highlights = {
        inspectorNodes: new Set(),
        animationNodes: new Set(),
        materialsMaterials: new Set(),
        animationMaterials: new Set()
    };
    function refreshHighlights() {
        const empty = new Set();
        state.highlightedNodeIndices = new Set([
            ...(app.inspectorOpen ? highlights.inspectorNodes : empty),
            ...(app.animationsOpen ? highlights.animationNodes : empty)
        ]);
        state.highlightedMaterialIndices = new Set([
            ...(app.materialsOpen ? highlights.materialsMaterials : empty),
            ...(app.animationsOpen ? highlights.animationMaterials : empty)
        ]);
        redraw = true;
    }
    app.$watch(() => [app.inspectorOpen, app.materialsOpen, app.animationsOpen].join(), refreshHighlights);

    // Inspector: the selected node (and its subtree) is tinted in the view. While the tab is
    // open, clicking the model selects the part under the cursor; clicking empty space clears it.
    function setupInspector(gltf, sceneIndex) {
        app.inspectorNodes = buildNodeTree(gltf, sceneIndex);
        app.inspectorMaterialSummary = getMsfsMaterialSummary(gltf);
        app.inspectorFilter = "";
        const expanded = {};
        for (const row of app.inspectorNodes) {
            expanded[row.index] = row.depth < 1;
        }
        app.inspectorExpanded = expanded;
        selectInspectorNode(undefined);
    }

    function selectInspectorNode(index) {
        app.inspectorSelected = index;
        if (index === undefined || state.gltf?.nodes[index] === undefined) {
            app.inspectorSelected = undefined;
            app.inspectorDetails = [];
            highlights.inspectorNodes = new Set();
        } else {
            app.inspectorDetails = getNodeDetails(state.gltf, index);
            highlights.inspectorNodes = collectSubtree(state.gltf, index);
        }
        refreshHighlights();
    }

    uiModel.inspectorSelection.subscribe((index) => selectInspectorNode(index));

    // Highlight colour (Display tab): the picker gives sRGB, the shader blends in linear space.
    // Remembered per browser; storage may be unavailable (private mode), so it is optional.
    const HighlightStorageKey = "highlight";
    const LegacyHighlightStorageKey = "inspectorHighlight";
    const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const applyHighlight = ({ color, strength }) => {
        const match = /^#([0-9a-f]{6})$/i.exec(color ?? "");
        if (!match || !(strength >= 0 && strength <= 1)) {
            return false;
        }
        const value = parseInt(match[1], 16);
        state.renderingParameters.highlightColor = [16, 8, 0].map((shift) =>
            srgbToLinear(((value >> shift) & 0xff) / 255)
        );
        state.renderingParameters.highlightStrength = strength;
        app.highlightColor = color.toLowerCase();
        app.highlightStrength = strength;
        return true;
    };
    try {
        const stored =
            window.localStorage.getItem(HighlightStorageKey) ??
            window.localStorage.getItem(LegacyHighlightStorageKey);
        applyHighlight(JSON.parse(stored) ?? {});
    } catch {
        // keep the default highlight
    }
    uiModel.highlight.subscribe((highlight) => {
        if (!applyHighlight(highlight)) {
            return;
        }
        try {
            window.localStorage.setItem(HighlightStorageKey, JSON.stringify(highlight));
        } catch {
            // not remembered, still applied
        }
    });
    listenForRedraw(uiModel.highlight);

    uiModel.inspectorFocus.subscribe((index) => {
        if (state.gltf === undefined || state.cameraNodeIndex !== undefined) {
            return;
        }
        state.userCamera.focusOnNode(state.gltf, index);
        redraw = true;
    });

    // Ctrl/Cmd/Shift held on the last viewport click (see uiModel.selection)
    let selectionAdditive = false;
    // Alt held on the last viewport click
    let selectionHide = false;
    state.selectionCallback = (pickingResult) => {
        if (app.animationsOpen && app.msfsAnimationMode) {
            const nodeIndex = pickingResult.node?.gltfObjectIndex;
            if (nodeIndex === undefined) {
                // A click into empty space clears the selection, unless it was meant to add.
                if (!selectionAdditive) {
                    selectMsfsAnimations([]);
                }
                return;
            }
            const found = findAnimationsForNode(state.gltf, app.msfsAnimations, nodeIndex);
            const name = state.gltf.nodes[nodeIndex].name ?? `Node ${nodeIndex}`;
            if (selectionAdditive) {
                // Add the part's animations; Ctrl-clicking a part whose animations are all
                // selected already removes them again.
                const current = app.msfsAnimationSelected;
                const allSelected = found.length > 0 && found.every((index) => current.includes(index));
                selectMsfsAnimations(
                    allSelected
                        ? current.filter((index) => !found.includes(index))
                        : [...current, ...found.filter((index) => !current.includes(index))]
                );
            } else {
                selectMsfsAnimations(found);
            }
            app.msfsAnimationPickInfo = found.length === 0 ? `No animation moves ${name}.` : "";
            if (found.length > 0) {
                app.revealMsfsAnimations(found);
            }
            return;
        }
        if (app.materialsOpen) {
            const mesh = state.gltf.meshes[pickingResult.node?.mesh];
            const material = mesh?.primitives[pickingResult.primitiveIndex]?.material;
            // Alt-click hides the part's material; the selection stays as it is.
            if (selectionHide) {
                if (material !== undefined) {
                    setHiddenMaterials([...app.materialsHidden, material]);
                }
                return;
            }
            // While isolated, a click next to the part should not bring everything back.
            if (material === undefined && app.materialIsolate) {
                return;
            }
            selectMaterial(material);
            if (material !== undefined) {
                app.revealMaterial(material);
            }
            return;
        }
        if (!app.inspectorOpen) {
            return;
        }
        const index = pickingResult.node?.gltfObjectIndex;
        selectInspectorNode(index);
        if (index !== undefined) {
            app.revealInspectorNode(index);
        }
    };

    // Materials tab: the selected material's parts are tinted (or shown alone), its textures are
    // read back from the GPU for thumbnails and the texture viewer, and it can be edited like the
    // 3ds Max MSFS material (logic/msfs_material_model.js): every change is written back to glTF
    // material JSON and replaces the material in the renderer; Save writes the edited materials
    // into their files (logic/material_save.js).
    const materialDocs = new Map(); // material index -> { model, changed: Set } of edited materials
    let materialEditQueue = Promise.resolve();
    let materialSlots = []; // [{slot, bound}] of the selected material; bound is the renderer's textureInfo
    let materialUsage = new Map();
    let thumbnails = new Map(); // texture index -> data URL, for the loaded glTF

    function setupMaterials(gltf) {
        materialDocs.clear();
        app.materialEditedCount = 0;
        thumbnails = new Map();
        materialUsage = getMaterialUsage(gltf);
        // MSFS packages: group by the entry (sub model) a material comes from, in tree order
        const order = new Map(flattenTree(msfsPackage.items).map(({ item }, index) => [item.id, index]));
        const groupOf = (material) => {
            const item = msfsPackage.byId.get(material.extras?.msfsPackageItem);
            if (item === undefined) {
                return undefined;
            }
            const names = [];
            for (let entry = item; entry !== undefined; entry = entry.parent) {
                // attachments are often named like the models (e.g. a cabin called "Interior")
                names.unshift(entry.kind === "model" ? `${entry.name} (model)` : entry.name);
            }
            return { key: item.id, label: names.join(" › "), order: order.get(item.id) ?? 0 };
        };
        app.materialsList = buildMaterialList(gltf, groupOf);
        app.materialsCollapsed = {};
        refreshShownMaterials();
        app.materialsFilter = "";
        app.materialEditedCount = 0;
        setHiddenMaterials([]);
        closeTextureViewer();
        selectMaterial(undefined);
    }

    /** Materials of the parts not hidden with KHR_node_visibility (MSFS package toggles). */
    function refreshShownMaterials() {
        app.materialsShown = state.gltf === undefined ? [] : [...getShownMaterials(state.gltf, state.sceneIndex ?? 0)];
    }

    function setHiddenMaterials(indices) {
        app.materialsHidden = [...new Set(indices)];
        // A new set each time: the renderer rebuilds its draw lists when the reference changes.
        state.hiddenMaterialIndices = new Set(app.materialsHidden);
        redraw = true;
    }

    function pixelsToDataUrl({ width, height, pixels }) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
        return canvas.toDataURL();
    }

    function getThumbnail(textureIndex) {
        if (textureIndex === undefined) {
            return undefined;
        }
        if (!thumbnails.has(textureIndex)) {
            const result = view.readTexture(state, textureIndex, 128);
            thumbnails.set(textureIndex, result === undefined ? undefined : pixelsToDataUrl(result));
        }
        return thumbnails.get(textureIndex);
    }

    function applyMaterialView() {
        const index = app.materialsSelected;
        highlights.materialsMaterials = index !== undefined && app.materialHighlight ? new Set([index]) : new Set();
        // A new set each time: the renderer rebuilds its draw lists when the reference changes.
        state.isolatedMaterialIndices =
            index !== undefined && app.materialIsolate ? new Set([index]) : undefined;
        refreshHighlights();
    }

    function refreshMaterialDetails() {
        const index = app.materialsSelected;
        const gltf = state.gltf;
        materialSlots = getMaterialTextureSlots(gltf, index);
        app.materialTextures = materialSlots.map(({ slot }) => ({ ...slot, thumbnail: getThumbnail(slot.textureIndex) }));
        app.materialEditor = buildEditorFor(index);
        app.materialEdited =
            (materialDocs.get(index)?.changed.size ?? 0) > 0 || materialSlots.some(({ slot }) => slot.status === "off");
        app.materialEditedCount = [...materialDocs.values()].filter((doc) => doc.changed.size > 0).length;
        const material = gltf.materials[index];
        const otherExtensions = Object.keys(material.extensions ?? {}).filter((name) => !name.startsWith("ASOBO_"));
        const info = [...(materialSections(gltf, index)[0]?.rows ?? [])];
        if (material.alphaMode === "MASK") {
            info.splice(1, 0, ["Alpha cutoff", String(material.alphaCutoff)]);
        }
        if (otherExtensions.length > 0) {
            info.push(["Extensions", otherExtensions.join(", ")]);
        }
        app.materialInfo = info;
        app.materialUsers = [...(materialUsage.get(index) ?? new Map())].map(([nodeIndex, primitives]) => ({
            nodeIndex,
            name: nodeTitle(gltf.nodes[nodeIndex], nodeIndex),
            primitives: primitives.length
        }));
    }

    function selectMaterial(index) {
        if (index !== undefined && state.gltf?.materials[index] === undefined) {
            index = undefined;
        }
        app.materialsSelected = index;
        if (index === undefined) {
            materialSlots = [];
            app.materialTextures = [];
            app.materialEditor = undefined;
            app.materialUsers = [];
            app.materialInfo = [];
            app.materialEdited = false;
        } else {
            refreshMaterialDetails();
        }
        applyMaterialView();
    }

    uiModel.materialSelection.subscribe((index) => selectMaterial(index));
    uiModel.materialView.subscribe(() => applyMaterialView());
    uiModel.materialHidden.subscribe((indices) => setHiddenMaterials(indices));

    const isMsfsGltf = (gltf) =>
        (gltf.extensionsUsed ?? []).some((name) => name.startsWith("ASOBO_")) ||
        gltf.asset?.extensions?.ASOBO_normal_map_convention !== undefined;
    // the material as loaded (package: with the viewer's extras, livery tint)
    const loadedMaterialJson = (index) => state.gltf?.sourceMaterialsJson?.[index];
    const materialModel = (index) =>
        materialDocs.get(index)?.model ?? readMaterial(loadedMaterialJson(index), isMsfsGltf(state.gltf));

    // Package materials can only use textures of their own file (saving maps the indices back).
    function sourceTexturesOf(index) {
        const path = loadedMaterialJson(index)?.extras?.msfsSource?.path;
        return path === undefined ? undefined : msfsPackage.sourceTextures?.[path];
    }
    function textureLabel(textureIndex) {
        const texture = state.gltf.textures[textureIndex];
        const image = state.gltf.images[texture?.source];
        const uri = typeof image?.uri === "string" ? decodeURIComponent(image.uri.split(/[\\/]/).pop()) : undefined;
        return uri ?? image?.name ?? texture?.name ?? `texture ${textureIndex}`;
    }
    function buildEditorFor(index) {
        if (loadedMaterialJson(index) === undefined) {
            return undefined; // the renderer's default material
        }
        const gltf = state.gltf;
        const fileTextures = sourceTexturesOf(index);
        const indices = fileTextures ? [...new Set(fileTextures)] : gltf.textures.map((_, i) => i);
        const textureChoices = indices
            .map((textureIndex) => ({ index: textureIndex, label: textureLabel(textureIndex) }))
            .sort((a, b) => a.label.localeCompare(b.label));
        const describeTexture = (textureIndex) => {
            const slot = materialSlots.find((entry) => entry.slot.textureIndex === textureIndex)?.slot;
            const image = gltf.images[gltf.textures[textureIndex]?.source];
            return {
                file: textureLabel(textureIndex),
                thumbnail: image?.isLoaded() ? getThumbnail(textureIndex) : undefined,
                status: slot?.status ?? (image?.isLoaded() ? "ok" : "missing"),
                viewerId: slot?.id,
                rows: slot?.rows
            };
        };
        return buildMaterialEditor(materialModel(index), {
            msfs: isMsfsGltf(gltf),
            changed: materialDocs.get(index)?.changed,
            describeTexture,
            textureChoices
        });
    }

    // Applies an edit to the selected material: model -> glTF JSON -> renderer. Edits run one
    // after the other (replacing a material may upload textures).
    function editSelectedMaterial(edit) {
        const index = app.materialsSelected;
        if (index === undefined || loadedMaterialJson(index) === undefined) {
            return;
        }
        materialEditQueue = materialEditQueue.then(async () => {
            let doc = materialDocs.get(index);
            if (doc === undefined) {
                doc = { model: materialModel(index), changed: new Set() };
                materialDocs.set(index, doc);
            }
            edit(doc.model, doc.changed);
            await view.replaceMaterial(state, index, writeMaterial(doc.model));
            materialUsage = getMaterialUsage(state.gltf);
            if (app.materialsSelected === index) {
                refreshMaterialDetails();
            }
            redraw = true;
        }).catch((error) => {
            console.error("Editing the material failed", error);
            app.error(`Editing the material failed: ${error?.message ?? error}`);
        });
    }

    const ColorParams = new Set(["baseColor", "emissive", "SSSColor"]);
    app.materialParamChanged.subscribe(({ param, value }) => {
        editSelectedMaterial((model, changed) => {
            if (param === "baseColorAlpha") {
                model.params.baseColor = [...model.params.baseColor.slice(0, 3), value];
                changed.add("baseColor");
                return;
            }
            if (ColorParams.has(param)) {
                const rgb = hexToLinear(value);
                const old = model.params[param];
                model.params[param] = old.length > 3 ? [...rgb, ...old.slice(3)] : rgb;
            } else if (param === "glassWidth") {
                model.params.glassWidth = value / 1000; // shown in millimeters
            } else {
                model.params[param] = value;
            }
            changed.add(param);
        });
    });
    app.materialTypeChanged.subscribe((type) => {
        editSelectedMaterial((model, changed) => {
            changed.add("type");
            setMaterialType(model, type).forEach((param) => changed.add(param));
        });
    });
    app.materialTextureAssigned.subscribe(({ slot, textureIndex }) => {
        editSelectedMaterial((model, changed) => {
            if (textureIndex === undefined || textureIndex === "" || textureIndex === null) {
                delete model.textures[slot];
            } else {
                const kept = model.textures[slot];
                // the UV2 occlusion map uses texture coordinates 1 (see the exporter)
                model.textures[slot] = { ...(kept ?? {}), index: Number(textureIndex), texCoord: slot === "Occlusion" ? 1 : (kept?.texCoord ?? 0) };
                if (model.textures[slot].texCoord === 0) delete model.textures[slot].texCoord;
            }
            changed.add(`texture:${slot}`);
        });
    });

    // Saving: the edited materials into their files, diff based (materialForSource)
    async function readModelFile(path) {
        if (loadedModelSource?.package) {
            return await msfsPackage.presetFiles.text(path);
        }
        const mainFile = loadedModelSource?.mainFile;
        const file = Array.isArray(mainFile) ? mainFile[1] : mainFile;
        if (typeof file === "string") {
            const response = await fetch(file);
            if (!response.ok) throw new Error(`${file}: ${response.status}`);
            return await response.text();
        }
        return await file.text();
    }
    function modelFileName() {
        const mainFile = loadedModelSource?.mainFile;
        if (Array.isArray(mainFile)) return mainFile[0].split("/").pop();
        if (typeof mainFile === "string") return decodeURIComponent(mainFile.split(/[?#]/)[0].split("/").pop());
        return mainFile?.name ?? "model.gltf";
    }
    async function buildSavedFiles() {
        const byFile = new Map(); // path -> [{ sourceIndex, doc, toSource }]
        for (const [index, doc] of materialDocs) {
            if (doc.changed.size === 0) continue;
            let path = modelFileName();
            let sourceIndex = index;
            let toSource = (textureIndex) => textureIndex;
            if (loadedModelSource?.package) {
                const source = loadedMaterialJson(index)?.extras?.msfsSource;
                if (source === undefined) throw new Error(`Material ${index} has no source file`);
                path = source.path;
                sourceIndex = source.index;
                const map = msfsPackage.sourceTextures[path] ?? [];
                toSource = (textureIndex) => {
                    const found = map.indexOf(textureIndex);
                    return found < 0 ? undefined : found;
                };
            }
            if (!byFile.has(path)) byFile.set(path, []);
            byFile.get(path).push({ sourceIndex, doc, toSource });
        }
        const files = [];
        for (const [path, entries] of byFile) {
            const text = await readModelFile(path);
            const json = JSON.parse(text);
            const materials = new Map(
                entries.map(({ sourceIndex, doc, toSource }) => [
                    sourceIndex,
                    materialForSource(json.materials[sourceIndex], doc.model, doc.changed, toSource)
                ])
            );
            files.push({ path, text: replaceMaterialsInText(text, materials).text, count: entries.length });
        }
        return files;
    }
    let saveDirectory = undefined; // the folder chosen for "Save to folder" (this session)
    app.materialSaveRequested.subscribe(async (mode) => {
        try {
            const files = await buildSavedFiles();
            if (files.length === 0) {
                app.warn("No edited materials to save.");
                return;
            }
            const materialCount = files.reduce((sum, file) => sum + file.count, 0);
            if (mode === "download") {
                files.forEach(({ path, text }) => downloadText(path.split("/").pop(), text));
                app.info(`Downloaded ${files.length} file(s) with ${materialCount} edited material(s).`);
                return;
            }
            if (typeof window.showDirectoryPicker !== "function") {
                app.error("This browser cannot write files into folders; use Download.");
                return;
            }
            const permission = saveDirectory && (await saveDirectory.requestPermission({ mode: "readwrite" }));
            if (permission !== "granted") {
                saveDirectory = await window.showDirectoryPicker({ id: "msfs-material-save", mode: "readwrite" });
            }
            // package: paths are relative to the package root; single file: its folder
            const written = await writeFilesToDirectory(
                saveDirectory,
                files.map(({ path, text }) => ({ path: loadedModelSource?.package ? path : path.split("/").pop(), text }))
            );
            app.info(`Saved ${materialCount} material(s) into ${written.length} file(s) in ${saveDirectory.name} (with .bak copies).`);
        } catch (error) {
            if (error?.name === "AbortError") return; // picker cancelled
            console.error("Saving the materials failed", error);
            app.error(`Saving failed: ${error?.message ?? error}`, 10000);
        }
    });

    uiModel.materialTextureToggle.subscribe(({ id, enabled }) => {
        const entry = materialSlots.find(({ slot }) => slot.id === id);
        if (entry?.bound === undefined) {
            return;
        }
        entry.bound.debugDisabled = !enabled;
        refreshMaterialDetails();
        redraw = true;
    });

    uiModel.materialReset.subscribe((index) => {
        materialEditQueue = materialEditQueue.then(async () => {
            if (materialDocs.has(index)) {
                materialDocs.delete(index);
                await view.replaceMaterial(state, index, loadedMaterialJson(index));
            }
            for (const { bound } of materialSlots) {
                if (bound !== undefined) bound.debugDisabled = false;
            }
            refreshMaterialDetails();
            redraw = true;
        });
    });

    // Texture viewer
    let viewerResult = undefined; // {width, height, pixels} read back at textureViewer.maxSize

    function closeTextureViewer() {
        app.textureViewer.open = false;
        viewerResult = undefined;
    }

    function drawTextureViewer() {
        const canvas = document.getElementById("textureViewerCanvas");
        if (canvas === null || viewerResult === undefined) {
            return;
        }
        const { width, height, pixels } = viewerResult;
        canvas.width = width;
        canvas.height = height;
        const out = new Uint8ClampedArray(pixels.length);
        const channel = app.textureViewer.channel;
        const single = { r: 0, g: 1, b: 2, a: 3 }[channel];
        for (let i = 0; i < pixels.length; i += 4) {
            if (single !== undefined) {
                out[i] = out[i + 1] = out[i + 2] = pixels[i + single];
                out[i + 3] = 255;
            } else {
                out[i] = pixels[i];
                out[i + 1] = pixels[i + 1];
                out[i + 2] = pixels[i + 2];
                out[i + 3] = channel === "rgba" ? pixels[i + 3] : 255;
            }
        }
        canvas.getContext("2d").putImageData(new ImageData(out, width, height), 0, 0);
        canvas.onmousemove = (event) => {
            const x = Math.min(width - 1, Math.floor((event.offsetX / canvas.clientWidth) * width));
            const y = Math.min(height - 1, Math.floor((event.offsetY / canvas.clientHeight) * height));
            const i = (y * width + x) * 4;
            const sourceX = Math.floor((x / width) * app.textureViewer.sourceWidth);
            const sourceY = Math.floor((y / height) * app.textureViewer.sourceHeight);
            const [r, g, b, a] = pixels.slice(i, i + 4);
            app.textureViewer.pixel = `x ${sourceX}, y ${sourceY}: R ${r} G ${g} B ${b} A ${a}`;
        };
        canvas.onmouseleave = () => (app.textureViewer.pixel = "");
    }

    function loadTextureViewer() {
        viewerResult = view.readTexture(state, app.textureViewer.textureIndex, app.textureViewer.maxSize);
        if (viewerResult === undefined) {
            closeTextureViewer();
            app.warn("The texture could not be read.");
            return;
        }
        Object.assign(app.textureViewer, {
            width: viewerResult.width,
            height: viewerResult.height,
            sourceWidth: viewerResult.sourceWidth,
            sourceHeight: viewerResult.sourceHeight
        });
        app.$nextTick(drawTextureViewer);
    }

    uiModel.materialTextureOpen.subscribe((id) => {
        if (typeof id === "object" && id?.textureIndex !== undefined) {
            Object.assign(app.textureViewer, {
                open: true,
                title: id.label,
                file: textureLabel(id.textureIndex),
                textureIndex: id.textureIndex,
                channelHints: getChannelHints(id.slotPath ?? ""),
                pixel: ""
            });
            loadTextureViewer();
            return;
        }
        const slot = materialSlots.find((entry) => entry.slot.id === id)?.slot;
        if (slot?.textureIndex === undefined) {
            return;
        }
        Object.assign(app.textureViewer, {
            open: true,
            title: slot.group ? `${slot.group} · ${slot.label}` : slot.label,
            file: slot.file,
            textureIndex: slot.textureIndex,
            channelHints: getChannelHints(slot.id),
            pixel: ""
        });
        loadTextureViewer();
    });

    uiModel.textureViewer.subscribe((change) => {
        if (change.open === false) {
            closeTextureViewer();
        } else if (change.channel !== undefined) {
            app.textureViewer.channel = change.channel;
            drawTextureViewer();
        } else if (change.maxSize !== undefined) {
            app.textureViewer.maxSize = change.maxSize;
            loadTextureViewer();
        }
    });

    window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && app.textureViewer.open) {
            closeTextureViewer();
        }
    });

    // MSFS animations: each animation is positioned by frame, like the sim variable driving it.
    // Active animations (scrubbed or playing) are evaluated at their own time via
    // state.animationTimeOverrides; all others stay in the rest pose. The dock controls the
    // selected animations together.
    function setupMsfsAnimations(gltf) {
        const fps = Msfs.detectMsfsFrameRate(gltf);
        app.msfsFrameRate = fps;
        app.msfsAnimationFilter = "";
        app.msfsAnimationActiveOnly = false;
        app.msfsAnimationGroupsOpen = {};
        app.msfsAnimations = buildMsfsAnimationEntries(gltf, fps);
        app.msfsAnimationMode = true;
        selectMsfsAnimations([]);
    }

    function applyMsfsAnimation(entry) {
        const others = state.animationIndices.filter((index) => index !== entry.index);
        if (entry.active) {
            state.animationTimeOverrides.set(entry.index, entry.frame / app.msfsFrameRate);
            state.animationIndices = [...others, entry.index];
        } else {
            state.animationTimeOverrides.delete(entry.index);
            state.animationIndices = others;
        }
        redraw = true;
    }

    const findMsfsAnimation = (index) => app.msfsAnimations.find((entry) => entry.index === index);
    const selectedMsfsEntries = () => app.msfsAnimationSelected.map(findMsfsAnimation).filter((entry) => entry !== undefined);

    function refreshMsfsAnimationHighlight() {
        const targets =
            app.msfsAnimationHighlight && state.gltf !== undefined
                ? getAnimatedTargets(state.gltf, selectedMsfsEntries())
                : { nodes: new Set(), materials: new Set() };
        highlights.animationNodes = targets.nodes;
        highlights.animationMaterials = targets.materials;
        refreshHighlights();
    }

    function selectMsfsAnimations(indices) {
        app.msfsAnimationSelected = indices;
        app.msfsAnimationPickInfo = "";
        refreshMsfsAnimationHighlight();
    }

    function setMsfsFrame(entry, frame) {
        entry.frame = Math.min(entry.maxFrame, Math.max(entry.minFrame, frame));
        entry.active = true;
        applyMsfsAnimation(entry);
    }

    uiModel.msfsAnimationSelection.subscribe((indices) => selectMsfsAnimations(indices));

    uiModel.msfsAnimationControl.subscribe((control) => {
        const entries = selectedMsfsEntries();
        switch (control.action) {
            case "play": {
                const pause = entries.some((entry) => entry.playing);
                for (const entry of entries) {
                    entry.playing = !pause;
                    if (entry.playing) {
                        entry.direction = 1;
                        if (entry.frame >= entry.maxFrame) {
                            entry.frame = entry.minFrame;
                        }
                    }
                    setMsfsFrame(entry, entry.frame);
                }
                break;
            }
            case "step":
                for (const entry of entries) {
                    entry.playing = false;
                    setMsfsFrame(entry, Math.round(entry.frame) + control.delta);
                }
                break;
            case "start":
            case "end":
                for (const entry of entries) {
                    entry.playing = false;
                    setMsfsFrame(entry, control.action === "start" ? entry.minFrame : entry.maxFrame);
                }
                break;
            case "frame":
                for (const entry of entries) {
                    setMsfsFrame(entry, control.frame);
                }
                break;
            case "progress":
                // Several animations of different lengths: the same fraction of each
                for (const entry of entries) {
                    setMsfsFrame(entry, Math.round(entry.minFrame + control.value * (entry.maxFrame - entry.minFrame)));
                }
                break;
            case "highlight":
                refreshMsfsAnimationHighlight();
                break;
        }
    });

    // indices undefined resets all animations
    uiModel.msfsAnimationReset.subscribe((indices) => {
        for (const entry of app.msfsAnimations) {
            if (indices === undefined || indices.includes(entry.index)) {
                entry.playing = false;
                entry.active = false;
                entry.direction = 1;
                entry.frame = entry.minFrame;
                applyMsfsAnimation(entry);
            }
        }
    });

    let lastMsfsTick = undefined;
    const advanceMsfsAnimations = () => {
        const now = performance.now();
        const deltaSeconds = lastMsfsTick === undefined ? 0 : (now - lastMsfsTick) / 1000;
        lastMsfsTick = now;
        let advanced = false;
        for (const entry of app.msfsAnimations) {
            if (!entry.playing) {
                continue;
            }
            const length = entry.maxFrame - entry.minFrame;
            let frame = entry.frame + deltaSeconds * app.msfsFrameRate * entry.direction;
            if (length <= 0) {
                frame = entry.minFrame;
                entry.playing = false;
            } else if (app.msfsPlayMode === "loop") {
                frame = entry.minFrame + ((((frame - entry.minFrame) % length) + length) % length);
            } else if (app.msfsPlayMode === "pingpong") {
                if (frame >= entry.maxFrame) {
                    frame = entry.maxFrame - (frame - entry.maxFrame);
                    entry.direction = -1;
                } else if (frame <= entry.minFrame) {
                    frame = entry.minFrame + (entry.minFrame - frame);
                    entry.direction = 1;
                }
            } else if (frame >= entry.maxFrame || frame <= entry.minFrame) {
                // Play once and hold the end frame, like a door or gear reaching its end position
                frame = entry.direction > 0 ? entry.maxFrame : entry.minFrame;
                entry.playing = false;
            }
            entry.frame = Math.min(entry.maxFrame, Math.max(entry.minFrame, frame));
            state.animationTimeOverrides.set(entry.index, entry.frame / app.msfsFrameRate);
            advanced = true;
        }
        return advanced;
    };

    // Performance overlay (Advanced Controls, or ?perf=1 in the URL)
    const perfOverlay = new PerfOverlay(document.getElementById("canvasUI"));
    app.$watch("showPerfOverlay", (visible) => {
        view.profiler.enabled = visible;
        perfOverlay.setVisible(visible);
        redraw = true;
    });
    if (new URLSearchParams(window.location.search).get("perf") === "1") {
        app.showPerfOverlay = true;
    }
    app.$watch("frustumCulling", (enabled) => {
        state.renderingParameters.frustumCulling = enabled;
        redraw = true;
    });

    // configure the animation loop
    const past = {};
    const update = () => {
        const devicePixelRatio = window.devicePixelRatio || 1;

        redraw |= dragSmoother.tick();
        redraw |= advanceMsfsAnimations();

        // set the size of the drawingBuffer based on the size it's displayed.
        canvas.width = Math.floor(canvas.clientWidth * devicePixelRatio);
        canvas.height = Math.floor(canvas.clientHeight * devicePixelRatio);
        redraw |= !state.animationTimer.paused && state.animationIndices.length > 0;
        redraw |= past.width != canvas.width || past.height != canvas.height;
        redraw |= state.needsRedraw;

        // Do not redraw when loading is in progress
        if (app.loadingComponent !== undefined) {
            redraw = false;
        }

        // Refit view if canvas changes significantly
        if (
            canvas.width / past.width < 0.5 ||
            canvas.width / past.width > 2.0 ||
            canvas.height / past.height < 0.5 ||
            canvas.height / past.height > 2.0
        ) {
            state.userCamera.perspective.aspectRatio = canvas.width / canvas.height;
            state.userCamera.fitViewToScene(state.gltf, state.sceneIndex);
        }

        past.width = canvas.width;
        past.height = canvas.height;

        if (redraw) {
            redraw = false;
            view.renderFrame(state, canvas.width, canvas.height);
            perfOverlay.recordFrame(view.profiler, performance.now());
        }
        perfOverlay.update(performance.now(), view.profiler, state, view.renderer, canvas);

        window.requestAnimationFrame(update);
    };

    // After this start executing animation loop.
    window.requestAnimationFrame(update);
};
