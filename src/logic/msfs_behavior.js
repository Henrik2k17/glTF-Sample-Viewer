// MSFS model behaviors of a loaded package (Behavior tab): expands the behaviors of every
// attachment, binds the components to the nodes and animations of that attachment and
// evaluates the visibility and animation codes against a variable store the user can change.
// Mouse rects make parts clickable: their callback code runs on mouse events and writes L:
// variables and input events (B:), which the codes read again. Key events (K:) the codes send
// change the simvars they stand for (msfs_key_events.js).

import { BehaviorExpander } from "./msfs_behavior_templates.js";
import { runKeyEvent } from "./msfs_key_events.js";
import { comparedValues, compile, run, truthy } from "./msfs_rpn.js";
import { flattenTree } from "./msfs_package.js";

/**
 * @param {object} preset the loaded preset (preset.files: PackageFiles)
 * @param {object[]} items the attachment tree (wrapperNode set by assemblePreset)
 * @param {object[]} nodes the merged glTF's nodes (name, children)
 * @param {object[]} animations the merged glTF's animations (name, extras.msfsPackageItem)
 * @returns {Promise<object>} { visibility: [entry], animations: [entry], emissive: [entry], updates: [entry], interactions: [entry],
 *   inputEvents, variables, problems, outputs }
 *   visibility entry: { id, itemId, itemName, componentId, nodeName, node, code, program }
 *   animation entry: { id, itemId, itemName, componentId, name, length, lag, wrap, animation, code, program }
 *   emissive entry: { id, itemId, itemName, componentId, nodeName, node, override, code, program }
 *   update entry: { id, itemId, itemName, componentId, nodeName, once, frequency, interactionModel, code, program }
 *   interaction entry: { id, itemId, itemName, componentId, nodeName, node, flags, tooltip, code, program }
 *   inputEvents: Map<upper-case ID, { id, units, programs: { Value, Inc, Dec, Set, Toggle }, componentState }>
 *   variable: { key, kind, name, index, unit, users: { visibility: [id], animations: [id], emissive: [id], interactions: [id] },
 *     values, boolean }
 */
async function buildBehaviors(preset, items, nodes, animations = [], progress = undefined) {
    const files = preset.files;
    const expander = new BehaviorExpander({
        readFile: async (path) => (files.has(path) ? await files.text(path) : undefined),
        defsRoots: ["ModelBehaviorDefs"]
    });
    const all = flattenTree(items).map((row) => row.item);
    const wrappers = new Map(all.filter((item) => item.wrapperNode !== undefined).map((item) => [item.wrapperNode, item]));
    const itemsById = new Map(all.map((item) => [item.id, item]));
    const visibility = [];
    const animationEntries = [];
    const emissive = [];
    const updates = [];
    const interactions = [];
    const inputEvents = new Map();
    const outputs = {};
    const problems = [];
    let done = 0;
    for (const item of all) {
        progress?.(done++, all.length);
        if (item.kind === "merge" || item.external || !item.path || !/\.xml$/i.test(item.path) || item.wrapperNode === undefined) {
            continue;
        }
        let result;
        try {
            result = await expander.expandModel(item.path);
        } catch (error) {
            problems.push(`${item.name}: ${error.message}`);
            continue;
        }
        for (const [name, count] of Object.entries(result.outputs)) {
            outputs[name] = (outputs[name] ?? 0) + count;
        }
        if (
            result.components.every(
                (component) =>
                    component.visibility.length === 0 &&
                    component.animations.length === 0 &&
                    component.emissive.length === 0 &&
                    component.updates.length === 0 &&
                    component.mouseRects.length === 0 &&
                    component.inputEvents.length === 0
            )
        ) {
            continue;
        }
        const nodeByName = nodesOfItem(item, nodes, wrappers);
        const animationByName = animationsOfItem(item, animations, itemsById);
        result.components.forEach((component, index) => {
            // a component without a node acts on the node of the component it is in
            let nodeName = component.node;
            for (let parent = component.parent; nodeName === "" && parent >= 0; parent = result.components[parent].parent) {
                nodeName = result.components[parent].node;
            }
            const node = nodeName === "" ? undefined : nodeByName.get(nodeName) ?? nodeByName.get(nodeName.toLowerCase());
            // component variables (O:), shared by the codes of the component and kept between evaluations
            const componentState = new Map();
            for (const code of component.visibility) {
                visibility.push({
                    id: visibility.length,
                    itemId: item.id,
                    itemName: item.name,
                    componentId: component.id,
                    componentIndex: index,
                    nodeName,
                    node,
                    code,
                    program: compile(code),
                    error: undefined,
                    value: undefined,
                    componentState
                });
            }
            for (const animation of component.animations) {
                animationEntries.push({
                    id: animationEntries.length,
                    itemId: item.id,
                    itemName: item.name,
                    componentId: component.id,
                    name: animation.name,
                    length: animation.length,
                    lag: animation.lag,
                    wrap: animation.wrap,
                    type: animation.type,
                    // index of the glTF animation (matched by name, ignoring case)
                    animation: animationByName.get(animation.name.toLowerCase()),
                    code: animation.code,
                    program: compile(animation.code),
                    error: undefined,
                    value: undefined,
                    target: undefined,
                    componentState
                });
            }
            for (const material of component.emissive) {
                emissive.push({
                    id: emissive.length,
                    itemId: item.id,
                    itemName: item.name,
                    componentId: component.id,
                    nodeName,
                    node,
                    override: material.override,
                    code: material.code,
                    program: compile(material.code),
                    error: undefined,
                    value: undefined,
                    componentState
                });
            }
            for (const update of component.updates) {
                // the sim's Drag interaction model is not emulated (clicks are Default / Lock)
                if (update.interactionModel.toLowerCase() === "drag") {
                    continue;
                }
                updates.push({
                    id: updates.length,
                    itemId: item.id,
                    itemName: item.name,
                    componentId: component.id,
                    nodeName,
                    once: update.once,
                    frequency: update.frequency,
                    interactionModel: update.interactionModel,
                    code: update.code,
                    program: compile(update.code),
                    error: undefined,
                    componentState
                });
            }
            for (const rect of component.mouseRects) {
                const highlight = rect.highlightNode === "" ? undefined : nodeByName.get(rect.highlightNode) ?? nodeByName.get(rect.highlightNode.toLowerCase());
                interactions.push({
                    id: interactions.length,
                    itemId: item.id,
                    itemName: item.name,
                    componentId: component.id,
                    nodeName,
                    node,
                    // the part the sim highlights under the cursor (the component's node when not given)
                    highlightNode: highlight ?? node,
                    flags: rect.flags,
                    tooltip: rect.tooltip,
                    code: rect.code,
                    program: compile(rect.code),
                    error: undefined,
                    componentState
                });
            }
            for (const event of component.inputEvents) {
                const key = event.id.toUpperCase();
                if (event.id === "" || inputEvents.has(key)) {
                    continue;
                }
                const programs = {};
                for (const [action, code] of Object.entries(event.codes)) {
                    programs[action] = compile(code);
                }
                inputEvents.set(key, { id: event.id, units: event.units, itemName: item.name, componentId: component.id, programs, componentState });
            }
        });
    }
    progress?.(all.length, all.length);
    problems.push(...expander.problems);

    // variables read by the codes, with the constants they are compared against
    const variables = new Map();
    const compared = new Map();
    // The variables an input event (B:EVENT) stands in for: what its Value code reads, and for
    // callbacks (writes) also what its action codes read and write.
    const referencesOf = (program, writes, seen = new Set()) =>
        program.references.flatMap((ref) => {
            if (ref.kind !== "B") {
                return [ref];
            }
            const match = ref.write ? ActionSuffix.exec(ref.name) : null;
            const event = inputEvents.get((match ? ref.name.substring(0, match.index) : ref.name).toUpperCase());
            if (event === undefined) {
                return [ref];
            }
            const programs = [event.programs.Value];
            if (writes && ref.write) {
                const action = match ? match[1].toLowerCase() : "set";
                programs.push(...Object.entries(event.programs).filter(([name]) => name.toLowerCase() === action).map(([, code]) => code));
                if (action === "toggle") {
                    programs.push(event.programs.Set);
                }
            }
            return programs
                .filter((code) => code !== undefined && !seen.has(code))
                .flatMap((code) => {
                    seen.add(code);
                    comparedValues(code, compared);
                    return referencesOf(code, writes, seen);
                });
        });
    const collect = (entries, category, writes = false) => {
        for (const entry of entries) {
            comparedValues(entry.program, compared);
            for (const ref of referencesOf(entry.program, writes)) {
                if (
                    (ref.write && !writes) ||
                    ["O", "F", "M", "R", "K"].includes(ref.kind) ||
                    (ref.kind === "B" && ref.write) ||
                    TimeVariables.has(ref.key)
                ) {
                    continue;
                }
                let variable = variables.get(ref.key);
                if (variable === undefined) {
                    variable = {
                        key: ref.key,
                        kind: ref.kind,
                        name: ref.name,
                        index: ref.index,
                        unit: ref.unit,
                        users: { visibility: [], animations: [], emissive: [], interactions: [] }
                    };
                    variables.set(ref.key, variable);
                }
                if (!variable.users[category].includes(entry.id)) {
                    variable.users[category].push(entry.id);
                }
            }
        }
    };
    collect(visibility, "visibility");
    collect(animationEntries, "animations");
    collect(emissive, "emissive");
    collect(interactions, "interactions", true);
    for (const entry of [...visibility, ...animationEntries, ...emissive]) {
        // codes reading the clock are evaluated every frame
        entry.timeDependent = entry.program.references.some((ref) => TimeVariables.has(ref.key));
    }
    for (const variable of variables.values()) {
        variable.values = [...(compared.get(variable.key) ?? [])].sort((a, b) => a - b);
        // on/off when only compared with 0 and 1 and not used as a number by an animation, or by
        // an emissive code that never compares it (a brightness, e.g. A:AMBIENT LIGHT SENSOR)
        variable.boolean =
            variable.values.every((value) => value === 0 || value === 1) &&
            variable.users.animations.length === 0 &&
            !(variable.users.emissive.length > 0 && variable.values.length === 0);
    }
    const sortedVariables = [...variables.values()].sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.index.localeCompare(b.index)
    );
    // simvar name -> the A: keys (with their indices) the codes read, where key events write
    const simvarKeys = new Map();
    const programs = [
        ...[...visibility, ...animationEntries, ...emissive, ...updates, ...interactions].map((entry) => entry.program),
        ...[...inputEvents.values()].flatMap((event) => Object.values(event.programs))
    ];
    for (const program of programs) {
        for (const ref of program.references) {
            if (ref.kind === "A" && !ref.write) {
                const name = ref.name.toUpperCase();
                if (!simvarKeys.has(name)) {
                    simvarKeys.set(name, new Set());
                }
                simvarKeys.get(name).add(ref.key);
            }
        }
    }
    return {
        visibility,
        animations: animationEntries,
        emissive,
        updates,
        interactions,
        inputEvents,
        simvarKeys,
        variables: sortedVariables,
        problems,
        outputs
    };
}

/**
 * Name -> merged node index for the nodes an item brought in (its glTFs). Other attachments
 * placed below its nodes are left out; a model also owns the models merged into it.
 */
function nodesOfItem(item, nodes, wrappers) {
    const byName = new Map();
    const queue = [item.wrapperNode];
    while (queue.length > 0) {
        const index = queue.shift();
        const node = nodes[index];
        if (node === undefined) {
            continue;
        }
        if (node.name !== undefined) {
            if (!byName.has(node.name)) {
                byName.set(node.name, index);
            }
            if (!byName.has(node.name.toLowerCase())) {
                byName.set(node.name.toLowerCase(), index);
            }
        }
        for (const child of node.children ?? []) {
            const other = wrappers.get(child);
            if (other !== undefined && other !== item && !ownsMerge(item, other)) {
                continue;
            }
            queue.push(child);
        }
    }
    return byName;
}

const ownsMerge = (item, other) => item.kind === "model" && other.kind === "merge" && other.model === item.model;

/** Lower-case name -> merged animation index for the animations of an item's glTFs. */
function animationsOfItem(item, animations, itemsById) {
    const byName = new Map();
    animations.forEach((animation, index) => {
        const owner = itemsById.get(animation.extras?.msfsPackageItem);
        if (owner === undefined || (owner !== item && !ownsMerge(item, owner)) || !animation.name) {
            return;
        }
        const key = animation.name.toLowerCase();
        if (!byName.has(key)) {
            byName.set(key, index);
        }
    });
    return byName;
}

// Sim clock variables, provided by the runtime (store.time, store.deltaTime)
const TimeVariables = new Set(["A:ANIMATION DELTA TIME", "E:SIMULATION TIME", "E:ABSOLUTE TIME", "E:ZULU TIME", "E:LOCAL TIME"]);

// Units the same variable is read in: value in the unit * scale = value in the base unit
const UnitScales = new Map([
    ["percent", 0.01],
    ["percent over 100", 1],
    ["percent_over_100", 1],
    ["degrees", Math.PI / 180],
    ["degree", Math.PI / 180],
    ["radians", 1],
    ["radian", 1],
    ["feet", 0.3048],
    ["foot", 0.3048],
    ["ft", 0.3048],
    ["meters", 1],
    ["meter", 1],
    ["m", 1]
]);
const unitScale = (unit) => UnitScales.get((unit ?? "").trim().toLowerCase().replace(/\s+/g, " ")) ?? 1;

/**
 * Variable values (0 when never set), keyed by variable key and kept in a base unit, so a
 * simvar read as "percent" and as "percent over 100" is the same value.
 */
class VariableStore {
    constructor() {
        this.values = new Map();
        this.time = 0; // seconds since the model was loaded
        this.deltaTime = 0; // seconds since the last frame
    }
    get(ref) {
        if (TimeVariables.has(ref.key)) {
            return ref.key === "A:ANIMATION DELTA TIME" ? this.deltaTime : this.time;
        }
        const value = this.values.get(ref.key) ?? 0;
        return typeof value === "number" ? value / unitScale(ref.unit) : value;
    }
    set(ref, value) {
        this.setKey(ref.key, value, ref.unit);
    }
    /** value in unit (the unit the UI shows the variable in) */
    setKey(key, value, unit = "") {
        this.values.set(key, typeof value === "number" ? value * unitScale(unit) : value);
    }
    valueOf(key, unit = "") {
        return this.get({ key, unit });
    }
}

// Input event actions: (>B:ID_Inc) runs the Inc code of the event ID
const ActionSuffix = /_(Inc|Dec|Set|Toggle)$/i;

/**
 * The environment a code runs in. Reads see the store, component variables (O:) of the
 * entry's component, input event values (B:ID runs the event's Value code) and the mouse (M:).
 * Visibility and animation codes only write component variables; callback and input event
 * codes (session set) also write the store and run input events (B:) and record key events (K:).
 */
function environmentOf(store, entry, behaviors, session = undefined, params = undefined) {
    return {
        params,
        get: (ref) => {
            switch (ref.kind) {
                case "O":
                    return entry.componentState?.get(ref.key) ?? 0;
                case "M":
                    return session?.mouse?.[ref.name.toUpperCase()] ?? 0;
                case "B": {
                    const event = behaviors?.inputEvents?.get(ref.name.toUpperCase());
                    if (event?.programs.Value !== undefined) {
                        return runInputEvent(event, "Value", store, behaviors, session, []).value;
                    }
                    return store.get(ref);
                }
                default:
                    return store.get(ref);
            }
        },
        set: (ref, value) => {
            if (ref.kind === "O") {
                if (session !== undefined && entry.componentState?.get(ref.key) !== value) {
                    session.changed = true;
                }
                entry.componentState?.set(ref.key, value);
                return;
            }
            if (session === undefined) {
                return;
            }
            if (ref.kind === "B") {
                triggerInputEvent(ref.name, value, store, behaviors, session);
            } else if (ref.kind === "K") {
                const args = [value].flat();
                const changes = runKeyEvent(ref.name, args, store, behaviors?.simvarKeys ?? new Map());
                const call = `K:${ref.name} ${args.map(formatValue).join(" ")}`;
                if (changes === undefined) {
                    session.log.push(`${call} (not simulated)`);
                    return;
                }
                const changed = changes.filter((change) => change.before !== change.after);
                for (const change of changes) {
                    session.writes.add(change.key);
                }
                if (changed.length > 0) {
                    session.changed = true;
                }
                session.log.push(
                    changed.length > 0
                        ? `${call} → ${changed.map((change) => `${change.key} = ${formatValue(change.after)}`).join(", ")}`
                        : call
                );
            } else {
                const before = store.get(ref);
                store.set(ref, value);
                session.writes.add(ref.key);
                if (before !== store.get(ref)) {
                    session.changed = true;
                    session.log.push(`${ref.kind}:${ref.name} = ${formatValue(store.get(ref))}`);
                }
            }
        }
    };
}

const formatValue = (value) => (typeof value === "number" ? String(Math.round(value * 1000) / 1000) : `'${value}'`);

function runInputEvent(event, action, store, behaviors, session, params) {
    if (session !== undefined && ++session.depth > 32) {
        session.depth--;
        return { value: 0, error: "input events nested too deep" };
    }
    // Value runs with reads only, the actions with writes
    const result = run(event.programs[action], environmentOf(store, event, behaviors, action === "Value" ? undefined : session, params));
    if (session !== undefined) {
        session.depth--;
        if (result.error !== undefined) {
            session.errors.push(`B:${event.id}_${action}: ${result.error}`);
        }
    }
    return result;
}

/** (>B:ID_Action) or (>B:ID): runs the input event's code with p0 = value. */
function triggerInputEvent(name, value, store, behaviors, session) {
    const match = ActionSuffix.exec(name);
    const id = match ? name.substring(0, match.index) : name;
    const action = match ? match[1][0].toUpperCase() + match[1].substring(1).toLowerCase() : "Set";
    const event = behaviors?.inputEvents?.get(id.toUpperCase());
    if (event === undefined) {
        session.log.push(`B:${name} ${formatValue(value)} (no input event ${id})`);
        return;
    }
    session.log.push(`B:${event.id}_${action}${action === "Toggle" ? "" : " " + formatValue(value)}`);
    if (event.programs[action] !== undefined) {
        runInputEvent(event, action, store, behaviors, session, [value]);
    } else if (action === "Toggle" && event.programs.Set !== undefined) {
        // no Toggle code: set the opposite of the current value
        const current = event.programs.Value !== undefined ? runInputEvent(event, "Value", store, behaviors, session, []).value : 0;
        runInputEvent(event, "Set", store, behaviors, session, [truthy(current) ? 0 : 1]);
    } else {
        session.log.push(`  (B:${event.id} has no ${action} code)`);
    }
}

/**
 * Runs the callback code of a mouse rect for mouse events, e.g. ["LeftSingle"].
 * mouse: { relativeX, relativeY } (M:RelativeX / M:RelativeY). Returns
 * { writes: Set<variable key>, log: [line], errors: [message] }.
 */
function interact(behaviors, store, entry, events, mouse = {}) {
    const session = newSession();
    for (const event of events) {
        session.mouse = { EVENT: event, RELATIVEX: mouse.relativeX ?? 0, RELATIVEY: mouse.relativeY ?? 0, DRAGPERCENT: mouse.dragPercent ?? 0 };
        const { error } = run(entry.program, environmentOf(store, entry, behaviors, session));
        entry.error = error;
        if (error !== undefined) {
            session.errors.push(error);
        }
    }
    return session;
}

const newSession = () => ({ writes: new Set(), log: [], errors: [], depth: 0, mouse: {}, changed: false });

/**
 * Runs update codes (they write the store, component variables and input events like a
 * callback). Returns the session: { writes, log, errors, changed }.
 */
function runUpdates(behaviors, store, entries) {
    const session = newSession();
    for (const entry of entries) {
        const { error } = run(entry.program, environmentOf(store, entry, behaviors, session));
        entry.error = error;
        if (error !== undefined) {
            session.errors.push(`${entry.itemName} / ${entry.nodeName || entry.componentId}: ${error}`);
        }
    }
    return session;
}

/**
 * Evaluates every visibility code. Returns Map<node, visible>: a node is visible when all
 * of its visibility codes are non-zero.
 */
function evaluateVisibility(behaviors, store) {
    const nodes = new Map();
    for (const entry of behaviors.visibility) {
        const { value, error } = run(entry.program, environmentOf(store, entry, behaviors));
        entry.value = value;
        entry.error = error;
        entry.visible = truthy(value);
        if (entry.node !== undefined) {
            nodes.set(entry.node, (nodes.get(entry.node) ?? true) && entry.visible);
        }
    }
    return nodes;
}

/**
 * Evaluates the emissive codes (all, or the given entries). Returns Map<node, scale>: the
 * emissive of the node's meshes is multiplied with the value of its code (several codes on
 * one node multiply). The sim's emissive is texture x emissive factor x vertex colour; the
 * code scales that factor. OverrideBaseEmissive is not told apart (not verified in the sim).
 */
function evaluateEmissive(behaviors, store, entries = behaviors.emissive) {
    for (const entry of entries) {
        const { value, error } = run(entry.program, environmentOf(store, entry, behaviors));
        const number = typeof value === "number" ? value : Number(value) || 0;
        entry.value = value;
        entry.error = error;
        entry.scale = Number.isFinite(number) ? Math.max(0, number) : 0;
    }
    const nodes = new Map();
    for (const entry of behaviors.emissive) {
        if (entry.node !== undefined && entry.scale !== undefined) {
            nodes.set(entry.node, (nodes.get(entry.node) ?? 1) * entry.scale);
        }
    }
    return nodes;
}

/**
 * Evaluates every animation code: entry.target = the keyframe the animation goes to, the code
 * value clamped to [0, length] (wrapped into it with Wrap).
 */
function evaluateAnimations(behaviors, store, entries = behaviors.animations) {
    for (const entry of entries) {
        const { value, error } = run(entry.program, environmentOf(store, entry, behaviors));
        const number = typeof value === "number" ? value : Number(value) || 0;
        entry.value = value;
        entry.error = error;
        const length = entry.length > 0 ? entry.length : 100;
        entry.target = entry.wrap
            ? ((number % length) + length) % length
            : Math.min(length, Math.max(0, Number.isFinite(number) ? number : 0));
    }
}

/**
 * A mouse rect tooltip with its RPN parts evaluated: "%(code)%" is the code's value, and
 * "%(code)%{if}A%{else}B%{end}" picks A or B (may nest). Localization keys (TT:...) stay keys.
 */
function formatTooltip(text, behaviors, store, entry) {
    if (!text.includes("%(")) {
        return text.replace(/^TT:/, "");
    }
    const environment = environmentOf(store, entry, behaviors);
    let i = 0;
    // reads up to one of the stop markers (%{else} / %{end}); returns [text, marker]
    const parse = (stops) => {
        let out = "";
        while (i < text.length) {
            const stop = stops.find((marker) => text.startsWith(marker, i));
            if (stop !== undefined) {
                i += stop.length;
                return [out, stop];
            }
            if (!text.startsWith("%(", i)) {
                out += text[i++];
                continue;
            }
            const end = text.indexOf(")%", i + 2);
            if (end < 0) {
                out += text.substring(i);
                break;
            }
            const value = run(compile(text.substring(i + 2, end)), environment).value;
            i = end + 2;
            if (!text.startsWith("{if}", i)) {
                out += typeof value === "number" ? String(Math.round(value * 100) / 100) : value;
                continue;
            }
            i += 4;
            const [whenTrue, marker] = parse(["%{else}", "%{end}"]);
            const [whenFalse] = marker === "%{else}" ? parse(["%{end}"]) : [""];
            out += truthy(value) ? whenTrue : whenFalse;
        }
        return [out, undefined];
    };
    return parse([])[0].replace(/^TT:/, "");
}

export { VariableStore, buildBehaviors, evaluateAnimations, evaluateEmissive, evaluateVisibility, formatTooltip, interact, runUpdates };
