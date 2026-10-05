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
    getChannelHints,
    getMaterialTextureSlots,
    getMaterialUsage,
    MaterialEdits
} from "./logic/materials.js";
import { buildMsfsAnimationEntries, findAnimationsForNode, getAnimatedTargets } from "./logic/msfs_animations.js";
import { summarizeValidation } from "./logic/validation_summary.js";
import { TextureFolders } from "./logic/texture_folders.js";
import { app } from "./ui/ui.js";
import { EMPTY, Observable, from, merge } from "rxjs";
import { mergeMap, map, share, catchError, switchMap, tap } from "rxjs/operators";
import { GltfModelPathProvider, fillEnvironmentWithPaths } from "./model_path_provider.js";

export default async () => {
    const canvas = document.getElementById("canvas");
    const context = canvas.getContext("webgl2", {
        alpha: false,
        antialias: true
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
    const state = view.createState();

    await state.physicsController.initializeEngine("NvidiaPhysX");

    state.renderingParameters.useDirectionalLightsWithDisabledIBL = true;

    state.graphController.addCustomEventListener("test/onStart", (event) => {
        console.log("Test duration: ", event);
    });
    state.graphController.addCustomEventListener("test/onSuccess", () => {
        const message = "Interactivity test succeeded";
        console.log(message);
        app.$buefy.toast.open({
            message: message,
            type: "is-success"
        });
    });
    state.graphController.addCustomEventListener("test/onFailed", () => {
        const message = "Interactivity test failed";
        console.error(message);
    });
    
    const emptyGltf = await resourceLoader.loadGltf(undefined, undefined, false);

    const pathProvider = new GltfModelPathProvider(
        "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main"
    );
    await pathProvider.initialize();
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

    const uiModel = new UIModel(app, pathProvider, environmentPaths);

    // The validator reads the whole asset again, so it runs in a worker to keep the main
    // thread free for loading and rendering.
    let validatorWorker = undefined;
    const validation = uiModel.model.pipe(
        switchMap((model) => {
            validatorWorker?.terminate();
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

    // whenever a new model is selected, load it and when complete pass the loaded gltf
    // into a stream back into the UI
    const gltfLoaded = uiModel.model.pipe(
        mergeMap((model) => {
            uiModel.goToLoadingState();

            // Workaround for errors in ktx lib after loading an asset with ktx2 files for the second time:
            resourceLoader.initKtxLib();

            return from(
                resourceLoader
                    .loadGltf(model.mainFile, model.additionalFiles, false)
                    .then((gltf) => {
                        state.gltf = gltf;
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
                            if (state.gltf?.extensions?.KHR_interactivity?.graphs !== undefined) {
                                state.graphController.initializeGraphs(state);
                                const graphIndex =
                                    state.gltf.extensions.KHR_interactivity.graph ?? 0;
                                state.graphController.loadGraph(graphIndex);
                                state.graphController.resumeGraph();
                            } else {
                                state.graphController.stopGraphEngine();
                            }

                            state.physicsController.loadScene(state, state.sceneIndex);
                            state.physicsController.resumeSimulation();
                        }
                        setupInspector(gltf, state.sceneIndex);
                        setupMaterials(gltf);
                        refreshValidationSummary();

                        uiModel.exitLoadingState();

                        return state;
                    })
                    .catch((error) => {
                        console.error("Loading failed: " + error);
                        state.gltf = emptyGltf;
                        state.sceneIndex = 0;
                        state.cameraNodeIndex = undefined;
                        setupInspector(emptyGltf, 0);
                        setupMaterials(emptyGltf);
                        refreshValidationSummary();
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
                state.physicsController.loadScene(state, state.sceneIndex);
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

    uiModel.camera.subscribe(
        (camera) => (state.cameraNodeIndex = camera !== -1 ? camera : undefined)
    );
    listenForRedraw(uiModel.camera);

    uiModel.variant.subscribe((variant) => (state.variant = variant));
    listenForRedraw(uiModel.variant);

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

    uiModel.morphingEnabled.subscribe(
        (morphingEnabled) => (state.renderingParameters.morphing = morphingEnabled)
    );
    listenForRedraw(uiModel.morphingEnabled);

    uiModel.interactivityEnabled.subscribe((interactivityEnabled) => {
        state.renderingParameters.enabledExtensions.KHR_interactivity = interactivityEnabled;
        if (state.gltf?.extensions?.KHR_interactivity === undefined) {
            return;
        }
        if (interactivityEnabled) {
            state.graphController.initializeGraphs(state);
            const graphIndex = state.gltf.extensions.KHR_interactivity.graph ?? 0;
            state.graphController.loadGraph(graphIndex);
            if (app.graphState) {
                state.graphController.resumeGraph();
                state.animationTimer.unpause();
            } else {
                state.graphController.pauseGraph();
                state.animationTimer.pause();
            }
        } else {
            state.graphController.stopGraphEngine();
            if (app.animationState) {
                state.animationTimer.unpause();
            } else {
                state.animationTimer.pause();
            }
        }
    });
    listenForRedraw(uiModel.interactivityEnabled);

    uiModel.clearcoatEnabled.subscribe(
        (clearcoatEnabled) =>
            (state.renderingParameters.enabledExtensions.KHR_materials_clearcoat = clearcoatEnabled)
    );
    listenForRedraw(uiModel.clearcoatEnabled);

    uiModel.sheenEnabled.subscribe(
        (sheenEnabled) =>
            (state.renderingParameters.enabledExtensions.KHR_materials_sheen = sheenEnabled)
    );
    listenForRedraw(uiModel.sheenEnabled);

    uiModel.transmissionEnabled.subscribe(
        (transmissionEnabled) =>
            (state.renderingParameters.enabledExtensions.KHR_materials_transmission =
                transmissionEnabled)
    );
    listenForRedraw(uiModel.transmissionEnabled);

    uiModel.diffuseTransmissionEnabled.subscribe(
        (diffuseTransmissionEnabled) =>
            (state.renderingParameters.enabledExtensions.KHR_materials_diffuse_transmission =
                diffuseTransmissionEnabled)
    );
    listenForRedraw(uiModel.diffuseTransmissionEnabled);

    uiModel.volumeEnabled.subscribe(
        (volumeEnabled) =>
            (state.renderingParameters.enabledExtensions.KHR_materials_volume = volumeEnabled)
    );
    listenForRedraw(uiModel.volumeEnabled);

    uiModel.iorEnabled.subscribe(
        (iorEnabled) => (state.renderingParameters.enabledExtensions.KHR_materials_ior = iorEnabled)
    );
    listenForRedraw(uiModel.iorEnabled);

    uiModel.iridescenceEnabled.subscribe(
        (iridescenceEnabled) =>
            (state.renderingParameters.enabledExtensions.KHR_materials_iridescence =
                iridescenceEnabled)
    );
    listenForRedraw(uiModel.iridescenceEnabled);

    uiModel.retroreflectionEnabled.subscribe(
        (retroreflectionEnabled) =>
            (state.renderingParameters.enabledExtensions.KHR_materials_retroreflection =
                retroreflectionEnabled)
    );
    listenForRedraw(uiModel.retroreflectionEnabled);

    uiModel.anisotropyEnabled.subscribe(
        (anisotropyEnabled) =>
            (state.renderingParameters.enabledExtensions.KHR_materials_anisotropy =
                anisotropyEnabled)
    );
    listenForRedraw(uiModel.anisotropyEnabled);

    uiModel.dispersionEnabled.subscribe(
        (dispersionEnabled) =>
            (state.renderingParameters.enabledExtensions.KHR_materials_dispersion =
                dispersionEnabled)
    );
    listenForRedraw(uiModel.dispersionEnabled);

    uiModel.specularEnabled.subscribe(
        (specularEnabled) =>
            (state.renderingParameters.enabledExtensions.KHR_materials_specular = specularEnabled)
    );
    listenForRedraw(uiModel.specularEnabled);

    uiModel.emissiveStrengthEnabled.subscribe(
        (enabled) =>
            (state.renderingParameters.enabledExtensions.KHR_materials_emissive_strength = enabled)
    );
    listenForRedraw(uiModel.emissiveStrengthEnabled);

    uiModel.volumeScatteringEnabled.subscribe(
        (enabled) =>
            (state.renderingParameters.enabledExtensions.KHR_materials_volume_scatter = enabled)
    );
    listenForRedraw(uiModel.volumeScatteringEnabled);

    uiModel.hoverabilityEnabled.subscribe(
        (hoverabilityEnabled) =>
            (state.renderingParameters.enabledExtensions.KHR_node_hoverability =
                hoverabilityEnabled)
    );
    listenForRedraw(uiModel.hoverabilityEnabled);

    uiModel.selectabilityEnabled.subscribe(
        (selectabilityEnabled) =>
            (state.renderingParameters.enabledExtensions.KHR_node_selectability =
                selectabilityEnabled)
    );
    listenForRedraw(uiModel.selectabilityEnabled);

    uiModel.nodeVisibilityEnabled.subscribe(
        (nodeVisibilityEnabled) =>
            (state.renderingParameters.enabledExtensions.KHR_node_visibility =
                nodeVisibilityEnabled)
    );
    listenForRedraw(uiModel.nodeVisibilityEnabled);
    
    uiModel.gaussianSplattingEnabled.subscribe(
        (enabled) => (state.renderingParameters.enabledExtensions.KHR_gaussian_splatting = enabled)
    );
    listenForRedraw(uiModel.gaussianSplattingEnabled);

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

    uiModel.graphPlay.subscribe((graphPlay) => {
        if (graphPlay) {
            state.graphController.resumeGraph();
            state.animationTimer.unpause();
        } else {
            state.graphController.pauseGraph();
            state.animationTimer.pause();
        }
    });

    uiModel.physicsEnabled.subscribe((physicsEnabled) => {
        if (physicsEnabled) {
            state.physicsController.resumeSimulation();
        } else {
            state.physicsController.pauseSimulation();
        }
    });

    uiModel.physicsStep.subscribe(() => {
        state.physicsController.simulateStep(state, 1 / 60);
        state.gltf.resetAllDirtyFlags();
        redraw = true;
    });

    uiModel.physicsColliderDebug.subscribe((enabled) => {
        state.physicsController.enableDebugColliders(enabled);
        redraw = true;
    });

    uiModel.physicsJointDebug.subscribe((enabled) => {
        state.physicsController.enableDebugJoints(enabled);
        redraw = true;
    });

    uiModel.animationReset.subscribe(() => {
        state.animationTimer.reset();
        redraw = true;
    });

    uiModel.graphReset.subscribe(() => {
        state.graphController.resetGraph();
        redraw = true;
    });

    uiModel.activeAnimations.subscribe((animations) => (state.animationIndices = animations));
    listenForRedraw(uiModel.activeAnimations);

    uiModel.selectedGraph.subscribe((graphIndex) => {
        if (graphIndex !== null && graphIndex !== undefined) {
            state.graphController.loadGraph(graphIndex);
        }
    });

    uiModel.customEventSend.subscribe((eventData) => {
        if (eventData && eventData.eventId) {
            const values = {};
            for (const key in eventData.values) {
                values[key] = eventData.values[key];
            }
            state.graphController.dispatchEvent(eventData.eventId, values);
        }
    });

    uiModel.physicsReset.subscribe(() => {
        state.physicsController.resetScene(state.gltf);
        state.gltf.resetAnimatedProperties(state.sceneIndex);
        state.physicsController.loadScene(state, state.sceneIndex);
        redraw = true;
    });

    uiModel.physicsEngine.subscribe((engine) => {
        // There are currently no other engines supported besides PhysX
    });

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
    const sceneChangedStateObservable = uiModel.scene.pipe(map(() => state));
    uiModel.attachCameraChangeObservable(sceneChangedStateObservable);

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

    // Tinted nodes and materials come from several tabs; the renderer gets their union.
    const highlights = {
        inspectorNodes: new Set(),
        animationNodes: new Set(),
        materialsMaterials: new Set(),
        animationMaterials: new Set()
    };
    function refreshHighlights() {
        state.highlightedNodeIndices = new Set([...highlights.inspectorNodes, ...highlights.animationNodes]);
        state.highlightedMaterialIndices = new Set([
            ...highlights.materialsMaterials,
            ...highlights.animationMaterials
        ]);
        redraw = true;
    }

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
    // read back from the GPU for thumbnails and the texture viewer, and its factors can be edited
    // live. Nothing is written back to the file.
    const materialEdits = new MaterialEdits();
    let materialSlots = []; // [{slot, bound}] of the selected material; bound is the renderer's textureInfo
    let materialUsage = new Map();
    let thumbnails = new Map(); // texture index -> data URL, for the loaded glTF

    function setupMaterials(gltf) {
        materialEdits.clear();
        thumbnails = new Map();
        materialUsage = getMaterialUsage(gltf);
        app.materialsList = buildMaterialList(gltf);
        app.materialsFilter = "";
        app.materialEditedCount = 0;
        setHiddenMaterials([]);
        closeTextureViewer();
        selectMaterial(undefined);
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
        app.materialFactors = materialEdits.getFactors(gltf, index);
        app.materialEdited =
            materialEdits.isEdited(index) || materialSlots.some(({ slot }) => slot.status === "off");
        app.materialEditedCount = materialEdits.originals.size;
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
            app.materialFactors = [];
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

    uiModel.materialFactor.subscribe(({ key, value }) => {
        if (app.materialsSelected === undefined) {
            return;
        }
        materialEdits.set(state.gltf, app.materialsSelected, key, value);
        app.materialFactors = materialEdits.getFactors(state.gltf, app.materialsSelected);
        app.materialEdited = true;
        app.materialEditedCount = materialEdits.originals.size;
        redraw = true;
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
        materialEdits.reset(state.gltf, index);
        refreshMaterialDetails();
        redraw = true;
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
        redraw |= state.graphController.playing;
        redraw |= past.width != canvas.width || past.height != canvas.height;
        redraw |= state.physicsController.enabled && state.physicsController.playing;
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
        }

        window.requestAnimationFrame(update);
    };

    // After this start executing animation loop.
    window.requestAnimationFrame(update);
};
