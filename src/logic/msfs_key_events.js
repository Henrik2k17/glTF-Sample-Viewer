// MSFS key events (K:) the behavior codes send, simulated as the simvars (A:) they change, so
// that switches driven through key events move and light up. Only the common events are
// known; the others are only logged. A write goes to every index of the simvar the codes
// read, or to one index when the event has one.

// argument roles in stack push order ("50 1 (>K:2:PANEL_LIGHTS_POWER_SETTING_SET)": value, index)
const ValueIndex = ["value", "index"];
const IndexValue = ["index", "value"];

const toggle = (simvar) => ({ args: ["index"], apply: (write, { index }) => write(simvar, index, (current) => (current ? 0 : 1)) });
const set = (simvar, args = ["value"]) => ({ args, apply: (write, { value, index }) => write(simvar, index, () => (value ? 1 : 0)) });
const constant = (simvar, value) => ({ args: ["index"], apply: (write, { index }) => write(simvar, index, () => value) });
const percent = (simvar, args = ValueIndex) => ({
    args,
    apply: (write, { value, index }) => write(simvar, index, () => Math.min(100, Math.max(0, value)) / 100)
});
// axis events: -16383 .. 16383 (or 0 .. 16383) to a fraction
const axis = (simvar) => ({ args: ["value"], apply: (write, { value }) => write(simvar, undefined, () => Math.max(-1, Math.min(1, value / 16383))) });
const throttle = (index) => ({ args: ["value"], apply: (write, { value }) => write("GENERAL ENG THROTTLE LEVER POSITION", index, () => Math.max(0, Math.min(1, value / 16383))) });
const lights = (name) => ({
    [`TOGGLE_${name}_LIGHTS`]: toggle(`LIGHT ${name}`),
    [`${name}_LIGHTS_TOGGLE`]: toggle(`LIGHT ${name}`),
    [`${name}_LIGHTS_SET`]: set(`LIGHT ${name}`, ["value", "index"]),
    [`${name}_LIGHTS_ON`]: constant(`LIGHT ${name}`, 1),
    [`${name}_LIGHTS_OFF`]: constant(`LIGHT ${name}`, 0),
    [`${name}_LIGHTS_POWER_SETTING_SET`]: percent(`LIGHT ${name} POWER SETTING`)
});

/** Event name -> { args: roles in push order, apply(write, { value, index }) } */
const KeyEvents = {
    ...lights("NAV"),
    ...lights("BEACON"),
    ...lights("LANDING"),
    ...lights("TAXI"),
    ...lights("STROBE"),
    ...lights("PANEL"),
    ...lights("CABIN"),
    ...lights("GLARESHIELD"),
    ...lights("LOGO"),
    ...lights("WING"),
    ...lights("RECOGNITION"),
    ...lights("PEDESTRAL"),
    STROBES_TOGGLE: toggle("LIGHT STROBE"),
    STROBES_SET: set("LIGHT STROBE"),
    STROBES_ON: constant("LIGHT STROBE", 1),
    STROBES_OFF: constant("LIGHT STROBE", 0),
    LANDING_LIGHTS_TOGGLE: toggle("LIGHT LANDING"),
    LIGHT_POTENTIOMETER_SET: { args: ValueIndex, apply: (write, { value, index }) => write("LIGHT POTENTIOMETER", index, () => Math.min(100, Math.max(0, value)) / 100) },
    TOGGLE_MASTER_BATTERY: toggle("ELECTRICAL MASTER BATTERY"),
    MASTER_BATTERY_SET: set("ELECTRICAL MASTER BATTERY"),
    MASTER_BATTERY_ON: constant("ELECTRICAL MASTER BATTERY", 1),
    MASTER_BATTERY_OFF: constant("ELECTRICAL MASTER BATTERY", 0),
    TOGGLE_MASTER_ALTERNATOR: {
        args: ["index"],
        apply: (write, { index }) => {
            write("GENERAL ENG MASTER ALTERNATOR", index, (current) => (current ? 0 : 1));
            write("ELECTRICAL GENERATOR SWITCH", index, (current) => (current ? 0 : 1));
        }
    },
    TOGGLE_ALTERNATOR1: toggle("GENERAL ENG MASTER ALTERNATOR:1"),
    TOGGLE_ALTERNATOR2: toggle("GENERAL ENG MASTER ALTERNATOR:2"),
    TOGGLE_AVIONICS_MASTER: toggle("AVIONICS MASTER SWITCH"),
    AVIONICS_MASTER_SET: set("AVIONICS MASTER SWITCH"),
    PARKING_BRAKE_SET: set("BRAKE PARKING POSITION"),
    PARKING_BRAKES: toggle("BRAKE PARKING POSITION"),
    GEAR_SET: set("GEAR HANDLE POSITION"),
    GEAR_TOGGLE: toggle("GEAR HANDLE POSITION"),
    GEAR_UP: constant("GEAR HANDLE POSITION", 0),
    GEAR_DOWN: constant("GEAR HANDLE POSITION", 1),
    PITOT_HEAT_TOGGLE: toggle("PITOT HEAT SWITCH"),
    PITOT_HEAT_SET: set("PITOT HEAT SWITCH", ["value", "index"]),
    PITOT_HEAT_ON: constant("PITOT HEAT SWITCH", 1),
    PITOT_HEAT_OFF: constant("PITOT HEAT SWITCH", 0),
    TOGGLE_STRUCTURAL_DEICE: toggle("STRUCTURAL DEICE SWITCH"),
    WINDSHIELD_DEICE_SET: set("WINDSHIELD DEICE SWITCH"),
    WINDSHIELD_DEICE_TOGGLE: toggle("WINDSHIELD DEICE SWITCH"),
    STARTER1_SET: set("GENERAL ENG STARTER:1"),
    STARTER2_SET: set("GENERAL ENG STARTER:2"),
    FUELSYSTEM_PUMP_SET: { args: ValueIndex, apply: (write, { value, index }) => write("FUELSYSTEM PUMP SWITCH", index, () => value) },
    FUELSYSTEM_PUMP_TOGGLE: toggle("FUELSYSTEM PUMP SWITCH"),
    FUELSYSTEM_VALVE_SET: { args: ValueIndex, apply: (write, { value, index }) => write("FUELSYSTEM VALVE SWITCH", index, () => (value ? 1 : 0)) },
    FUELSYSTEM_VALVE_TOGGLE: toggle("FUELSYSTEM VALVE SWITCH"),
    FUELSYSTEM_TRIGGER_SET: { args: ValueIndex, apply: (write, { value, index }) => write("FUELSYSTEM TRIGGER STATUS", index, () => (value ? 1 : 0)) },
    COVER_SET: { args: ValueIndex, apply: (write, { value, index }) => write("COVER ON", index, () => (value ? 1 : 0)) },
    AUTOPILOT_ON: constant("AUTOPILOT MASTER", 1),
    AUTOPILOT_OFF: constant("AUTOPILOT MASTER", 0),
    AP_MASTER: toggle("AUTOPILOT MASTER"),
    ELEVATOR_TRIM_SET: axis("ELEVATOR TRIM PCT"),
    AILERON_TRIM_SET_EX1: axis("AILERON TRIM PCT"),
    RUDDER_TRIM_SET_EX1: axis("RUDDER TRIM PCT"),
    THROTTLE1_SET: throttle(1),
    THROTTLE2_SET: throttle(2),
    THROTTLE3_SET: throttle(3),
    THROTTLE4_SET: throttle(4),
    // value: millibars x 16
    KOHLSMAN_SET: {
        args: IndexValue,
        apply: (write, { value, index }) => {
            write("KOHLSMAN SETTING MB", index, () => value / 16);
            write("KOHLSMAN SETTING HG", index, () => (value / 16) * 0.0295299830714);
        }
    },
    FLAPS_SET: { args: ["value"], apply: (write, { value }) => write("FLAPS HANDLE PERCENT", undefined, () => Math.max(0, Math.min(1, value / 16383))) },
    FLAPS_UP: constant("FLAPS HANDLE PERCENT", 0),
    FLAPS_DOWN: constant("FLAPS HANDLE PERCENT", 1),
    SPOILERS_ARM_SET: set("SPOILERS ARMED"),
    SPOILERS_ARM_TOGGLE: toggle("SPOILERS ARMED")
};

// Units the simvars are kept in: percent ones as fractions, the others as given
const SimvarUnits = new Map([
    ["FLAPS HANDLE PERCENT", "percent over 100"],
    ["ELEVATOR TRIM PCT", "percent over 100"],
    ["AILERON TRIM PCT", "percent over 100"],
    ["RUDDER TRIM PCT", "percent over 100"],
    ["GENERAL ENG THROTTLE LEVER POSITION", "percent over 100"],
    ["LIGHT POTENTIOMETER", "percent over 100"]
]);
const unitOf = (simvar) => (/ POWER SETTING$/.test(simvar) ? "percent over 100" : SimvarUnits.get(simvar) ?? "");

/**
 * Runs a key event. args: the values it took from the stack (push order). simvarKeys: Map
 * <upper-case simvar name, Set<variable key>> of the A: variables the codes read.
 * Returns undefined when the event is not simulated, else [{ key, before, after }].
 */
function runKeyEvent(name, args, store, simvarKeys) {
    const event = KeyEvents[name.toUpperCase()];
    if (event === undefined) {
        return undefined;
    }
    const roles = {};
    event.args.forEach((role, i) => {
        if (i < args.length) {
            roles[role] = Number(args[i]) || 0;
        }
    });
    if (event.args.length === 1 && event.args[0] === "index" && args.length > 0) {
        // toggles: their one value is the index (0 = all)
        roles.index = Number(args[0]) || 0;
    }
    const changes = [];
    const write = (simvar, index, compute) => {
        // "NAME:N" in the table fixes the index
        const fixed = /^(.*):(\d+)$/.exec(simvar);
        if (fixed !== null) {
            simvar = fixed[1];
            index = Number(fixed[2]);
        }
        const unit = unitOf(simvar);
        for (const key of targetKeys(simvar, index, simvarKeys)) {
            const before = store.valueOf(key, unit);
            const after = compute(Number(before) || 0);
            store.setKey(key, after, unit);
            changes.push({ key, before, after });
        }
    };
    event.apply(write, { value: roles.value ?? 0, index: roles.index });
    // A light's power setting above 0 also switches it on, at 0 off (the DA62's update codes
    // keep "power = switch x 50" when the two disagree, so the sim must do this). A light
    // switch also sets LIGHT <NAME> ON (switched on and powered; there is no electrical system
    // here, so everything counts as powered).
    for (const change of [...changes]) {
        const power = /^A:(LIGHT [A-Z]+) POWER SETTING(?::(\d+))?$/.exec(change.key);
        if (power !== null) {
            const index = power[2] === undefined ? undefined : Number(power[2]);
            write(power[1], index, () => (change.after > 0 ? 1 : 0));
            write(`${power[1]} ON`, index, () => (change.after > 0 ? 1 : 0));
            continue;
        }
        const light = /^A:(LIGHT [A-Z]+)(?::(\d+))?$/.exec(change.key);
        if (light !== null && light[1] !== "LIGHT POTENTIOMETER") {
            write(`${light[1]} ON`, light[2] === undefined ? undefined : Number(light[2]), () => change.after);
        }
    }
    return changes;
}

/**
 * The variable keys a write to simvar (index) goes to: the read keys of that simvar with the
 * index (every index when there is none or it is 0), else the plain key.
 */
function targetKeys(simvar, index, simvarKeys) {
    const name = simvar.toUpperCase();
    const read = [...(simvarKeys.get(name) ?? [])];
    if (index === undefined || index === 0) {
        if (read.length > 0) {
            return read;
        }
        return [`A:${name}`];
    }
    const indexed = `A:${name}:${index}`;
    const matching = read.filter((key) => key === indexed);
    return matching.length > 0 ? matching : [indexed];
}

export { KeyEvents, runKeyEvent };
