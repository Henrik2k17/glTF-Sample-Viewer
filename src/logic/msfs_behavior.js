// MSFS model behaviors of a loaded package (Behavior tab): expands the behaviors of every
// attachment, binds the components to the nodes and animations of that attachment and
// evaluates the visibility and animation codes against a variable store the user can change.

import { BehaviorExpander } from "./msfs_behavior_templates.js";
import { comparedValues, compile, run, truthy } from "./msfs_rpn.js";
import { flattenTree } from "./msfs_package.js";

/**
 * @param {object} preset the loaded preset (preset.files: PackageFiles)
 * @param {object[]} items the attachment tree (wrapperNode set by assemblePreset)
 * @param {object[]} nodes the merged glTF's nodes (name, children)
 * @param {object[]} animations the merged glTF's animations (name, extras.msfsPackageItem)
 * @returns {Promise<object>} { visibility: [entry], animations: [entry], variables, problems, outputs }
 *   visibility entry: { id, itemId, itemName, componentId, nodeName, node, code, program }
 *   animation entry: { id, itemId, itemName, componentId, name, length, lag, wrap, animation, code, program }
 *   variable: { key, kind, name, index, unit, users: { visibility: [id], animations: [id] }, values, boolean }
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
        if (result.components.every((component) => component.visibility.length === 0 && component.animations.length === 0)) {
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
            for (const code of component.visibility) {
                visibility.push({
                    id: visibility.length,
                    itemId: item.id,
                    itemName: item.name,
                    componentId: component.id,
                    componentIndex: index,
                    nodeName,
                    node: nodeName === "" ? undefined : nodeByName.get(nodeName) ?? nodeByName.get(nodeName.toLowerCase()),
                    code,
                    program: compile(code),
                    error: undefined,
                    value: undefined
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
                    // component variables (O:) the code keeps between evaluations
                    componentState: new Map()
                });
            }
        });
    }
    progress?.(all.length, all.length);
    problems.push(...expander.problems);

    // variables read by the codes, with the constants they are compared against
    const variables = new Map();
    const compared = new Map();
    const collect = (entries, category) => {
        for (const entry of entries) {
            comparedValues(entry.program, compared);
            for (const ref of entry.program.references) {
                if (ref.write || ref.kind === "O" || ref.kind === "F" || TimeVariables.has(ref.key)) {
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
                        users: { visibility: [], animations: [] }
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
    for (const entry of [...visibility, ...animationEntries]) {
        // codes reading the clock are evaluated every frame
        entry.timeDependent = entry.program.references.some((ref) => TimeVariables.has(ref.key));
    }
    for (const variable of variables.values()) {
        variable.values = [...(compared.get(variable.key) ?? [])].sort((a, b) => a - b);
        // on/off when only compared with 0 and 1 and not used as a number by an animation
        variable.boolean =
            variable.values.every((value) => value === 0 || value === 1) && variable.users.animations.length === 0;
    }
    const sortedVariables = [...variables.values()].sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.index.localeCompare(b.index)
    );
    return { visibility, animations: animationEntries, variables: sortedVariables, problems, outputs };
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

// Reads see the store; writes to component variables (O:) are kept per entry, other writes
// (L:, K: events, ...) are not emulated yet.
const environmentOf = (store, entry) => ({
    get: (ref) => (ref.kind === "O" ? entry.componentState?.get(ref.key) ?? 0 : store.get(ref)),
    set: (ref, value) => {
        if (ref.kind === "O") {
            entry.componentState?.set(ref.key, value);
        }
    }
});

/**
 * Evaluates every visibility code. Returns Map<node, visible>: a node is visible when all
 * of its visibility codes are non-zero.
 */
function evaluateVisibility(behaviors, store) {
    const nodes = new Map();
    for (const entry of behaviors.visibility) {
        const { value, error } = run(entry.program, environmentOf(store, entry));
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
 * Evaluates every animation code: entry.target = the keyframe the animation goes to, the code
 * value clamped to [0, length] (wrapped into it with Wrap).
 */
function evaluateAnimations(behaviors, store, entries = behaviors.animations) {
    for (const entry of entries) {
        const { value, error } = run(entry.program, environmentOf(store, entry));
        const number = typeof value === "number" ? value : Number(value) || 0;
        entry.value = value;
        entry.error = error;
        const length = entry.length > 0 ? entry.length : 100;
        entry.target = entry.wrap
            ? ((number % length) + length) % length
            : Math.min(length, Math.max(0, Number.isFinite(number) ? number : 0));
    }
}

export { VariableStore, buildBehaviors, evaluateAnimations, evaluateVisibility };
