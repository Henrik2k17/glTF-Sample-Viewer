// MSFS model behaviors of a loaded package (Behavior tab): expands the behaviors of every
// attachment, binds the components to the nodes of that attachment and evaluates the
// visibility codes against a variable store the user can change.

import { BehaviorExpander } from "./msfs_behavior_templates.js";
import { comparedValues, compile, run, truthy } from "./msfs_rpn.js";
import { flattenTree } from "./msfs_package.js";

/**
 * @param {object} preset the loaded preset (preset.files: PackageFiles)
 * @param {object[]} items the attachment tree (wrapperNode set by assemblePreset)
 * @param {object[]} nodes the merged glTF's node JSON (name, children)
 * @returns {Promise<object>} { visibility: [entry], variables: [variable], problems, outputs }
 *   entry: { id, itemId, itemName, componentId, nodeName, node (index|undefined), code,
 *            program, error, references }
 */
async function buildBehaviors(preset, items, nodes, progress = undefined) {
    const files = preset.files;
    const expander = new BehaviorExpander({
        readFile: async (path) => (files.has(path) ? await files.text(path) : undefined),
        defsRoots: ["ModelBehaviorDefs"]
    });
    const all = flattenTree(items).map((row) => row.item);
    const wrappers = new Map(all.filter((item) => item.wrapperNode !== undefined).map((item) => [item.wrapperNode, item]));
    const visibility = [];
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
        if (result.components.every((component) => component.visibility.length === 0)) {
            continue;
        }
        const nodeByName = nodesOfItem(item, nodes, wrappers);
        result.components.forEach((component, index) => {
            if (component.visibility.length === 0) {
                return;
            }
            // a component without a node acts on the node of the component it is in
            let nodeName = component.node;
            for (let parent = component.parent; nodeName === "" && parent >= 0; parent = result.components[parent].parent) {
                nodeName = result.components[parent].node;
            }
            for (const code of component.visibility) {
                const program = compile(code);
                visibility.push({
                    id: visibility.length,
                    itemId: item.id,
                    itemName: item.name,
                    componentId: component.id,
                    componentIndex: index,
                    nodeName,
                    node: nodeName === "" ? undefined : nodeByName.get(nodeName) ?? nodeByName.get(nodeName.toLowerCase()),
                    code,
                    program,
                    error: undefined,
                    value: undefined
                });
            }
        });
    }
    progress?.(all.length, all.length);
    problems.push(...expander.problems);

    // variables read by the visibility codes, with the constants they are compared against
    const variables = new Map();
    const compared = new Map();
    for (const entry of visibility) {
        comparedValues(entry.program, compared);
        for (const ref of entry.program.references) {
            if (ref.write) {
                continue;
            }
            let variable = variables.get(ref.key);
            if (variable === undefined) {
                variable = { key: ref.key, kind: ref.kind, name: ref.name, index: ref.index, unit: ref.unit, users: [] };
                variables.set(ref.key, variable);
            }
            if (!variable.users.includes(entry.id)) {
                variable.users.push(entry.id);
            }
        }
    }
    for (const variable of variables.values()) {
        variable.values = [...(compared.get(variable.key) ?? [])].sort((a, b) => a - b);
        // on/off unless compared against something other than 0 and 1
        variable.boolean = variable.values.every((value) => value === 0 || value === 1);
    }
    const sortedVariables = [...variables.values()].sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.index.localeCompare(b.index)
    );
    return { visibility, variables: sortedVariables, problems, outputs };
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
            if (other !== undefined && other !== item && !(item.kind === "model" && other.kind === "merge" && other.model === item.model)) {
                continue;
            }
            queue.push(child);
        }
    }
    return byName;
}

/** Variable values (0 when never set), keyed by variable key. */
class VariableStore {
    constructor() {
        this.values = new Map();
    }
    get(ref) {
        return this.values.get(ref.key) ?? 0;
    }
    set(ref, value) {
        this.values.set(ref.key, value);
    }
    setKey(key, value) {
        this.values.set(key, value);
    }
    valueOf(key) {
        return this.values.get(key) ?? 0;
    }
}

/**
 * Evaluates every visibility code. Returns Map<node, visible>: a node is visible when all
 * of its visibility codes are non-zero.
 */
function evaluateVisibility(behaviors, store) {
    const nodes = new Map();
    // codes may write variables; reads see the store, writes are not kept
    const env = { get: (ref) => store.get(ref), set: () => {} };
    for (const entry of behaviors.visibility) {
        const { value, error } = run(entry.program, env);
        entry.value = value;
        entry.error = error;
        entry.visible = truthy(value);
        if (entry.node !== undefined) {
            nodes.set(entry.node, (nodes.get(entry.node) ?? true) && entry.visible);
        }
    }
    return nodes;
}

export { VariableStore, buildBehaviors, evaluateVisibility };
