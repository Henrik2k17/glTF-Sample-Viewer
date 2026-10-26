// Which X-Plane dataref drives an MSFS animation, for the "Export for X-Plane" GLB. An MSFS
// animation is played by a behavior code that reads sim variables; when the code reads a single
// sim variable of the table below, the export samples the code over the dataref's range and
// stores, per sampled dataref value, the glTF animation time the code gives (animation extras
// "xplane": { dataref, simvar, keys: [[value, seconds], ...] }). A Blender add-on turns these
// into X-Plane OBJ keyframes without knowing anything about MSFS.
//
// Control surfaces use the cockpit input ratios rather than the per-wing surface angles
// (sim/flightmodel2/wing/*_deg), which need the Plane Maker wing indices and deflection limits.

import { VariableStore, evaluateAnimations } from "./msfs_behavior.js";

// simvar: name without index; index(i): the dataref index for simvar index i (undefined: none);
// range: dataref values; unit: the unit dataref values are in, as a sim variable unit;
// sign: simvar = sign * dataref.
const Drivers = [
    { simvar: "GEAR ANIMATION POSITION", dataref: "sim/flightmodel2/gear/deploy_ratio", index: (i) => i ?? 0, range: [0, 1], unit: "percent over 100" },
    { simvar: "GEAR POSITION", dataref: "sim/flightmodel2/gear/deploy_ratio", index: (i) => i ?? 0, range: [0, 1], unit: "percent over 100" },
    { simvar: "TRAILING EDGE FLAPS LEFT PERCENT", dataref: "sim/flightmodel2/controls/flap1_deploy_ratio", range: [0, 1], unit: "percent over 100" },
    { simvar: "TRAILING EDGE FLAPS RIGHT PERCENT", dataref: "sim/flightmodel2/controls/flap1_deploy_ratio", range: [0, 1], unit: "percent over 100" },
    { simvar: "AILERON LEFT DEFLECTION PCT", dataref: "sim/cockpit2/controls/yoke_roll_ratio", range: [-1, 1], unit: "percent over 100", sign: 1 },
    { simvar: "AILERON RIGHT DEFLECTION PCT", dataref: "sim/cockpit2/controls/yoke_roll_ratio", range: [-1, 1], unit: "percent over 100", sign: 1 },
    { simvar: "AILERON POSITION", dataref: "sim/cockpit2/controls/yoke_roll_ratio", range: [-1, 1], unit: "percent over 100" },
    { simvar: "ELEVATOR DEFLECTION PCT", dataref: "sim/cockpit2/controls/yoke_pitch_ratio", range: [-1, 1], unit: "percent over 100" },
    { simvar: "ELEVATOR POSITION", dataref: "sim/cockpit2/controls/yoke_pitch_ratio", range: [-1, 1], unit: "percent over 100" },
    { simvar: "RUDDER DEFLECTION PCT", dataref: "sim/cockpit2/controls/yoke_heading_ratio", range: [-1, 1], unit: "percent over 100" },
    { simvar: "RUDDER POSITION", dataref: "sim/cockpit2/controls/yoke_heading_ratio", range: [-1, 1], unit: "percent over 100" },
    { simvar: "ELEVATOR TRIM PCT", dataref: "sim/flightmodel2/controls/elevator_trim", range: [-1, 1], unit: "percent over 100" },
    { simvar: "ELEVATOR TRIM PCT EX1", dataref: "sim/flightmodel2/controls/elevator_trim", range: [-1, 1], unit: "percent over 100" },
    { simvar: "RUDDER TRIM PCT", dataref: "sim/flightmodel2/controls/rudder_trim", range: [-1, 1], unit: "percent over 100" },
    { simvar: "RUDDER TRIM PCT EX1", dataref: "sim/flightmodel2/controls/rudder_trim", range: [-1, 1], unit: "percent over 100" },
    { simvar: "AILERON TRIM PCT", dataref: "sim/flightmodel2/controls/aileron_trim", range: [-1, 1], unit: "percent over 100" },
    { simvar: "AILERON TRIM PCT EX1", dataref: "sim/flightmodel2/controls/aileron_trim", range: [-1, 1], unit: "percent over 100" },
    { simvar: "SPOILERS LEFT POSITION", dataref: "sim/flightmodel2/controls/speedbrake_ratio", range: [0, 1], unit: "percent over 100" },
    { simvar: "SPOILERS RIGHT POSITION", dataref: "sim/flightmodel2/controls/speedbrake_ratio", range: [0, 1], unit: "percent over 100" },
    { simvar: "WHEEL ROTATION ANGLE", dataref: "sim/flightmodel2/gear/tire_rotation_angle_deg", index: (i) => i ?? 0, range: [0, 360], unit: "degrees" },
    { simvar: "CENTER WHEEL ROTATION ANGLE", dataref: "sim/flightmodel2/gear/tire_rotation_angle_deg", index: () => 0, range: [0, 360], unit: "degrees" },
    { simvar: "LEFT WHEEL ROTATION ANGLE", dataref: "sim/flightmodel2/gear/tire_rotation_angle_deg", index: () => 1, range: [0, 360], unit: "degrees" },
    { simvar: "RIGHT WHEEL ROTATION ANGLE", dataref: "sim/flightmodel2/gear/tire_rotation_angle_deg", index: () => 2, range: [0, 360], unit: "degrees" },
    { simvar: "GEAR STEER ANGLE", dataref: "sim/flightmodel2/gear/tire_steer_actual_deg", index: (i) => i ?? 0, range: [-90, 90], unit: "degrees" },
    // MSFS engines count from 1, X-Plane's from 0
    { simvar: "PROP ROTATION ANGLE", dataref: "sim/flightmodel2/engines/prop_rotation_angle_deg", index: (i) => Math.max(0, (i ?? 1) - 1), range: [0, 360], unit: "degrees" },
    { simvar: "PROP BETA", dataref: "sim/flightmodel2/engines/prop_pitch_deg", index: (i) => Math.max(0, (i ?? 1) - 1), range: [-30, 90], unit: "degrees" }
];
const DriversBySimvar = new Map(Drivers.map((driver) => [driver.simvar, driver]));
const SampleCount = 33;

/** Simvar key "A:GEAR ANIMATION POSITION:1" -> { name, index } */
function parseSimvarKey(key) {
    const match = /^A:(.*?)(?::(\d+))?$/i.exec(key);
    return match === null ? undefined : { name: match[1].toUpperCase(), index: match[2] === undefined ? undefined : Number(match[2]) };
}

/** The table entry for a behavior animation entry: its code reads exactly one known sim variable. */
function driverOf(entry) {
    const reads = entry.program.references.filter((ref) => !ref.write && ref.kind !== "O" && ref.kind !== "F");
    const keys = [...new Set(reads.map((ref) => ref.key))];
    if (keys.length !== 1) {
        return undefined;
    }
    const simvar = parseSimvarKey(keys[0]);
    const driver = simvar === undefined ? undefined : DriversBySimvar.get(simvar.name);
    if (driver === undefined) {
        return undefined;
    }
    const index = driver.index?.(simvar.index);
    return { driver, key: keys[0], dataref: index === undefined ? driver.dataref : `${driver.dataref}[${index}]` };
}

/**
 * Dataref keyframes for the glTF animations the behaviors drive with a known sim variable.
 * @param {object} behaviors buildBehaviors' result
 * @param {object} gltf the shown glTF
 * @returns {Map<number, {dataref, simvar, keys: number[][]}>} by glTF animation index
 */
function xplaneAnimationDrivers(behaviors, gltf) {
    const result = new Map();
    for (const entry of behaviors?.animations ?? []) {
        const animation = gltf.animations[entry.animation];
        if (animation === undefined || result.has(entry.animation)) {
            continue;
        }
        const found = driverOf(entry);
        if (found === undefined) {
            continue;
        }
        animation.computeMinMaxTime(gltf);
        if (animation.minTime === undefined) {
            continue;
        }
        const { driver, key, dataref } = found;
        const [low, high] = driver.range;
        const length = entry.length > 0 ? entry.length : 100;
        // a copy: evaluateAnimations writes value and target, and component variables start at 0
        const probe = { ...entry, componentState: new Map() };
        const keys = [];
        for (let i = 0; i < SampleCount; i++) {
            const value = low + ((high - low) * i) / (SampleCount - 1);
            const store = new VariableStore();
            store.setKey(key, (driver.sign ?? 1) * value, driver.unit);
            evaluateAnimations(behaviors, store, [probe]);
            const time = animation.minTime + (probe.target / length) * (animation.maxTime - animation.minTime);
            keys.push([value, time]);
        }
        result.set(entry.animation, { dataref, simvar: key, keys });
    }
    return result;
}

export { xplaneAnimationDrivers };
