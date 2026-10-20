// MSFS model behavior templates: loads a model's behavior XML (with its includes from the
// ModelBehaviorDefs folders) and expands the templates into components, like the package
// builder does. Only what the viewer emulates is kept: components (ID, Node) with their
// visibility codes, animations, mouse rects and input events; other outputs are counted.
//
// Template language (as used by the SDK and Fenix templates):
//   <Template Name> / <TemplateAlias>, <UseTemplate Name> with parameters as child elements,
//   <Parameters Type="Default|Override"> (Default: only when not set yet), #NAME# substitution,
//   <DefaultTemplateParameters>, <ParametersFn>/<UseParametersFn>/<ReturnParameters>,
//   <Condition Check|Valid|NotEmpty [Match]> or <Condition><Test>...</Test>, <True>/<False>,
//   <Switch Param> <Case Value> <Default>, <Loop><Setup>...</Setup><Do>, parameter
//   Process="Int|Float|String|Param" and Lifetime="Loop|Iteration".
// Parameters are dynamically scoped: a template sees the parameters of its callers.

import { compile, run, truthy } from "./msfs_rpn.js";

const MaxDepth = 64;

// attribute lookup ignoring case (the SDK writes "Check" and "check")
function attr(element, name) {
    const direct = element.getAttribute(name);
    if (direct !== null) {
        return direct;
    }
    const lower = name.toLowerCase();
    for (const attribute of element.attributes) {
        if (attribute.name.toLowerCase() === lower) {
            return attribute.value;
        }
    }
    return null;
}

const childElements = (element) => [...element.children];
const lower = (element) => element.localName.toLowerCase();

class Scope {
    constructor(parent = undefined) {
        this.parent = parent;
        this.values = new Map();
    }
    has(name) {
        for (let scope = this; scope !== undefined; scope = scope.parent) {
            if (scope.values.has(name)) {
                return true;
            }
        }
        return false;
    }
    get(name) {
        for (let scope = this; scope !== undefined; scope = scope.parent) {
            if (scope.values.has(name)) {
                return scope.values.get(name);
            }
        }
        return undefined;
    }
    set(name, value) {
        this.values.set(name, value);
    }
}

/**
 * Template library and expander for one package.
 * @param {object} options
 *   readFile(path) -> Promise<string|undefined>: a file of the package (path relative to its root)
 *   defsRoots: folders searched for <Include Path|ModelBehaviorFile> (e.g. ["ModelBehaviorDefs"])
 */
class BehaviorExpander {
    constructor({ readFile, defsRoots = ["ModelBehaviorDefs"] }) {
        this.readFile = readFile;
        this.defsRoots = defsRoots;
        this.templates = new Map();
        this.parameterFns = new Map();
        this.inputEvents = new Map(); // <InputEvent ID> definitions, for <UseInputEvent ID>
        this.loadedFiles = new Map(); // path -> Promise<Document|undefined>
        this.problems = [];
    }

    problem(message) {
        if (this.problems.length < 200 && !this.problems.includes(message)) {
            this.problems.push(message);
        }
    }

    async loadDocument(path) {
        const key = path.toLowerCase();
        if (!this.loadedFiles.has(key)) {
            this.loadedFiles.set(
                key,
                this.readFile(path).then((text) => {
                    if (text === undefined) {
                        return undefined;
                    }
                    // compiled behaviors name the code strings by number (<1820648769115568245>),
                    // which XML parsers reject: prefix them (StringID "N" -> element "S_N")
                    text = text.replace(/<(\/?)(\d+)(\s*\/?)>/g, "<$1S_$2$3>");
                    const doc = new DOMParser().parseFromString(text, "text/xml");
                    if (doc.querySelector("parsererror") !== null) {
                        this.problem(`${path}: not valid XML`);
                        return undefined;
                    }
                    return doc;
                })
            );
        }
        return this.loadedFiles.get(key);
    }

    /** Resolves an include to a package path (undefined when not found). */
    async resolveInclude(element, folder) {
        const relative = attr(element, "RelativeFile");
        if (relative) {
            return joinPath(folder, relative);
        }
        const path = attr(element, "Path") ?? attr(element, "ModelBehaviorFile");
        if (!path) {
            return undefined;
        }
        for (const root of this.defsRoots) {
            const candidate = joinPath(root, path);
            if ((await this.loadDocument(candidate)) !== undefined) {
                return candidate;
            }
        }
        this.problem(`include ${path} not found (ModelBehaviorDefs)`);
        return undefined;
    }

    /**
     * Loads the definitions (templates, ParametersFn) of a file and its includes, and returns
     * the file's document. Includes are loaded once.
     */
    async loadDefinitions(path, loading = new Set()) {
        const doc = await this.loadDocument(path);
        if (doc === undefined || loading.has(path.toLowerCase())) {
            return doc;
        }
        loading.add(path.toLowerCase());
        await this.collectDefinitions(doc.documentElement, folderOf(path), loading);
        return doc;
    }

    async collectDefinitions(element, folder, loading) {
        for (const child of childElements(element)) {
            const name = lower(child);
            if (name === "include") {
                const path = await this.resolveInclude(child, folder);
                if (path !== undefined) {
                    await this.loadDefinitions(path, loading);
                }
            } else if (name === "template") {
                const templateName = attr(child, "Name");
                if (templateName) {
                    this.templates.set(templateName, child);
                    for (const alias of childElements(child).filter((e) => lower(e) === "templatealias")) {
                        this.templates.set(alias.textContent.trim(), child);
                    }
                }
            } else if (name === "parametersfn") {
                const fnName = attr(child, "Name");
                if (fnName) {
                    this.parameterFns.set(fnName, child);
                }
            } else if (name === "inputevent") {
                const id = attr(child, "ID");
                if (id) {
                    this.inputEvents.set(id, child);
                }
            }
        }
    }

    /**
     * Expands the behaviors of a model XML (<Behaviors> with <IncludeBase>/<Include>, or a
     * ModelBehaviors file). Returns { components, outputs } where components are
     * { id, node, parent, visibility: [code], animations, mouseRects, inputEvents }
     * (parent: index or -1).
     */
    async expandModel(modelXmlPath) {
        const doc = await this.loadDocument(modelXmlPath);
        const result = { components: [], outputs: {}, compiled: false };
        if (doc === undefined) {
            return result;
        }
        const behaviors = childElements(doc.documentElement).find((e) => lower(e) === "behaviors");
        if (behaviors === undefined) {
            return result;
        }
        if ((attr(behaviors, "Compiled") ?? "").toLowerCase() === "true") {
            result.compiled = true;
            for (const include of childElements(behaviors).filter((e) => lower(e) === "includebase")) {
                const path = joinPath(folderOf(modelXmlPath), attr(include, "RelativeFile") ?? "");
                await this.readCompiled(path, result);
            }
            return result;
        }
        await this.expandRoot(behaviors, folderOf(modelXmlPath), result);
        return result;
    }

    /** A <Behaviors> or <ModelBehaviors> element: includes first (definitions), then the rest. */
    async expandRoot(root, folder, result, depth = 0) {
        await this.collectDefinitions(root, folder, new Set());
        const scope = new Scope();
        const context = { result, component: -1, folder, depth: 0 };
        for (const child of childElements(root)) {
            const name = lower(child);
            if (name === "includebase") {
                const path = joinPath(folder, attr(child, "RelativeFile") ?? "");
                const doc = await this.loadDocument(path);
                if (doc === undefined) {
                    this.problem(`behavior file ${path} not found`);
                } else if (depth < 8) {
                    await this.expandRoot(doc.documentElement, folderOf(path), result, depth + 1);
                }
            } else {
                this.expandElement(child, scope, context);
            }
        }
    }

    // ------------------------------------------------------------------ expansion

    expandChildren(element, scope, context) {
        for (const child of childElements(element)) {
            this.expandElement(child, scope, context);
        }
    }

    expandElement(element, scope, context) {
        if (context.depth > MaxDepth) {
            this.problem("template nesting too deep (recursion?)");
            return;
        }
        const name = lower(element);
        switch (name) {
            case "include":
            case "template":
            case "parametersfn":
            case "templatealias":
            case "defaulttemplateparameters":
                return; // definitions (collected before) or handled by UseTemplate
            case "parameters":
                this.applyParameters(element, scope, parametersMode(element));
                return;
            case "condition":
                this.expandBranch(this.conditionBranch(element, scope), scope, context);
                return;
            case "switch":
                this.expandBranch(this.switchBranch(element, scope), scope, context);
                return;
            case "loop":
                this.runLoop(element, scope, (iteration) => {
                    const body = childElements(element).find((e) => lower(e) === "do");
                    if (body !== undefined) {
                        this.expandChildren(body, iteration, context);
                    }
                });
                return;
            case "usetemplate":
                this.useTemplate(element, scope, context);
                return;
            case "component":
                this.expandComponent(element, scope, context);
                return;
            case "visibility": {
                const code = codeOf(element, scope, this);
                if (code !== undefined) {
                    this.componentOf(context, element).visibility.push(code);
                }
                this.count(context, name);
                return;
            }
            case "animation": {
                const animation = animationOf(element, scope);
                if (animation !== undefined) {
                    this.componentOf(context, element).animations.push(animation);
                }
                this.count(context, "Animation");
                return;
            }
            case "material": {
                const emissive = emissiveOf(element, scope);
                if (emissive !== undefined) {
                    this.componentOf(context).emissive.push(emissive);
                }
                this.count(context, "Material");
                return;
            }
            case "update": {
                const code = substitute(element.textContent, scope).replace(/\s+/g, " ").trim();
                if (code !== "") {
                    this.componentOf(context).updates.push(updateOf(code, (name) => substitute(attr(element, name) ?? attr(element, name.toLowerCase()) ?? "", scope)));
                }
                this.count(context, "Update");
                return;
            }
            case "mouserect": {
                const mouseRect = mouseRectOf(element, scope);
                if (mouseRect !== undefined) {
                    this.componentOf(context).mouseRects.push(mouseRect);
                }
                this.count(context, "MouseRect");
                return;
            }
            case "inputevent":
                // an input event defined in place (definitions at the top of a file are collected before)
                if (element.parentElement !== null && !["behaviors", "modelbehaviors"].includes(lower(element.parentElement))) {
                    this.componentOf(context).inputEvents.push(...inputEventsOf(element, scope));
                    this.count(context, "InputEvent");
                }
                return;
            case "useinputevent": {
                const id = substitute(attr(element, "ID") ?? "", scope);
                const definition = this.inputEvents.get(id);
                if (definition === undefined) {
                    this.problem(`input event ${id} not found`);
                } else {
                    // the definition sees the parameters where it is used
                    const inner = new Scope(scope);
                    this.applyParameters(element, inner, "override", inner);
                    this.componentOf(context).inputEvents.push(...inputEventsOf(definition, inner));
                }
                this.count(context, "InputEvent");
                return;
            }
            default:
                // AnimationTriggers, FX, ...: not emulated
                this.count(context, element.localName);
        }
    }

    count(context, name) {
        context.result.outputs[name] = (context.result.outputs[name] ?? 0) + 1;
    }

    /** The current component (a visibility outside of components gets an unnamed one). */
    componentOf(context) {
        if (context.component < 0) {
            context.result.components.push(newComponent("", "", -1));
            context.component = context.result.components.length - 1;
        }
        return context.result.components[context.component];
    }

    expandBranch(branch, scope, context) {
        if (branch !== undefined) {
            this.expandChildren(branch, scope, context);
        }
    }

    expandComponent(element, scope, context) {
        const components = context.result.components;
        components.push(
            newComponent(substitute(attr(element, "ID") ?? "", scope), substitute(attr(element, "Node") ?? "", scope), context.component)
        );
        const inner = { ...context, component: components.length - 1, depth: context.depth + 1 };
        this.expandChildren(element, new Scope(scope), inner);
    }

    useTemplate(element, scope, context) {
        const name = substitute(attr(element, "Name") ?? "", scope);
        const template = this.templates.get(name);
        if (template === undefined) {
            this.problem(`template ${name} not found`);
            return;
        }
        const inner = new Scope(scope);
        // the call's parameters (child elements; Condition/Switch may choose them). Values see
        // the earlier arguments of the call and the caller's parameters.
        this.applyParameters(element, inner, "override", inner);
        for (const defaults of childElements(template).filter((e) => lower(e) === "defaulttemplateparameters")) {
            this.applyParameters(defaults, inner, "default");
        }
        this.expandChildren(template, inner, { ...context, depth: context.depth + 1 });
    }

    // ------------------------------------------------------------------ parameters

    /**
     * Sets the parameters defined by the child elements of element. mode "default" only sets
     * parameters that are not set yet (in any calling scope). valueScope: scope the values
     * are substituted in (the caller's, for UseTemplate arguments).
     */
    applyParameters(element, scope, mode, valueScope = scope, loopScope = undefined) {
        for (const child of childElements(element)) {
            const name = lower(child);
            if (name === "condition") {
                const branch = this.conditionBranch(child, valueScope);
                if (branch !== undefined) {
                    this.applyParameters(branch, scope, mode, valueScope, loopScope);
                }
            } else if (name === "switch") {
                const branch = this.switchBranch(child, valueScope);
                if (branch !== undefined) {
                    this.applyParameters(branch, scope, mode, valueScope, loopScope);
                }
            } else if (name === "parameters") {
                this.applyParameters(child, scope, parametersMode(child), valueScope, loopScope);
            } else if (name === "useparametersfn") {
                this.useParametersFn(child, scope, mode, valueScope);
            } else if (name === "templatealias" || name === "loop" || name === "test") {
                // not parameters
            } else {
                const parameter = child.localName;
                if (mode === "default" && scope.has(parameter)) {
                    continue;
                }
                const value = this.parameterValue(child, valueScope);
                const lifetime = (attr(child, "Lifetime") ?? attr(element, "Lifetime") ?? "").toLowerCase();
                (lifetime === "loop" && loopScope !== undefined ? loopScope : scope).set(parameter, value);
            }
        }
    }

    parameterValue(element, scope) {
        const process = (attr(element, "Process") ?? "").toLowerCase();
        const text = substitute(element.textContent.trim(), scope);
        switch (process) {
            case "int":
            case "float": {
                const { value } = run(compile(text), { get: () => 0, set: () => {} });
                const number = typeof value === "number" ? value : Number(value) || 0;
                return String(process === "int" ? Math.trunc(number) : number);
            }
            case "param":
                return scope.get(text) ?? "";
            default:
                return text;
        }
    }

    useParametersFn(element, scope, mode, valueScope) {
        const name = substitute(attr(element, "Name") ?? "", valueScope);
        const fn = this.parameterFns.get(name);
        if (fn === undefined) {
            this.problem(`ParametersFn ${name} not found`);
            return;
        }
        const inner = new Scope(valueScope);
        this.applyParameters(element, inner, "override", inner);
        for (const block of childElements(fn).filter((e) => lower(e) === "parameters")) {
            this.applyParameters(block, inner, parametersMode(block));
        }
        const returned = new Scope(inner);
        for (const block of childElements(fn).filter((e) => lower(e) === "returnparameters")) {
            this.applyParameters(block, returned, "override", returned);
        }
        for (const [key, value] of returned.values) {
            if (mode !== "default" || !scope.has(key)) {
                scope.set(key, value);
            }
        }
    }

    // ------------------------------------------------------------------ conditions

    /** The branch element to expand (True/False child, or the condition itself), or undefined. */
    conditionBranch(element, scope) {
        const children = childElements(element);
        const test = children.find((e) => lower(e) === "test");
        const result = test !== undefined ? this.evaluateTest(test, scope) : this.evaluateArg(element, scope);
        const trueBranch = children.find((e) => lower(e) === "true");
        const falseBranch = children.find((e) => lower(e) === "false");
        if (trueBranch === undefined && falseBranch === undefined) {
            return result ? withoutTest(element) : undefined;
        }
        return result ? trueBranch : falseBranch;
    }

    /** Check / Valid / NotEmpty (+ Match) attributes of a Condition, Arg or Case. */
    evaluateArg(element, scope) {
        const check = attr(element, "Check");
        if (check !== null) {
            const name = substitute(check, scope);
            const match = attr(element, "Match");
            if (match !== null) {
                return scope.has(name) && String(scope.get(name)) === substitute(match, scope);
            }
            return scope.has(name);
        }
        const valid = attr(element, "Valid");
        if (valid !== null) {
            const value = scope.get(substitute(valid, scope));
            return value !== undefined && value !== "" && value.toLowerCase() !== "false" && value !== "0";
        }
        const notEmpty = attr(element, "NotEmpty");
        if (notEmpty !== null) {
            const value = scope.get(substitute(notEmpty, scope));
            return value !== undefined && value !== "";
        }
        if (attr(element, "CheckSavedParameters") !== null || attr(element, "IsVersion") !== null) {
            return false; // saved parameter stacks and versions are not emulated
        }
        return false;
    }

    evaluateTest(element, scope) {
        const children = childElements(element);
        return children.length > 0 && children.every((child) => this.evaluateNode(child, scope));
    }

    evaluateNode(element, scope) {
        const name = lower(element);
        const children = childElements(element);
        const numbers = () => children.map((child) => Number(substitute(child.textContent.trim(), scope)));
        switch (name) {
            case "and":
                return children.every((child) => this.evaluateNode(child, scope));
            case "or":
                return children.some((child) => this.evaluateNode(child, scope));
            case "not":
                return !children.every((child) => this.evaluateNode(child, scope));
            case "arg":
                return this.evaluateArg(element, scope);
            case "greater": { const [a, b] = numbers(); return a > b; }
            case "greaterorequal": { const [a, b] = numbers(); return a >= b; }
            case "lower": { const [a, b] = numbers(); return a < b; }
            case "lowerorequal": { const [a, b] = numbers(); return a <= b; }
            case "equal": {
                const values = children.map((child) => substitute(child.textContent.trim(), scope));
                return values.every((value) => value === values[0]);
            }
            default:
                return this.evaluateArg(element, scope);
        }
    }

    switchBranch(element, scope) {
        const param = attr(element, "Param");
        const cases = childElements(element).filter((e) => lower(e) === "case");
        if (param !== null) {
            const value = scope.get(substitute(param, scope));
            const match = cases.find((c) => attr(c, "Value") !== null && substitute(attr(c, "Value"), scope) === value);
            if (match !== undefined) {
                return match;
            }
        } else {
            const match = cases.find((c) => this.evaluateArg(c, scope));
            if (match !== undefined) {
                return match;
            }
        }
        return childElements(element).find((e) => lower(e) === "default");
    }

    // ------------------------------------------------------------------ loops

    runLoop(element, scope, body) {
        const setup = childElements(element).find((e) => lower(e) === "setup");
        if (setup === undefined) {
            return;
        }
        const part = (name) => childElements(setup).find((e) => lower(e) === name);
        const param = substitute(part("param")?.textContent.trim() ?? "", scope);
        const loopScope = new Scope(scope);
        const iterate = (setValues) => {
            const iteration = new Scope(loopScope);
            setValues(iteration);
            const doElement = childElements(element).find((e) => lower(e) === "do");
            // Parameters with Lifetime="Loop" in the body persist across iterations
            if (doElement !== undefined) {
                for (const block of childElements(doElement).filter((e) => lower(e) === "parameters")) {
                    if ((attr(block, "Lifetime") ?? "").toLowerCase() === "loop") {
                        this.applyParameters(block, iteration, parametersMode(block), iteration, loopScope);
                    }
                }
            }
            body(iteration);
        };
        const list = part("parameters");
        if (list !== undefined) {
            // <Param>NAME</Param><Value>VALUE_NAME</Value><Parameters><A>x</A>...: NAME = A, VALUE_NAME = x
            const valueName = substitute(part("value")?.textContent.trim() ?? "", scope);
            for (const entry of childElements(list)) {
                iterate((iteration) => {
                    iteration.set(param, entry.localName);
                    if (valueName !== "") {
                        iteration.set(valueName, substitute(entry.textContent.trim(), scope));
                    }
                });
            }
            return;
        }
        const number = (name, fallback) => {
            const element = part(name);
            return element === undefined ? fallback : Number(substitute(element.textContent.trim(), scope));
        };
        const from = number("from", 0);
        const to = number("to", undefined);
        const step = number("inc", 1) || 1;
        const whileElement = part("while");
        for (let value = from, guard = 0; guard < 1000; value += step, guard++) {
            if (to !== undefined && (step > 0 ? value > to : value < to)) {
                break;
            }
            const probe = new Scope(loopScope);
            probe.set(param, String(value));
            if (whileElement !== undefined && !this.evaluateTest(whileElement, probe)) {
                break;
            }
            if (to === undefined && whileElement === undefined) {
                break;
            }
            iterate((iteration) => iteration.set(param, String(value)));
        }
    }

    // ------------------------------------------------------------------ compiled behaviors

    /** A compiled .behavior.xml: components in order (OwnerID = index), codes in <Strings>. */
    async readCompiled(path, result) {
        const doc = await this.loadDocument(path);
        if (doc === undefined) {
            this.problem(`compiled behavior file ${path} not found`);
            return;
        }
        const root = doc.documentElement;
        const section = (name) => childElements(root).find((e) => lower(e) === name.toLowerCase());
        const strings = new Map();
        for (const entry of childElements(section("Strings") ?? root.ownerDocument.createElement("x"))) {
            strings.set(entry.localName.replace(/^S_/, ""), entry.textContent);
        }
        const base = result.components.length;
        for (const component of childElements(section("Components") ?? root.ownerDocument.createElement("x"))) {
            const owner = attr(component, "OwnerID");
            result.components.push(
                newComponent(attr(component, "ID") ?? "", attr(component, "Node") ?? "", owner === null ? -1 : base + Number(owner))
            );
        }
        for (const visibility of childElements(section("VisibilityCodes") ?? root.ownerDocument.createElement("x"))) {
            const owner = Number(attr(visibility, "OwnerID"));
            const code = visibility.getElementsByTagName("Code")[0];
            const text = code ? strings.get(attr(code, "StringID") ?? "") ?? code.textContent : undefined;
            const component = result.components[base + owner];
            if (component !== undefined && text !== undefined) {
                component.visibility.push(text.trim());
            }
            result.outputs.Visibility = (result.outputs.Visibility ?? 0) + 1;
        }
        // <Animation OwnerID Name Length Type><Parameter Lag Wrap><Code StringID/></Parameter>
        for (const animation of childElements(section("Animations") ?? root.ownerDocument.createElement("x"))) {
            const component = result.components[base + Number(attr(animation, "OwnerID"))];
            const parameter = childElements(animation).find((e) => lower(e) === "parameter");
            const code = parameter?.getElementsByTagName("Code")[0];
            const text = code ? strings.get(attr(code, "StringID") ?? "") ?? code.textContent : undefined;
            if (component !== undefined && text !== undefined) {
                component.animations.push({
                    name: attr(animation, "Name") ?? "",
                    length: Number(attr(animation, "Length")) || 100,
                    type: attr(animation, "Type") ?? "Sim",
                    code: text.replace(/\s+/g, " ").trim(),
                    lag: Number(attr(parameter, "Lag")) || 0,
                    wrap: (attr(parameter, "Wrap") ?? "").toLowerCase() === "true"
                });
            }
            result.outputs.Animation = (result.outputs.Animation ?? 0) + 1;
        }
        const stringOf = (element) => {
            if (element === undefined) {
                return undefined;
            }
            const id = attr(element, "StringID");
            const text = id !== null ? strings.get(id) : element.textContent;
            return text === undefined ? undefined : text.replace(/\s+/g, " ").trim();
        };
        // <Material OwnerID><EmissiveFactor><Parameter><Code StringID/></Parameter></EmissiveFactor>
        for (const material of childElements(section("Materials") ?? root.ownerDocument.createElement("x"))) {
            const component = result.components[base + Number(attr(material, "OwnerID"))];
            const factor = part(material, "emissivefactor");
            const code = stringOf(part(part(factor, "parameter"), "code"));
            if (component !== undefined && code) {
                const override = part(factor, "overridebaseemissive")?.textContent ?? attr(factor, "OverrideBaseEmissive") ?? "True";
                component.emissive.push({ code, override: override.trim().toLowerCase() !== "false" });
            }
            result.outputs.Material = (result.outputs.Material ?? 0) + 1;
        }
        // <UpdateCodes><Update OwnerID StringID Once="True" | Frequency="20" InteractionModel/>
        for (const update of childElements(section("UpdateCodes") ?? root.ownerDocument.createElement("x"))) {
            const component = result.components[base + Number(attr(update, "OwnerID"))];
            const code = stringOf(update);
            if (component !== undefined && code) {
                component.updates.push(updateOf(code, (name) => attr(update, name) ?? ""));
            }
            result.outputs.Update = (result.outputs.Update ?? 0) + 1;
        }
        // <MouseRect OwnerID HighlightNodeId><Callback Type="CallbackCode"><IMCodeInstances><IMDefault StringID/>
        // <IMDrag StringID/></IMCodeInstances></Callback><IMMouseFlagsInstances><IMDefault>Lock+WheelUp</IMDefault>
        for (const rect of childElements(section("Mouserects") ?? root.ownerDocument.createElement("x"))) {
            const component = result.components[base + Number(attr(rect, "OwnerID"))];
            const callback = part(rect, "callback");
            const instances = part(callback, "imcodeinstances");
            const code =
                instances !== undefined
                    ? stringOf(part(instances, "imdefault") ?? childElements(instances)[0])
                    : stringOf(part(callback, "code") ?? callback);
            const flags = part(part(rect, "immouseflagsinstances"), "imdefault")?.textContent ?? part(rect, "mouseflags")?.textContent ?? "";
            if (component !== undefined && code) {
                component.mouseRects.push({
                    code,
                    flags: splitFlags(flags),
                    tooltip: part(part(part(rect, "imtooltipsinstances"), "imdrag"), "tttitle")?.textContent.trim() ?? "",
                    highlightNode: attr(rect, "HighlightNodeId") ?? attr(rect, "HighlightPartId") ?? ""
                });
            }
            result.outputs.MouseRect = (result.outputs.MouseRect ?? 0) + 1;
        }
        // <InputEvents><Instances><InputEvent OwnerID ID><Value><Code StringID/><Units/></Value>
        // <Inc|Dec|Set|Toggle><Code StringID/>
        for (const event of section("InputEvents")?.getElementsByTagName("InputEvent") ?? []) {
            const component = result.components[base + Number(attr(event, "OwnerID"))];
            if (component !== undefined) {
                const codes = {};
                for (const action of InputEventActions) {
                    const code = stringOf(part(part(event, action.toLowerCase()), "code"));
                    if (code) {
                        codes[action] = code;
                    }
                }
                component.inputEvents.push({
                    id: attr(event, "ID") ?? "",
                    units: part(part(event, "value"), "units")?.textContent.trim() ?? "",
                    codes
                });
            }
            result.outputs.InputEvent = (result.outputs.InputEvent ?? 0) + 1;
        }
    }
}

const newComponent = (id, node, parent) => ({
    id,
    node,
    parent,
    visibility: [],
    animations: [],
    emissive: [],
    updates: [],
    mouseRects: [],
    inputEvents: []
});

/**
 * An update code: { code, once, frequency (per second; 0 = every frame), interactionModel
 * ("Default", "Drag", "All" or "" = any) }. attribute(name) reads the element's attributes.
 */
function updateOf(code, attribute) {
    return {
        code,
        once: attribute("Once").trim().toLowerCase() === "true",
        frequency: Math.max(0, Number(attribute("Frequency").trim()) || 0),
        interactionModel: attribute("InteractionModel").trim()
    };
}

// what an input event preset does: (B:ID) reads Value, (>B:ID_Inc) runs Inc, ...
const InputEventActions = ["Value", "Inc", "Dec", "Set", "Toggle"];

const part = (parent, name) => (parent === undefined ? undefined : childElements(parent).find((e) => lower(e) === name));

const splitFlags = (text) =>
    text
        .split("+")
        .map((flag) => flag.trim())
        .filter((flag) => flag !== "");

/**
 * <MouseRect><MouseFlags>LeftSingle+WheelUp</MouseFlags><TooltipID/><CallbackCode><Code/> or
 * <IMCodeInstances><IMDefault/>...</CallbackCode></MouseRect> (2024 interaction model instances;
 * IMDefault is the code used outside of drag mode). Returns { code, flags, tooltip, highlightNode }.
 */
function mouseRectOf(element, scope) {
    const text = (child) => (child === undefined ? undefined : substitute(child.textContent, scope).replace(/\s+/g, " ").trim());
    const callback = part(element, "callbackcode");
    if (callback === undefined) {
        return undefined;
    }
    const instances = part(callback, "imcodeinstances");
    const code =
        instances !== undefined ? text(part(instances, "imdefault") ?? childElements(instances)[0]) : text(part(callback, "code") ?? callback);
    if (!code) {
        return undefined;
    }
    const flags = text(part(part(element, "immouseflagsinstances"), "imdefault")) ?? text(part(element, "mouseflags")) ?? "";
    return {
        code,
        flags: splitFlags(flags),
        tooltip: text(part(element, "tooltipid")) ?? text(part(element, "tooltiptitle")) ?? "",
        highlightNode: text(part(element, "highlightnode")) ?? ""
    };
}

/**
 * <InputEvent ID><Presets><Preset ID><Value><Code/><Units/></Value><Inc><Code/></Inc>...
 * Each preset is an event (B:<preset ID>); an input event without presets is one itself.
 */
function inputEventsOf(element, scope) {
    const text = (child) => (child === undefined ? undefined : substitute(child.textContent, scope).replace(/\s+/g, " ").trim());
    const presets = part(element, "presets");
    const sources = presets !== undefined ? childElements(presets).filter((e) => lower(e) === "preset") : [element];
    return sources.map((preset) => {
        const codes = {};
        for (const action of InputEventActions) {
            const code = text(part(part(preset, action.toLowerCase()), "code"));
            if (code) {
                codes[action] = code;
            }
        }
        return {
            id: substitute(attr(preset, "ID") ?? "", scope),
            units: text(part(part(preset, "value"), "units")) ?? "",
            codes
        };
    });
}

function parametersMode(element) {
    return (attr(element, "Type") ?? "Default").toLowerCase() === "override" ? "override" : "default";
}

/** #NAME# -> parameter value (repeated, values may contain parameters too). */
function substitute(text, scope) {
    if (!text.includes("#")) {
        return text;
    }
    for (let pass = 0; pass < 8; pass++) {
        let changed = false;
        text = text.replace(/#([A-Za-z0-9_]+)#/g, (whole, name) => {
            const value = scope.get(name);
            if (value === undefined) {
                return whole;
            }
            changed = true;
            return value;
        });
        if (!changed || !text.includes("#")) {
            break;
        }
    }
    return text;
}

/** <Visibility><Parameter><Code>...</Code></Parameter></Visibility> (or Code directly). */
function codeOf(element, scope) {
    const code = element.getElementsByTagName("Code")[0];
    if (code === undefined) {
        return undefined;
    }
    return substitute(code.textContent, scope).replace(/\s+/g, " ").trim();
}

/**
 * <Animation Name Length Type TypeParam><Parameter><Code/><Lag/><Wrap/></Parameter></Animation>
 * or the older <Parameter><Sim><Variable/><Units/><Scale/><Bias/></Sim></Parameter> form.
 * Returns { name, length, type, code, lag, wrap } (undefined without a parameter).
 */
function animationOf(element, scope) {
    const value = (name, fallback = "") => substitute(attr(element, name) ?? fallback, scope);
    const parameter = childElements(element).find((e) => lower(e) === "parameter");
    if (parameter === undefined) {
        return undefined;
    }
    const part = (parent, name) => childElements(parent).find((e) => lower(e) === name);
    const text = (parent, name) => {
        const child = part(parent, name);
        return child === undefined ? undefined : substitute(child.textContent, scope).trim();
    };
    let code = text(parameter, "code");
    const sim = part(parameter, "sim");
    if (code === undefined && sim !== undefined) {
        const variable = text(sim, "variable") ?? "";
        const units = text(sim, "units") ?? "number";
        const scale = text(sim, "scale") ?? "1";
        const bias = text(sim, "bias") ?? "0";
        code = `(A:${variable}, ${units}) ${scale} * ${bias} +`;
    }
    if (code === undefined) {
        return undefined;
    }
    return {
        name: value("Name") || value("name"),
        length: Number(value("Length") || value("length") || "100") || 100,
        type: value("Type") || value("type") || "Sim",
        code: code.replace(/\s+/g, " ").trim(),
        lag: Number(text(parameter, "lag") ?? attr(parameter, "Lag") ?? 0) || 0,
        wrap: (text(parameter, "wrap") ?? attr(parameter, "Wrap") ?? "").toLowerCase() === "true"
    };
}

/**
 * <Material><EmissiveFactor><Parameter><Code/> (or <Sim>)</Parameter><OverrideBaseEmissive/>
 * </EmissiveFactor></Material>. Returns { code, override } (undefined without a parameter).
 */
function emissiveOf(element, scope) {
    const factor = part(element, "emissivefactor");
    const parameter = part(factor, "parameter");
    if (parameter === undefined) {
        return undefined;
    }
    const text = (child) => (child === undefined ? undefined : substitute(child.textContent, scope).replace(/\s+/g, " ").trim());
    let code = text(part(parameter, "code"));
    const sim = part(parameter, "sim");
    if (code === undefined && sim !== undefined) {
        code = `(A:${text(part(sim, "variable")) ?? ""}, ${text(part(sim, "units")) || "number"}) ${text(part(sim, "scale")) || "1"} * ${text(part(sim, "bias")) || "0"} +`;
    }
    if (!code) {
        return undefined;
    }
    return { code, override: (text(part(factor, "overridebaseemissive")) ?? "True").toLowerCase() !== "false" };
}

/** A condition without True/False: its children except the Test. */
function withoutTest(element) {
    const copy = element.cloneNode(true);
    for (const child of [...copy.children]) {
        if (lower(child) === "test") {
            copy.removeChild(child);
        }
    }
    return copy;
}

function folderOf(path) {
    const index = path.lastIndexOf("/");
    return index < 0 ? "" : path.substring(0, index);
}

/** Joins a folder and a relative path (\ or /, "..", "."). */
function joinPath(folder, relative) {
    const parts = folder === "" ? [] : folder.split("/");
    for (const part of relative.replace(/\\+/g, "/").split("/")) {
        if (part === "" || part === ".") {
            continue;
        }
        if (part === "..") {
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    return parts.join("/");
}

export { BehaviorExpander, substitute, truthy };
