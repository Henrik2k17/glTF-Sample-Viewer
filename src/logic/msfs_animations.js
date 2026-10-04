// MSFS animation panel helpers: groups animations by name prefix, finds the parts and materials
// they move, and finds the animations that move a picked part.

import { collectSubtree } from "./inspector.js";

// "Fuselage_Door_L1_Handle" in group "Fuselage" -> "Door L1 Handle"
function shortName(title, group) {
    const rest = group !== undefined && title.startsWith(group + "_") ? title.slice(group.length + 1) : title;
    return rest.replace(/_+/g, " ").trim() || title;
}

/**
 * Panel entries for the glTF's animations. Animations whose first name segment (before "_")
 * is shared by at least two animations form a group; the rest go to "Other".
 */
function buildMsfsAnimationEntries(gltf, fps) {
    const prefixOf = (title) => (title.includes("_") ? title.split("_")[0] : undefined);
    const titles = gltf.animations.map((animation, index) => animation.name ?? `Animation ${index}`);
    const counts = new Map();
    for (const title of titles) {
        const prefix = prefixOf(title);
        if (prefix !== undefined) {
            counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
        }
    }
    return gltf.animations.map((animation, index) => {
        animation.computeMinMaxTime(gltf);
        const title = titles[index];
        const prefix = prefixOf(title);
        const group = prefix !== undefined && counts.get(prefix) >= 2 ? prefix : "Other";
        const minFrame = Math.round((animation.minTime ?? 0) * fps);
        const maxFrame = Math.round((animation.maxTime ?? 0) * fps);
        const nodes = new Set();
        const materials = new Set();
        for (const channel of animation.channels ?? []) {
            if (channel.target?.node !== undefined) {
                nodes.add(channel.target.node);
            }
            const pointer = channel.target?.extensions?.KHR_animation_pointer?.pointer;
            const material = /^\/materials\/(\d+)\//.exec(pointer ?? "");
            if (material) {
                materials.add(Number(material[1]));
            }
        }
        return {
            index,
            title,
            group,
            short: shortName(title, group === "Other" ? undefined : group),
            search: title.toLowerCase().replace(/_/g, " "),
            minFrame,
            maxFrame,
            frame: minFrame,
            playing: false,
            direction: 1,
            active: false,
            nodes: [...nodes],
            materials: [...materials]
        };
    });
}

/** Nodes (with their subtrees) and materials moved or changed by the given entries. */
function getAnimatedTargets(gltf, entries) {
    const nodes = new Set();
    const materials = new Set();
    for (const entry of entries) {
        for (const node of entry.nodes) {
            for (const index of collectSubtree(gltf, node)) {
                nodes.add(index);
            }
        }
        for (const material of entry.materials) {
            materials.add(material);
        }
    }
    return { nodes, materials };
}

/**
 * The animations that move a node: those targeting the node itself, or else the nearest
 * ancestor that is animated. Also checks the materials of the node's mesh.
 * @returns {number[]} animation indices
 */
function findAnimationsForNode(gltf, entries, nodeIndex) {
    const node = gltf.nodes[nodeIndex];
    const materials = new Set(gltf.meshes[node?.mesh]?.primitives.map((p) => p.material) ?? []);
    const byMaterial = entries.filter((entry) => entry.materials.some((m) => materials.has(m)));
    for (let current = node; current !== undefined; current = current.parentNode) {
        const found = entries.filter((entry) => entry.nodes.includes(current.gltfObjectIndex));
        if (found.length > 0) {
            return [...new Set([...found, ...byMaterial])].map((entry) => entry.index);
        }
    }
    return byMaterial.map((entry) => entry.index);
}

export { buildMsfsAnimationEntries, findAnimationsForNode, getAnimatedTargets };
