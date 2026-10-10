import { createApp } from "vue/dist/vue.cjs.js";
import { Subject } from "rxjs";
import "./sass.scss";
import Buefy from "@ntohq/buefy-next";

// collapseActiveTab ids of the Animations, Inspector and Materials tabs (index.html)
const AnimationsTab = 3;
const InspectorTab = 7;
const MaterialsTab = 8;

const appCreated = createApp({
    data() {
        return {
            sceneChanged: new Subject(),

            debugchannelChanged: new Subject(),
            tonemapChanged: new Subject(),
            skinningChanged: new Subject(),
            inputSmoothingChanged: new Subject(),
            punctualLightsChanged: new Subject(),

            iblChanged: new Subject(),
            blurEnvChanged: new Subject(),
            colorChanged: new Subject(),

            environmentRotationChanged: new Subject(),
            animationPlayChanged: new Subject(),
            animationResetChanged: new Subject(),
            exposureChanged: new Subject(),

            cameraExport: new Subject(),

            captureCanvas: new Subject(),
            iblIntensityChanged: new Subject(),

            floatingPointFramebufferChanged: new Subject(),
            showMsfsInvisibleMaterialsChanged: new Subject(),
            msfsNightLightingChanged: new Subject(),
            showMsfsCollidersChanged: new Subject(),
            showMsfsLightsChanged: new Subject(),
            msfsAnimationSelectionChanged: new Subject(),
            msfsAnimationControl: new Subject(),
            msfsAnimationReset: new Subject(),
            inspectorSelectionChanged: new Subject(),
            inspectorFocus: new Subject(),
            highlightChanged: new Subject(),
            maxTextureSizeChanged: new Subject(),
            materialSelectionChanged: new Subject(),
            materialViewChanged: new Subject(),
            materialHiddenChanged: new Subject(),
            // material editor (logic/msfs_material_editor.js): { param, value }, type, { slot, textureIndex }, "folder" | "download"
            materialParamChanged: new Subject(),
            materialTypeChanged: new Subject(),
            materialTextureAssigned: new Subject(),
            materialSaveRequested: new Subject(),
            materialTextureToggled: new Subject(),
            materialReset: new Subject(),
            materialTextureOpened: new Subject(),
            textureViewerChanged: new Subject(),
            modelReloadRequested: new Subject(),
            textureFolderAdd: new Subject(),
            textureFolderRemove: new Subject(),
            textureFolderMove: new Subject(),
            textureFolderRescan: new Subject(),
            textureFolderAccess: new Subject(),
            renderEnvChanged: new Subject(),
            addEnvironmentChanged: new Subject(),
            selectedAnimationsChanged: new Subject(),
            selectedEnvironmentChanged: new Subject(),


            validatorChanged: new Subject(),

            fullheight: true,
            right: true,
            scenes: [{ title: "0" }, { title: "1" }],

            animations: [{ title: "None" }],
            tonemaps: [{ title: "None" }],
            debugchannels: [{ title: "None" }],
            statistics: [],

            selectedScene: {},
            selectedAnimations: [],
            disabledAnimations: [],

            animationState: true,

            validationReport: {},
            validationReportDescription: {},
            // logic/validation_summary.js: {problems, expected, counts} for the Validator tab
            validationSummary: undefined,
            validationOpenGroups: {},

            ibl: true,
            iblIntensity: 0.0,
            punctualLights: true,
            renderEnv: true,
            blurEnv: true,
            clearColor: "",
            environmentRotations: [
                { title: "+Z" },
                { title: "-X" },
                { title: "-Z" },
                { title: "+X" }
            ],
            selectedEnvironmentRotation: "+Z",
            environments: [{ index: 0, name: "" }],
            selectedEnvironment: 0,

            debugChannel: "None",
            exposureSetting: 0,
            toneMap: "Khronos PBR Neutral",
            skinning: true,
            inputSmoothing: true,
            floatingPointFramebuffer: true,
            supportsFloatingPointFramebuffer: true,
            showMsfsInvisibleMaterials: false,
            msfsNightLighting: false,
            showMsfsColliders: true,
            showMsfsLights: true,
            frustumCulling: true,
            // performance overlay on the canvas (logic/perf_overlay.js)
            showPerfOverlay: false,
            // MSFS animation mode: one frame slider per animation instead of auto-play
            msfsAnimationMode: false,
            msfsAnimations: [],
            msfsFrameRate: 30,
            msfsAnimationFilter: "",
            msfsAnimationActiveOnly: false,
            // indices of the animations in the control dock; msfsAnimationAnchor for shift-click ranges
            msfsAnimationSelected: [],
            msfsAnimationAnchor: undefined,
            msfsAnimationGroupsOpen: {},
            msfsAnimationHighlight: true,
            msfsPlayMode: "once",
            msfsAnimationPickInfo: "",
            // Inspector tab: flat node tree (see logic/inspector.js) and the selected node's details
            inspectorNodes: [],
            inspectorExpanded: {},
            inspectorFilter: "",
            inspectorSelected: undefined,
            inspectorDetails: [],
            inspectorMaterialSummary: [],
            // Selection highlight (Display tab), used by the Inspector, Materials and Animations tabs.
            // sRGB hex from the colour picker; main.js converts it to linear for the renderer
            highlightColor: "#ffb33f",
            highlightStrength: 0.55,
            // Largest texture width/height loaded (0: full size), see main.js
            maxTextureSize: 0,
            maxTextureSizes: [
                { value: 0, title: "Full size" },
                { value: 8192, title: "8192" },
                { value: 4096, title: "4096" },
                { value: 2048, title: "2048" },
                { value: 1024, title: "1024" },
                { value: 512, title: "512" }
            ],
            // Materials tab (logic/materials.js): list, selected material's textures and factors
            materialsList: [],
            materialsFilter: "",
            // indices of materials drawn by parts that are not hidden (node visibility)
            materialsShown: [],
            materialsVisibleOnly: true,
            // MSFS packages: collapsed material groups (by sub model)
            materialsCollapsed: {},
            materialsSelected: undefined,
            materialHighlight: true,
            materialIsolate: false,
            // material indices whose parts are not drawn (and not pickable)
            materialsHidden: [],
            materialInfo: [],
            materialTextures: [],
            // Materials tab in the 3ds Max material editor layout (logic/msfs_material_editor.js)
            materialEditor: undefined,
            materialRollouts: { parameters: true, textures: true, info: false, users: false },
            materialTextureSize: "medium",
            materialUsers: [],
            materialEdited: false,
            materialEditedCount: 0,
            // Texture viewer dialog; the pixels are drawn by main.js into #textureViewerCanvas
            textureViewer: {
                open: false,
                title: "",
                file: "",
                textureIndex: undefined,
                channel: "rgb",
                maxSize: 1024,
                width: 0,
                height: 0,
                sourceWidth: 0,
                sourceHeight: 0,
                channelHints: {},
                pixel: ""
            },
            // Texture lookup folders (logic/texture_folders.js rows)
            textureFoldersSupported: true,
            textureFolders: [],
            // Models tab mode: "single" glTF or a whole MSFS "package" (logic/msfs_package.js)
            loadMode: "single",
            loadModeChanged: new Subject(),
            packageUrl: "",
            packageOpenUrl: new Subject(),
            packageOpenFolder: new Subject(),
            packageLoadPreset: new Subject(),
            packageLiveryChanged: new Subject(),
            packageAttachmentToggled: new Subject(),
            packageAttachmentSelected: new Subject(),
            packageSource: "",
            packageStatus: "",
            packageError: "",
            packagePresets: [],
            selectedPackagePreset: "",
            loadedPackagePreset: "", // preset of the shown model
            // liveries available for the loaded preset ({ id, title }); "none" = without livery
            packageLiveries: [],
            selectedPackageLivery: "",
            // rows: { id, depth, name, kind, visible, problems, title, hasChildren }
            packageRows: [],
            packageCollapsed: {},


            activeTabIndex: 0,
            activeTab: 0,
            tabContentHidden: true,
            loadingComponent: undefined,
            showDropDownOverlay: false,
            uploadedHDR: undefined,
            uiVisible: false,
            isMobile: false,
            noUi: false,

            // these are handles for certain ui change related things
            environmentVisiblePrefState: true
        };
    },
    watch: {
        selectedAnimations: function (newValue) {
            this.selectedAnimationsChanged.next(newValue);
        },
    },
    beforeMount: function () {
        // Definition of mobile: https://bulma.io/documentation/start/responsiveness/
        if (document.documentElement.clientWidth > 768) {
            this.uiVisible = true;
            this.isMobile = false;
        } else {
            this.uiVisible = false;
            this.isMobile = true;
        }
        const queryString = window.location.search;
        const urlParams = new URLSearchParams(queryString);
        const noUI = urlParams.get("noUI");
        if (noUI !== null) {
            this.uiVisible = false;
            this.noUI = true;
        }
    },
    mounted: function () {
        // remove input class from color picker (added by default by buefy)
        const colorPicker = document.getElementById("clearColorPicker");
        colorPicker.classList.remove("input");

        // test if webgl is present
        const canvas = document.getElementById("canvas");
        const context = canvas.getContext("webgl2", {
            alpha: false,
            antialias: true
        });
        if (context === undefined || context === null) {
            this.error(
                "The sample viewer requires WebGL 2.0, which is not supported by this browser or device. " +
                    "Please try again with another browser, or check https://get.webgl.org/webgl2/ " +
                    "if you believe you are seeing this message in error.",
                15000
            );
        }

        // change styling of tab-bar
        this.$nextTick(function () {
            // Code that will run only after the
            // entire view has been rendered

            let navElement = document.getElementById("tabsContainer").childNodes[0];

            if (!this.isMobile) {
                navElement.style.width = "100px";
            }

            let ulElement = navElement.childNodes[0];
            while (ulElement) {
                if (ulElement.nodeName === "UL") {
                    break;
                }
                ulElement = ulElement.nextElementSibling;
            }

            // Avoid margin on top for mobile devices
            if (this.isMobile) {
                let liElement = ulElement.childNodes[0];
                while (liElement) {
                    if (liElement.nodeName === "LI") {
                        break;
                    }
                    liElement = liElement.nextElementSibling;
                }
                liElement.style.marginTop = "0px";
            }
        });
    },
    computed: {
        packagePresetGroups() {
            const groups = [];
            for (const preset of this.packagePresets) {
                let group = groups.find((entry) => entry.name === preset.group);
                if (group === undefined) {
                    group = { name: preset.group, presets: [] };
                    groups.push(group);
                }
                group.presets.push(preset);
            }
            return groups;
        },
        // rows whose ancestors are all expanded
        visiblePackageRows() {
            const rows = [];
            let hiddenBelow = Infinity;
            for (const row of this.packageRows) {
                if (row.depth > hiddenBelow) {
                    continue;
                }
                hiddenBelow = Infinity;
                rows.push(row);
                if (row.hasChildren && this.packageCollapsed[row.id]) {
                    hiddenBelow = row.depth;
                }
            }
            return rows;
        },
        packageProblemCount() {
            return this.packageRows.filter((row) => row.problems.length > 0).length;
        },
        textureFoldersNeedAccess() {
            return this.textureFolders.some((folder) => folder.status === "needsAccess");
        },
        inspectorOpen() {
            return this.activeTab === InspectorTab && !this.tabContentHidden;
        },
        materialsOpen() {
            return this.activeTab === MaterialsTab && !this.tabContentHidden;
        },
        materialsSelectedRow() {
            return this.materialsList.find((row) => row.index === this.materialsSelected);
        },
        visibleMaterials() {
            const filter = this.materialsFilter.trim().toLowerCase();
            const shown = this.materialsVisibleOnly ? new Set(this.materialsShown) : undefined;
            return this.materialsList.filter(
                (row) =>
                    (shown === undefined || shown.has(row.index)) &&
                    (filter === "" || row.search.includes(filter) || String(row.index) === filter)
            );
        },
        // The list as displayed: material rows, under group headers when rows have a group
        materialDisplayRows() {
            const rows = this.visibleMaterials;
            if (!rows.some((row) => row.group !== undefined)) {
                return rows.map((row) => ({ type: "material", key: `m${row.index}`, row }));
            }
            const groups = new Map();
            for (const row of rows) {
                const group = row.group ?? { key: "other", label: "Other", order: Infinity };
                if (!groups.has(group.key)) {
                    groups.set(group.key, { ...group, rows: [] });
                }
                groups.get(group.key).rows.push(row);
            }
            const display = [];
            for (const group of [...groups.values()].sort((a, b) => a.order - b.order)) {
                const collapsed = this.materialsCollapsed[group.key] && this.materialsFilter.trim() === "";
                display.push({ type: "group", key: `g${group.key}`, group, count: group.rows.length, collapsed });
                if (!collapsed) {
                    display.push(...group.rows.map((row) => ({ type: "material", key: `m${row.index}`, row })));
                }
            }
            return display;
        },
        materialGroupCount() {
            return this.materialDisplayRows.filter((entry) => entry.type === "group").length;
        },
        inspectorSelectedRow() {
            return this.inspectorNodes.find((row) => row.index === this.inspectorSelected);
        },
        visibleInspectorRows() {
            const filter = this.inspectorFilter.trim().toLowerCase();
            if (filter !== "") {
                // matches plus their ancestors, so each match keeps its place in the hierarchy
                const byIndex = new Map(this.inspectorNodes.map((row) => [row.index, row]));
                const shown = new Set();
                for (const row of this.inspectorNodes) {
                    const haystack = [row.name, row.uniqueId ?? "", ...row.tags].join(" ").toLowerCase();
                    if (!haystack.includes(filter)) {
                        continue;
                    }
                    for (let index = row.index; index !== undefined && !shown.has(index); index = byIndex.get(index).parent) {
                        shown.add(index);
                    }
                }
                return this.inspectorNodes.filter((row) => shown.has(row.index));
            }
            const rows = [];
            let collapsedDepth = Infinity;
            for (const row of this.inspectorNodes) {
                if (row.depth > collapsedDepth) {
                    continue;
                }
                collapsedDepth = Infinity;
                rows.push(row);
                if (row.childCount > 0 && !this.inspectorExpanded[row.index]) {
                    collapsedDepth = row.depth;
                }
            }
            return rows;
        },
        animationsOpen() {
            return this.activeTab === AnimationsTab && !this.tabContentHidden;
        },
        // [{name, count, open, entries}] by name prefix; filtering shows all matches expanded
        msfsAnimationGroups() {
            const filter = this.msfsAnimationFilter.trim().toLowerCase().replace(/_/g, " ");
            const filtering = filter !== "" || this.msfsAnimationActiveOnly;
            const groups = new Map();
            for (const entry of this.msfsAnimations) {
                let group = groups.get(entry.group);
                if (group === undefined) {
                    group = { name: entry.group, count: 0, entries: [] };
                    groups.set(entry.group, group);
                }
                group.count++;
                if ((filter === "" || entry.search.includes(filter)) && (!this.msfsAnimationActiveOnly || entry.active)) {
                    group.entries.push(entry);
                }
            }
            const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
            return [...groups.values()]
                .filter((group) => !filtering || group.entries.length > 0)
                .sort((a, b) => (a.name === "Other") - (b.name === "Other") || collator.compare(a.name, b.name))
                .map((group) => ({
                    ...group,
                    open: filtering || groups.size === 1 || this.msfsAnimationGroupsOpen[group.name] === true,
                    entries: group.entries.sort((a, b) => collator.compare(a.short, b.short))
                }));
        },
        visibleMsfsAnimations() {
            return this.msfsAnimationGroups.filter((group) => group.open).flatMap((group) => group.entries);
        },
        selectedMsfsAnimations() {
            return this.msfsAnimationSelected
                .map((index) => this.msfsAnimations.find((entry) => entry.index === index))
                .filter((entry) => entry !== undefined);
        },
        // Dock slider position: frames for one animation, 0..1 progress for several
        msfsDockProgress() {
            const entries = this.selectedMsfsAnimations;
            if (entries.length === 0) {
                return 0;
            }
            const entry = entries[0];
            return entry.maxFrame > entry.minFrame ? (entry.frame - entry.minFrame) / (entry.maxFrame - entry.minFrame) : 0;
        },
        msfsDockPlaying() {
            return this.selectedMsfsAnimations.some((entry) => entry.playing);
        }
    },
    methods: {
        async copyToClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
                this.$buefy.toast.open({
                    message: "Copied to clipboard",
                    type: "is-success"
                });
                // eslint-disable-next-line no-unused-vars
            } catch (err) {
                this.error("Error copying to clipboard.");
            }
        },
        downloadJSON(filename, json) {
            const text = JSON.stringify(json, undefined, 4);
            const dataURL = "data:application/json;charset=utf-8," + encodeURIComponent(text);
            const element = document.createElement("a");
            element.setAttribute("href", dataURL);
            element.setAttribute("download", filename);
            element.style.display = "none";
            document.body.appendChild(element);
            element.click();
            document.body.removeChild(element);
        },

        /**
         * Creates a div string summarizing the given issues.
         *
         * If the given issues are empty or do not contain any errors,
         * warnings, or infos, then the empty string is returned.
         *
         * Otherwise, the div contains the number of errors/warnings/infos
         * with an appropriate background color. When all warnings of
         * the given report are ignored, then this will only be a
         * small "info" div. Clicking on that will expand the details
         * about the ignored warnings.
         *
         * @param {any} issues The `issues` property that is part of
         * the validation report of the glTF Validator
         * @returns The div string
         */
        getValidationInfoDiv: function (issues) {
            let info = "";
            let color = "white";
            const padding = this.isMobile ? "right:-3px;top:-18px;" : "right:-18px;top:-18px;";
            if (this.validationReport?.error) {
                info = "X";
                color = "red";
                return (
                    `<div style="display:flex;color:black; position:absolute; ${padding} ` +
                    `font-size:80%; font-weight:bold; background-color:${color}; border-radius:50%; width:fit-content; ` +
                    `min-width:2rem; align-items:center;aspect-ratio:1/1;justify-content:center;">${info}</div>`
                );
            }
            if (!issues) {
                return "";
            }
            if (issues.numErrors > 0) {
                info = `${issues.numErrors}`;
                color = "red";
            } else if (issues.numWarnings > 0) {
                const allIgnored =
                    issues.numWarnings === this.validationReportDescription?.numIgnoredWarnings;
                if (allIgnored) {
                    info = "i";
                    color = "lightBlue";
                } else {
                    info = `${issues.numWarnings}`;
                    color = "yellow";
                }
            } else if (issues.numInfos > 0) {
                info = `${issues.numInfos}`;
            }
            if (info.length > 3) {
                info = "999+";
            }
            if (info === "") {
                return "";
            }
            const infoDiv =
                `<div style="display:flex;color:black; position:absolute; ${padding} ` +
                `font-size:80%; font-weight:bold; background-color:${color}; border-radius:50%; width:fit-content; ` +
                `min-width:2rem; align-items:center;aspect-ratio:1/1;justify-content:center;">${info}</div>`;
            return infoDiv;
        },

        getValidationCounter: function () {
            // Expected and harmless messages (see validation_summary.js) do not count
            const infoDiv = this.getValidationInfoDiv(this.validationSummary?.counts ?? this.validationReport?.issues);
            if (this.tabContentHidden === false && this.activeTab === 2) {
                return (
                    `<div style="position:relative; width:50px; height:100%">` +
                    `<img src="assets/ui/Capture 50X50.svg" width="50px" height="100%">` +
                    infoDiv +
                    `</div>`
                );
            }
            return (
                `<div style="position:relative; width:50px; height:100%">` +
                `<img src="assets/ui/Capture 30X30.svg" width="30px">` +
                infoDiv +
                `</div>`
            );
        },
        iblTriggered: function (value) {
            if (value == false) {
                this.environmentVisiblePrefState = this.renderEnv;
                this.renderEnv = false;
                this.renderEnvChanged.next(false);
            } else {
                this.renderEnv = this.environmentVisiblePrefState;
                this.renderEnvChanged.next(this.renderEnv);
            }
        },
        collapseActiveTab: function (event, item) {
            if (item === this.activeTab) {
                this.tabContentHidden = !this.tabContentHidden;

                if (this.tabContentHidden) {
                    // remove is-active class if tabs are hidden
                    event.stopPropagation();

                    const navElements =
                        document.getElementById("tabsContainer").children[0].children[0].children;
                    for (let elem of navElements) {
                        elem.classList.remove("is-active");
                    }
                } else {
                    // add is-active class to correct element
                    const activeNavElement =
                        document.getElementById("tabsContainer").children[0].children[0].children[
                            this.activeTabIndex
                        ];
                    activeNavElement.classList.add("is-active");
                }
            } else {
                // reset tab visibility
                this.tabContentHidden = false;
            }
            this.activeTab = item;
        },
        textureFolderStatus(folder) {
            switch (folder.status) {
                case "scanning":
                    return "scanning…";
                case "ready":
                    return `${folder.fileCount.toLocaleString()}${folder.truncated ? "+" : ""} textures`;
                case "needsAccess":
                    return "access needed";
                default:
                    return `error: ${folder.error}`;
            }
        },
        msfsSummaryCount(status) {
            return this.inspectorMaterialSummary.filter((row) => row.status === status).length;
        },
        toggleInspectorNode(index) {
            this.inspectorExpanded[index] = !this.inspectorExpanded[index];
        },
        setInspectorExpandedAll(expanded) {
            const state = {};
            for (const row of this.inspectorNodes) {
                state[row.index] = expanded;
            }
            this.inspectorExpanded = state;
        },
        msfsAnimationProgress(entry) {
            return entry.maxFrame > entry.minFrame ? ((entry.frame - entry.minFrame) / (entry.maxFrame - entry.minFrame)) * 100 : 0;
        },
        // Click: select one; Ctrl/Cmd-click: add or remove; Shift-click: range in the visible order
        selectMsfsAnimation(index, event) {
            let selected;
            if (event?.shiftKey && this.msfsAnimationAnchor !== undefined) {
                const order = this.visibleMsfsAnimations.map((entry) => entry.index);
                const from = order.indexOf(this.msfsAnimationAnchor);
                const to = order.indexOf(index);
                if (from !== -1 && to !== -1) {
                    selected = order.slice(Math.min(from, to), Math.max(from, to) + 1);
                }
            }
            if (selected === undefined) {
                if (event?.ctrlKey || event?.metaKey) {
                    selected = this.msfsAnimationSelected.includes(index)
                        ? this.msfsAnimationSelected.filter((i) => i !== index)
                        : [...this.msfsAnimationSelected, index];
                } else {
                    selected = [index];
                }
                this.msfsAnimationAnchor = index;
            }
            this.msfsAnimationSelectionChanged.next(selected);
        },
        selectShownMsfsAnimations() {
            this.msfsAnimationSelectionChanged.next(this.visibleMsfsAnimations.map((entry) => entry.index));
        },
        toggleMsfsAnimationGroup(name) {
            this.msfsAnimationGroupsOpen[name] = !this.msfsAnimationGroupsOpen[name];
        },
        // After a viewport pick: open the groups of the selected animations and scroll to the first
        revealMsfsAnimations(indices) {
            for (const entry of this.msfsAnimations) {
                if (indices.includes(entry.index)) {
                    this.msfsAnimationGroupsOpen[entry.group] = true;
                }
            }
            this.$nextTick(() => {
                document.getElementById(`msfsAnimRow${indices[0]}`)?.scrollIntoView({ block: "nearest" });
            });
        },
        toggleValidationGroup(key) {
            this.validationOpenGroups[key] = !this.validationOpenGroups[key];
        },
        showValidationItem(item) {
            if (item.node !== undefined) {
                this.showInspectorNode(item.node);
            } else if (item.material !== undefined) {
                this.showMaterial(item.material);
            }
        },
        // Switches to a sidebar tab by clicking its header, as the user would.
        showTab(id) {
            if (this.activeTab !== id || this.tabContentHidden) {
                document.getElementById(`tabHeader${id}`)?.click();
            }
        },
        showMaterial(index) {
            this.showTab(MaterialsTab);
            this.materialSelectionChanged.next(index);
        },
        showInspectorNode(index) {
            this.showTab(InspectorTab);
            this.inspectorSelectionChanged.next(index);
            this.revealInspectorNode(index);
        },
        // Shows or hides the parts using a material; main.js applies the new list.
        setMaterialHidden(index, hidden) {
            const others = this.materialsHidden.filter((other) => other !== index);
            this.materialHiddenChanged.next(hidden ? [...others, index] : others);
        },
        // Material editor spinners (3ds Max style): rounded display, range clamp, arrow steps
        formatMaxNumber(field) {
            const value = Number(field.value);
            if (!Number.isFinite(value)) {
                return field.value;
            }
            return field.integer ? Math.round(value) : Math.round(value * 1000) / 1000;
        },
        clampMaxNumber(field, value) {
            if (!Number.isFinite(value)) {
                return field.value;
            }
            const min = field.min ?? -Infinity;
            const max = field.max ?? Infinity;
            return Math.min(max, Math.max(min, value));
        },
        stepMaxNumber(field, direction) {
            this.setMaxNumber(field, Number(field.value) + direction * (field.step || 0.01));
        },
        // field.scale: shown scaled (glass width in mm); main.js converts back
        setMaxNumber(field, value) {
            let clamped = this.clampMaxNumber(field, value);
            clamped = field.integer ? Math.round(clamped) : Math.round(clamped * 100000) / 100000;
            this.materialParamChanged.next({ param: field.param, value: clamped });
        },
        revealMaterial(index) {
            const group = this.materialsList.find((row) => row.index === index)?.group;
            if (group !== undefined && this.materialsCollapsed[group.key]) {
                this.materialsCollapsed = { ...this.materialsCollapsed, [group.key]: false };
            }
            this.$nextTick(() => {
                document.getElementById(`materialRow${index}`)?.scrollIntoView({ block: "nearest" });
            });
        },
        // Expands the selected node's ancestors and scrolls its row into view (after a viewport pick).
        revealInspectorNode(index) {
            const byIndex = new Map(this.inspectorNodes.map((row) => [row.index, row]));
            for (let parent = byIndex.get(index)?.parent; parent !== undefined; parent = byIndex.get(parent).parent) {
                this.inspectorExpanded[parent] = true;
            }
            this.$nextTick(() => {
                document.getElementById(`inspectorRow${index}`)?.scrollIntoView({ block: "nearest" });
            });
        },
        toggleMaterialGroup(key) {
            this.materialsCollapsed = { ...this.materialsCollapsed, [key]: !this.materialsCollapsed[key] };
        },
        setMaterialGroupsCollapsed(collapsed) {
            const state = {};
            for (const row of this.materialsList) {
                if (row.group !== undefined) {
                    state[row.group.key] = collapsed;
                }
            }
            this.materialsCollapsed = state;
        },
        togglePackageCollapsed(id) {
            this.packageCollapsed = { ...this.packageCollapsed, [id]: !this.packageCollapsed[id] };
        },
        setPackageCollapsedAll(collapsed) {
            const state = {};
            for (const row of this.packageRows) {
                if (row.hasChildren) {
                    state[row.id] = collapsed;
                }
            }
            this.packageCollapsed = state;
        },
        info(message) {
            this.$buefy.toast.open({
                message: message,
                type: "is-success",
                duration: 4000
            });
        },
        warn(message) {
            this.$buefy.toast.open({
                message: message,
                type: "is-warning"
            });
        },
        error(message, duration = 5000) {
            this.$buefy.toast.open({
                message: message,
                type: "is-danger",
                duration: duration
            });
        },
        goToLoadingState() {
            if (this.loadingComponent !== undefined) {
                return;
            }
            this.loadingComponent = this.$buefy.loading.open({
                container: null
            });
        },
        exitLoadingState() {
            if (this.loadingComponent === undefined) {
                return;
            }
            this.loadingComponent.close();
            this.loadingComponent = undefined;
        },
        onFileChange(e) {
            const file = e.target.files[0];
            this.addEnvironmentChanged.next({ hdr_path: file });
        },

        toggleUI() {
            this.uiVisible = !this.uiVisible;
        }
    }
});

appCreated.use(Buefy);

// general components
appCreated.component("toggle-button", {
    props: ["ontext", "offtext", "btnClass", "modelValue"],
    emits: ["buttonclicked", "update:modelValue"],
    template: "#toggleButtonTemplate",
    data() {
        return {
            name: "Play",
            isOn: false
        };
    },
    mounted() {
        this.name = this.offtext;
        // Initialize state from modelValue prop if provided
        if (this.modelValue !== undefined) {
            this.isOn = this.modelValue;
            this.name = this.isOn ? this.ontext : this.offtext;
        }
    },
    watch: {
        // Watch for external changes to modelValue
        modelValue(newValue) {
            if (newValue !== this.isOn) {
                this.isOn = newValue;
                this.name = this.isOn ? this.ontext : this.offtext;
            }
        }
    },
    methods: {
        buttonclicked: function () {
            this.isOn = !this.isOn;
            this.name = this.isOn ? this.ontext : this.offtext;
            this.$emit("buttonclicked", this.isOn);
            this.$emit("update:modelValue", this.isOn);
        },
        setState: function (value) {
            this.isOn = value;
            this.name = this.isOn ? this.ontext : this.offtext;
            this.$emit("update:modelValue", this.isOn);
        }
    }
});
appCreated.component("json-to-ui-template", {
    props: ["data", "isinner"],
    template: "#jsonToUITemplate"
});

export const app = appCreated.mount("#app");

const canvasUI = createApp({
    data() {
        return {
            timer: null
        };
    },
    methods: {}
});

canvasUI.use(Buefy);

canvasUI.mount("#canvasUI");

// pipe error messages to UI
(() => {
    const originalWarn = console.warn;
    const originalError = console.error;

    console.warn = function (txt) {
        app.warn(txt);
        originalWarn.apply(console, arguments);
    };
    console.error = function (txt) {
        app.error(txt);
        originalError.apply(console, arguments);
    };

    window.onerror = function (msg, url, lineNo, columnNo, error) {
        // If error is not from the sample viewer, ignore it
        if (url === undefined || url === null || url === "") {
            return;
        }
        app.error(
            [
                "Message: " + msg,
                "URL: " + url,
                "Line: " + lineNo,
                "Column: " + columnNo,
                "Error object: " + JSON.stringify(error)
            ].join(" - ")
        );
    };
})();
