import { GltfView, ResourceLoaderUtils, Msfs } from "@khronosgroup/gltf-viewer";

import { UIModel } from "./logic/uimodel.js";
import { buildNodeTree, collectSubtree, getMsfsMaterialSummary, getNodeDetails } from "./logic/inspector.js";
import { TextureFolders } from "./logic/texture_folders.js";
import { app } from "./ui/ui.js";
import { EMPTY, from, merge } from "rxjs";
import { mergeMap, map, share, catchError } from "rxjs/operators";
import { GltfModelPathProvider, fillEnvironmentWithPaths } from "./model_path_provider.js";

import { validateBytes } from "gltf-validator";

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

    const validation = uiModel.model.pipe(
        mergeMap((model) => {
            const func = async (model) => {
                try {
                    const fileType = typeof model.mainFile;
                    // TODO: Remove ignoredIssues once validator is updated to support KHR_gaussian_splatting extension
                    const validateOptions = {
                        ignoredIssues: ["MESH_PRIMITIVE_INVALID_ATTRIBUTE"]
                    };
                    if (fileType == "string") {
                        const externalRefFunction = (uri) => {
                            const parent = model.mainFile.substring(
                                0,
                                model.mainFile.lastIndexOf("/") + 1
                            );
                            return new Promise((resolve, reject) => {
                                fetch(parent + uri)
                                    .then((response) => {
                                        response
                                            .arrayBuffer()
                                            .then((buffer) => {
                                                resolve(new Uint8Array(buffer));
                                            })
                                            .catch((error) => {
                                                reject(error);
                                            });
                                    })
                                    .catch((error) => {
                                        reject(error);
                                    });
                            });
                        };
                        const response = await fetch(model.mainFile);
                        const buffer = await response.arrayBuffer();
                        validateOptions.uri = model.mainFile;
                        validateOptions.externalResourceFunction = externalRefFunction;
                        return await validateBytes(new Uint8Array(buffer), validateOptions);
                    } else if (Array.isArray(model.mainFile)) {
                        const externalRefFunction = (uri) => {
                            return new Promise((resolve, reject) => {
                                const foundFile = ResourceLoaderUtils.findFile(
                                    model.additionalFiles,
                                    uri,
                                    model.mainFile[0]
                                )?.[1];
                                if (foundFile) {
                                    foundFile
                                        .arrayBuffer()
                                        .then((buffer) => {
                                            resolve(new Uint8Array(buffer));
                                        })
                                        .catch((error) => {
                                            reject(error);
                                        });
                                } else {
                                    reject("File not found");
                                }
                            });
                        };

                        const buffer = await model.mainFile[1].arrayBuffer();
                        validateOptions.uri = model.mainFile[0];
                        validateOptions.externalResourceFunction = externalRefFunction;
                        return await validateBytes(new Uint8Array(buffer), validateOptions);
                    }
                } catch (error) {
                    console.error(error);
                }
            };
            return from(func(model)).pipe(
                catchError((error) => {
                    console.error(`Validation failed: ${error}`);
                    return { error: `Validation failed: ${error}` };
                })
            );
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

                        uiModel.exitLoadingState();

                        return state;
                    })
                    .catch((error) => {
                        console.error("Loading failed: " + error);
                        state.gltf = emptyGltf;
                        state.sceneIndex = 0;
                        state.cameraNodeIndex = undefined;
                        setupInspector(emptyGltf, 0);
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
    uiModel.updateValidationReport(validation);
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
            state.highlightedNodeIndices = new Set();
        } else {
            app.inspectorDetails = getNodeDetails(state.gltf, index);
            state.highlightedNodeIndices = collectSubtree(state.gltf, index);
        }
        redraw = true;
    }

    uiModel.inspectorSelection.subscribe((index) => selectInspectorNode(index));

    // Highlight colour: the picker gives sRGB, the shader blends in linear space.
    // Remembered per browser; storage may be unavailable (private mode), so it is optional.
    const HighlightStorageKey = "inspectorHighlight";
    const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const applyInspectorHighlight = ({ color, strength }) => {
        const match = /^#([0-9a-f]{6})$/i.exec(color ?? "");
        if (!match || !(strength >= 0 && strength <= 1)) {
            return false;
        }
        const value = parseInt(match[1], 16);
        state.renderingParameters.highlightColor = [16, 8, 0].map((shift) =>
            srgbToLinear(((value >> shift) & 0xff) / 255)
        );
        state.renderingParameters.highlightStrength = strength;
        app.inspectorHighlightColor = color.toLowerCase();
        app.inspectorHighlightStrength = strength;
        return true;
    };
    try {
        applyInspectorHighlight(JSON.parse(window.localStorage.getItem(HighlightStorageKey)) ?? {});
    } catch {
        // keep the default highlight
    }
    uiModel.inspectorHighlight.subscribe((highlight) => {
        if (!applyInspectorHighlight(highlight)) {
            return;
        }
        try {
            window.localStorage.setItem(HighlightStorageKey, JSON.stringify(highlight));
        } catch {
            // not remembered, still applied
        }
    });
    listenForRedraw(uiModel.inspectorHighlight);

    uiModel.inspectorFocus.subscribe((index) => {
        if (state.gltf === undefined || state.cameraNodeIndex !== undefined) {
            return;
        }
        state.userCamera.focusOnNode(state.gltf, index);
        redraw = true;
    });

    state.selectionCallback = (pickingResult) => {
        if (!app.inspectorOpen) {
            return;
        }
        const index = pickingResult.node?.gltfObjectIndex;
        selectInspectorNode(index);
        if (index !== undefined) {
            app.revealInspectorNode(index);
        }
    };

    // MSFS animations: each animation is positioned by frame, like the sim variable driving it.
    // Active animations (scrubbed or playing) are evaluated at their own time via
    // state.animationTimeOverrides; all others stay in the rest pose.
    function setupMsfsAnimations(gltf) {
        const fps = Msfs.detectMsfsFrameRate(gltf);
        app.msfsFrameRate = fps;
        app.msfsAnimationFilter = "";
        app.msfsAnimations = gltf.animations.map((animation, index) => {
            animation.computeMinMaxTime(gltf);
            const minFrame = Math.round((animation.minTime ?? 0) * fps);
            const maxFrame = Math.round((animation.maxTime ?? 0) * fps);
            return {
                index,
                title: animation.name ?? `Animation ${index}`,
                minFrame,
                maxFrame,
                frame: minFrame,
                playing: false,
                active: false
            };
        });
        app.msfsAnimationMode = true;
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

    uiModel.msfsAnimationFrame.subscribe(({ index, frame }) => {
        const entry = findMsfsAnimation(index);
        entry.frame = frame;
        entry.active = true;
        applyMsfsAnimation(entry);
    });

    uiModel.msfsAnimationPlayToggled.subscribe((index) => {
        const entry = findMsfsAnimation(index);
        entry.playing = !entry.playing;
        entry.active = true;
        if (entry.playing && entry.frame >= entry.maxFrame) {
            entry.frame = entry.minFrame;
        }
        applyMsfsAnimation(entry);
    });

    // index undefined resets all animations
    uiModel.msfsAnimationReset.subscribe((index) => {
        for (const entry of app.msfsAnimations) {
            if (index === undefined || entry.index === index) {
                entry.playing = false;
                entry.active = false;
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
            // Play once and hold the last frame, like a door or gear reaching its end position
            let frame = entry.frame + deltaSeconds * app.msfsFrameRate;
            if (frame >= entry.maxFrame) {
                frame = entry.maxFrame;
                entry.playing = false;
            }
            entry.frame = frame;
            state.animationTimeOverrides.set(entry.index, frame / app.msfsFrameRate);
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
