// MSFS RPN (reverse polish notation) as used by model behaviors: parsing and evaluation.
//
// Values are numbers or strings. Variables are read and written through an environment:
//   env.get(ref) -> number | string, env.set(ref, value)
// where ref = { kind: "L", name, index, unit, key } ("(L:NAME, unit)", "(A:NAME:2, unit)",
// "(O:NAME)", "(E:SIMULATION TIME, seconds)", ...). key identifies the variable: kind, name
// and index, upper case (MSFS variable names are not case-sensitive).

const Comparisons = new Set(["==", "!=", ">", "<", ">=", "<=", "eq", "ne", "gt", "lt", "ge", "le"]);

/** Splits code into tokens: "(X:...)" variable references, 'strings', words. */
function tokenize(code) {
    const tokens = [];
    let i = 0;
    const length = code.length;
    while (i < length) {
        const c = code[i];
        if (c <= " ") {
            i++;
            continue;
        }
        if (c === "(" && /^\(>?[A-Za-z]:/.test(code.substring(i, i + 4))) {
            // variable reference: up to the matching ')' (names may contain ' and spaces)
            let depth = 0;
            let j = i;
            for (; j < length; j++) {
                if (code[j] === "(") {
                    depth++;
                } else if (code[j] === ")" && --depth === 0) {
                    break;
                }
            }
            tokens.push({ type: "var", ref: parseReference(code.substring(i + 1, j)) });
            i = j + 1;
            continue;
        }
        if (c === "'") {
            const end = code.indexOf("'", i + 1);
            const stop = end < 0 ? length : end;
            tokens.push({ type: "string", value: code.substring(i + 1, stop) });
            i = stop + 1;
            continue;
        }
        let j = i;
        while (j < length && code[j] > " ") {
            j++;
        }
        const word = code.substring(i, j);
        i = j;
        const number = Number(word);
        if (word !== "" && Number.isFinite(number) && /^[-+]?(\d|\.\d)/.test(word)) {
            tokens.push({ type: "number", value: number });
        } else {
            tokens.push({ type: "op", value: word });
        }
    }
    return tokens;
}

/** "L:NAME, unit", ">A:NAME:2, unit", "A:CONTACT POINT IS ON GROUND:'Wheel'_n, Keyframe" */
function parseReference(text) {
    let write = false;
    if (text.startsWith(">")) {
        write = true;
        text = text.substring(1);
    }
    const kind = text[0].toUpperCase();
    let body = text.substring(2);
    let unit = "";
    const comma = body.lastIndexOf(",");
    if (comma >= 0 && !body.substring(comma).includes("'")) {
        unit = body.substring(comma + 1).trim();
        body = body.substring(0, comma);
    }
    body = body.trim();
    // "NAME:2" (simvar index); L: names may contain ':' (L:A320_Sound:ENG_1_N1), and
    // L:1:NAME (with an instance prefix) is the same variable as L:NAME here
    let index = "";
    const colon = body.lastIndexOf(":");
    if (kind === "L") {
        body = body.replace(/^\d+:/, "");
    } else if (colon > 0 && /^[\w' ]+$/.test(body.substring(colon + 1))) {
        index = body.substring(colon + 1).trim();
        body = body.substring(0, colon);
    }
    const name = body.trim();
    const key = `${kind}:${name.toUpperCase()}${index !== "" ? ":" + index.toUpperCase() : ""}`;
    return { kind, name, index, unit, write, key };
}

/**
 * Parses code once; returns a program that can be run many times.
 * Blocks (if{ ... } els{ ... }) are resolved to jump targets.
 */
function compile(code) {
    const tokens = tokenize(code ?? "");
    const stack = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type !== "op") {
            continue;
        }
        if (token.value === "if{" || token.value === "els{") {
            stack.push(i);
        } else if (token.value === "}") {
            const open = stack.pop();
            if (open !== undefined) {
                tokens[open].end = i; // index of the closing brace
                if (tokens[open].value === "if{" && tokens[i + 1]?.type === "op" && tokens[i + 1].value === "els{") {
                    tokens[open].elseAt = i + 1;
                }
            }
        }
    }
    return { code, tokens, references: tokens.filter((token) => token.type === "var").map((token) => token.ref) };
}

// (F:...) functions: "value inMin inMax outMin outMax (F:MapRange)"
const Functions = {
    MAPRANGE: (value, inMin, inMax, outMin, outMax) => {
        const t = inMax === inMin ? 0 : Math.min(1, Math.max(0, (value - inMin) / (inMax - inMin)));
        return outMin + t * (outMax - outMin);
    }
};

const truthy = (value) => (typeof value === "string" ? value !== "" : value !== 0 && !Number.isNaN(value));
const toNumber = (value) => (typeof value === "string" ? Number(value) || 0 : value);

/**
 * Runs a compiled program. Returns { value, error } where value is the top of the stack
 * (0 when empty). Unknown operators set error (the first one) but don't stop the evaluation.
 */
function run(program, env, maxSteps = 100000) {
    const stack = [];
    const registers = [];
    let error = undefined;
    const pop = () => (stack.length > 0 ? stack.pop() : 0);
    const popNumber = () => toNumber(pop());
    const tokens = program.tokens;
    let steps = 0;
    for (let i = 0; i < tokens.length; i++) {
        if (++steps > maxSteps) {
            error ??= "too many steps";
            break;
        }
        const token = tokens[i];
        if (token.type === "number" || token.type === "string") {
            stack.push(token.value);
            continue;
        }
        if (token.type === "var") {
            if (token.ref.kind === "F" && !token.ref.write) {
                // (F:Name) functions take their arguments from the stack
                const fn = Functions[token.ref.name.toUpperCase()];
                if (fn === undefined) {
                    error ??= `unsupported function F:${token.ref.name}`;
                } else {
                    const args = [];
                    for (let k = 0; k < fn.length; k++) args.unshift(popNumber());
                    stack.push(fn(...args));
                }
                continue;
            }
            if (token.ref.write) {
                env.set(token.ref, pop());
            } else {
                stack.push(env.get(token.ref));
            }
            continue;
        }
        const op = token.value;
        switch (op) {
            case "if{":
                if (!truthy(pop())) {
                    i = token.elseAt ?? token.end;
                }
                break;
            case "els{":
                // reached after a taken if{ ... }: skip the else block
                i = token.end;
                break;
            case "}":
                break;
            case "quit":
                i = tokens.length;
                break;
            case "+": { const b = pop(); const a = pop(); stack.push(typeof a === "string" || typeof b === "string" ? `${a}${b}` : a + b); break; }
            case "-": { const b = popNumber(); stack.push(popNumber() - b); break; }
            case "*": stack.push(popNumber() * popNumber()); break;
            case "/": { const b = popNumber(); const a = popNumber(); stack.push(b === 0 ? 0 : a / b); break; }
            case "%": { const b = popNumber(); const a = popNumber(); stack.push(b === 0 ? 0 : a % b); break; }
            case "neg": stack.push(-popNumber()); break;
            case "++": stack.push(popNumber() + 1); break;
            case "--": stack.push(popNumber() - 1); break;
            case "==": case "eq": { const b = pop(); const a = pop(); stack.push(a == b ? 1 : 0); break; }
            case "!=": case "ne": { const b = pop(); const a = pop(); stack.push(a != b ? 1 : 0); break; }
            case ">": case "gt": { const b = popNumber(); stack.push(popNumber() > b ? 1 : 0); break; }
            case "<": case "lt": { const b = popNumber(); stack.push(popNumber() < b ? 1 : 0); break; }
            case ">=": case "ge": { const b = popNumber(); stack.push(popNumber() >= b ? 1 : 0); break; }
            case "<=": case "le": { const b = popNumber(); stack.push(popNumber() <= b ? 1 : 0); break; }
            case "and": case "&&": { const b = pop(); const a = pop(); stack.push(truthy(a) && truthy(b) ? 1 : 0); break; }
            case "or": case "||": { const b = pop(); const a = pop(); stack.push(truthy(a) || truthy(b) ? 1 : 0); break; }
            case "!": case "not": stack.push(truthy(pop()) ? 0 : 1); break;
            case "&": stack.push(popNumber() & popNumber()); break;
            case "|": stack.push(popNumber() | popNumber()); break;
            case "^": stack.push(popNumber() ^ popNumber()); break;
            case "~": stack.push(~popNumber()); break;
            case ">>": { const b = popNumber(); stack.push(popNumber() >> b); break; }
            case "<<": { const b = popNumber(); stack.push(popNumber() << b); break; }
            case "?": { const c = pop(); const b = pop(); const a = pop(); stack.push(truthy(c) ? a : b); break; }
            case "min": stack.push(Math.min(popNumber(), popNumber())); break;
            case "max": stack.push(Math.max(popNumber(), popNumber())); break;
            case "abs": stack.push(Math.abs(popNumber())); break;
            case "sign": stack.push(Math.sign(popNumber())); break;
            case "flr": stack.push(Math.floor(popNumber())); break;
            case "ceil": stack.push(Math.ceil(popNumber())); break;
            case "near": stack.push(Math.round(popNumber())); break;
            case "int": stack.push(Math.trunc(popNumber())); break;
            case "sqr": { const a = popNumber(); stack.push(a * a); break; }
            case "sqrt": stack.push(Math.sqrt(popNumber())); break;
            case "pow": { const b = popNumber(); stack.push(Math.pow(popNumber(), b)); break; }
            case "exp": stack.push(Math.exp(popNumber())); break;
            case "log": { const b = popNumber(); stack.push(Math.log(popNumber()) / Math.log(b)); break; }
            case "ln": stack.push(Math.log(popNumber())); break;
            case "sin": stack.push(Math.sin(popNumber())); break;
            case "cos": stack.push(Math.cos(popNumber())); break;
            case "tg": stack.push(Math.tan(popNumber())); break;
            case "asin": stack.push(Math.asin(popNumber())); break;
            case "acos": stack.push(Math.acos(popNumber())); break;
            case "atg": stack.push(Math.atan(popNumber())); break;
            case "atg2": { const b = popNumber(); stack.push(Math.atan2(popNumber(), b)); break; }
            case "pi": stack.push(Math.PI); break;
            case "dnor": { let a = popNumber() % 360; if (a < 0) a += 360; stack.push(a); break; }
            case "rnor": { let a = popNumber() % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; stack.push(a); break; }
            case "rng": { const hi = popNumber(); const lo = popNumber(); const a = popNumber(); stack.push(a >= lo && a <= hi ? 1 : 0); break; }
            case "d": { const a = pop(); stack.push(a, a); break; }
            case "r": { const b = pop(); const a = pop(); stack.push(b, a); break; }
            case "p": pop(); break;
            case "c": stack.length = 0; break;
            case "scmp": { const b = String(pop()); const a = String(pop()); stack.push(a < b ? -1 : a > b ? 1 : 0); break; }
            case "scmi": { const b = String(pop()).toLowerCase(); const a = String(pop()).toLowerCase(); stack.push(a < b ? -1 : a > b ? 1 : 0); break; }
            case "sstr": { const b = String(pop()); stack.push(String(pop()).indexOf(b)); break; }
            case "slen": stack.push(String(pop()).length); break;
            case "case": {
                // "v(n-1) ... v1 v0 n selector case": picks v[selector], v0 pushed last
                const selector = Math.trunc(popNumber());
                const count = popNumber();
                const values = [];
                for (let k = 0; k < count; k++) values.unshift(pop());
                stack.push(values[values.length - 1 - selector] ?? 0);
                break;
            }
            default: {
                let match;
                if ((match = /^s(\d+)$/.exec(op))) {
                    registers[match[1]] = stack.length > 0 ? stack[stack.length - 1] : 0;
                } else if ((match = /^sp(\d+)$/.exec(op))) {
                    registers[match[1]] = pop();
                } else if ((match = /^l(\d+)$/.exec(op))) {
                    stack.push(registers[match[1]] ?? 0);
                } else {
                    // labels (gN / :N) and functions are not emulated yet
                    error ??= `unsupported "${op}"`;
                }
            }
        }
    }
    return { value: stack.length > 0 ? stack[stack.length - 1] : 0, error };
}

/**
 * The constants each variable is compared against in the code ("(L:X) 2 ==", "(L:X) 1 >"),
 * keyed by variable key: Map<key, Set<number>>. Used to offer values in the UI.
 */
function comparedValues(program, into = new Map()) {
    const tokens = program.tokens;
    for (let i = 0; i + 2 < tokens.length; i++) {
        const [a, b, c] = [tokens[i], tokens[i + 1], tokens[i + 2]];
        if (a.type === "var" && !a.ref.write && b.type === "number" && c.type === "op" && Comparisons.has(c.value)) {
            if (!into.has(a.ref.key)) {
                into.set(a.ref.key, new Set());
            }
            into.get(a.ref.key).add(b.value);
        }
    }
    return into;
}

export { comparedValues, compile, parseReference, run, tokenize, truthy };
