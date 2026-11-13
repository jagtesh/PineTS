// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LuxAlgo

/**
 * Scalar lowering.
 *
 * The main transformation gives every Pine variable a `Series` living on a
 * context bag (`$.let.for4_w`, `$$.let.fn1_num`) and routes every read and
 * write through `$.get` / `$.set` / `$.init`, and every built-in argument
 * through a `*.param(...)` wrapper. That is what makes history (`x[1]`) and
 * per-call-site state work — but most variables in a loop body or a user
 * function never use either: they are plain scalars that live for one
 * execution of one bar. For those the Series, the property-bag lookups, the
 * wrapper allocations and the per-bar history shift are pure overhead, and in
 * loop-heavy scripts that overhead is nearly all of the run time.
 *
 * This pass runs on the FINAL generated JavaScript (re-parsed, so it sees
 * exactly what would execute and none of the transformer's annotation fields)
 * and rewrites two shapes, both exactly behaviour-preserving:
 *
 * 1. Scalar slots. A `$.let.X` / `$$.let.X` (or `.const`) slot is lowered to a
 *    JavaScript local when EVERY occurrence of it in the program is one of
 *
 *        slot = $.init(slot, E)          (statement)   ->  __s_X = $.val(E)
 *        $.get(slot, 0)                                ->  __s_X
 *        $.set(slot, E)                  (statement)   ->  __s_X = $.precision(E)
 *        array.param(slot, undefined, n)               ->  __s_X
 *
 *    all inside one function, and every read/write is preceded, in the same
 *    block or an enclosing one, by one of its `$.init` statements. Under those
 *    conditions the Series is never handed to anything that could read its
 *    history or keep a reference, and it is always (re)initialised before use
 *    within the bar — so its value never has to survive the bar, and a local
 *    is indistinguishable. Anything else (`x[1]`, passing the variable to a
 *    built-in or a user function, returning it, a `var`) leaves the slot alone.
 *
 *    `$.val` is the value extraction `$.init` itself performs; it is skipped
 *    when E is syntactically a primitive. `$.set` rounds numbers through
 *    `$.precision`, so the lowered write does too.
 *
 *    Global-scope variables (`glb*`) are never lowered: they are part of the
 *    observable context (`context.let`), which hosts read.
 *
 * 2. Pure math arguments. `const pN = math.param(E, undefined, name)` whose
 *    only uses are as direct arguments to math built-ins that read nothing but
 *    the current value of their arguments becomes `const pN = E`. For such a
 *    callee `Series.val(math.param(E))` and `Series.val(E)` are the same value
 *    for every E, and the series `math.param` records under `name` is
 *    unreachable.
 */

import * as acorn from 'acorn';
import * as astring from 'astring';

/** math built-ins that read only `Series.val(arg)` of each argument (see src/namespaces/math/methods). */
const PURE_MATH = new Set([
    'abs', 'acos', 'asin', 'atan', 'avg', 'ceil', 'cos', 'exp', 'floor', 'ln', 'log', 'log10',
    'max', 'min', 'pow', 'round', 'sign', 'sin', 'sqrt', 'tan', 'todegrees', 'toradians',
]);

const LOCAL_PREFIX = '__s_';
const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'raw', 'regex', 'bigint']);

type Node = any;

interface Frame {
    node: Node;
    /** Key on the parent under which `node` sits, and its index when that key holds an array. */
    key: string;
    index: number;
}

interface Occurrence {
    node: Node;
    /** Ancestors from the root down to the direct parent; `path[i]` describes how the next node hangs off it. */
    path: Frame[];
    fn: Node | null;
}

interface Slot {
    key: string;
    ctx: string;
    name: string;
    occurrences: Occurrence[];
}

const isId = (n: Node, name?: string) => n && n.type === 'Identifier' && (name === undefined || n.name === name);
const isFunction = (n: Node) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';

/** `obj.prop` with both sides plain identifiers. */
function isMember(n: Node, obj: string, prop?: string): boolean {
    return n && n.type === 'MemberExpression' && !n.computed && isId(n.object, obj) && isId(n.property) && (prop === undefined || n.property.name === prop);
}

/** `$.let.X` / `$$.const.X` → its parts, else null. */
function slotOf(n: Node): { ctx: string; kind: string; name: string } | null {
    if (!n || n.type !== 'MemberExpression' || n.computed || !isId(n.property)) return null;
    const bag = n.object;
    if (!bag || bag.type !== 'MemberExpression' || bag.computed || !isId(bag.property)) return null;
    if (!isId(bag.object, '$') && !isId(bag.object, '$$')) return null;
    if (bag.property.name !== 'let' && bag.property.name !== 'const') return null;
    return { ctx: bag.object.name, kind: bag.property.name, name: n.property.name };
}

/** True when evaluating `n` can only yield a primitive (so `$.val(n)` is `n`). */
function isPrimitiveExpr(n: Node, pureConsts: Map<string, Node>): boolean {
    switch (n.type) {
        case 'Literal':
            return !n.regex;
        case 'TemplateLiteral':
        case 'UnaryExpression':
        case 'UpdateExpression':
        case 'BinaryExpression':
            // Every JS unary/binary operator the transpiler emits (`in` and
            // `instanceof` included) yields a primitive.
            return n.type !== 'UnaryExpression' || n.operator !== 'delete';
        case 'ConditionalExpression':
            return isPrimitiveExpr(n.consequent, pureConsts) && isPrimitiveExpr(n.alternate, pureConsts);
        case 'Identifier':
            return n.name === 'NaN' || n.name === 'undefined' || n.name === 'Infinity' || pureConsts.has(n.name);
        case 'CallExpression':
            return isPureMathCall(n);
        default:
            return false;
    }
}

/** `math.<pure>(...)` — these all return a number. */
function isPureMathCall(n: Node): boolean {
    return n.type === 'CallExpression' && isMember(n.callee, 'math') && PURE_MATH.has(n.callee.property.name) && !n.arguments.some((a: Node) => a.type === 'SpreadElement');
}

function call(obj: string, method: string, args: Node[]): Node {
    return {
        type: 'CallExpression',
        callee: { type: 'MemberExpression', object: { type: 'Identifier', name: obj }, property: { type: 'Identifier', name: method }, computed: false, optional: false },
        arguments: args,
        optional: false,
    };
}

/**
 * Lower scalar slots and pure-math argument wrappers in generated code.
 * Returns the input unchanged when nothing applies or the code has a shape
 * the pass does not recognise.
 */
export function lowerScalars(code: string): string {
    let ast: Node;
    try {
        ast = acorn.parse(code, { ecmaVersion: 'latest' });
    } catch {
        return code;
    }

    const slots = new Map<string, Slot>();
    /** Identifier references by name (declarations and property names excluded). */
    const refs = new Map<string, Occurrence[]>();
    /** `const NAME = <init>` declarators by name; null once a name is declared twice. */
    const constDecls = new Map<string, { decl: Node; fn: Node | null } | null>();
    const declaredNames = new Set<string>();
    let bail = false;

    const path: Frame[] = [];
    const fnStack: Node[] = [];

    const visit = (node: Node, key: string, index: number): void => {
        if (bail || !node || typeof node.type !== 'string') return;
        const parent = path.length ? path[path.length - 1].node : null;
        const fn = fnStack.length ? fnStack[fnStack.length - 1] : null;

        const slot = slotOf(node);
        if (slot) {
            const id = `${slot.ctx}.${slot.kind}.${slot.name}`;
            let entry = slots.get(id);
            if (!entry) slots.set(id, (entry = { key: id, ctx: slot.ctx, name: slot.name, occurrences: [] }));
            entry.occurrences.push({ node, path: path.slice(), fn });
            return;
        }
        // A context bag used any other way (`$.let` passed around, `$.let[k]`)
        // could reach a slot behind our back.
        if (node.type === 'MemberExpression' && !node.computed && (isId(node.object, '$') || isId(node.object, '$$')) && (node.property.name === 'let' || node.property.name === 'const')) {
            bail = true;
            return;
        }

        if (node.type === 'Identifier') {
            const isPropertyName = parent && ((parent.type === 'MemberExpression' && key === 'property' && !parent.computed) || (parent.type === 'Property' && key === 'key' && !parent.computed));
            const isBinding = parent && ((parent.type === 'VariableDeclarator' && key === 'id') || (isFunction(parent) && (key === 'id' || key === 'params')));
            if (isBinding) declaredNames.add(node.name);
            if (!isPropertyName && !isBinding) {
                let list = refs.get(node.name);
                if (!list) refs.set(node.name, (list = []));
                list.push({ node, path: path.slice(), fn });
            }
            return;
        }

        if (node.type === 'VariableDeclarator' && isId(node.id) && parent.kind === 'const' && parent.declarations.length === 1) {
            constDecls.set(node.id.name, constDecls.has(node.id.name) ? null : { decl: node, fn });
        }

        const enters = isFunction(node);
        if (enters) fnStack.push(node);
        for (const k in node) {
            if (SKIP_KEYS.has(k)) continue;
            const child = node[k];
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    if (child[i] && typeof child[i].type === 'string') {
                        path.push({ node, key: k, index: i });
                        visit(child[i], k, i);
                        path.pop();
                    }
                }
            } else if (child && typeof child.type === 'string') {
                path.push({ node, key: k, index: -1 });
                visit(child, k, -1);
                path.pop();
            }
        }
        if (enters) fnStack.pop();
    };
    visit(ast, '', -1);
    if (bail) return code;

    let changed = false;
    const replace = (frame: Frame, child: Node) => {
        if (frame.index >= 0) frame.node[frame.key][frame.index] = child;
        else frame.node[frame.key] = child;
        changed = true;
    };

    // ── 2. Pure math arguments ────────────────────────────────────────────
    // Done first so the scalar pass sees `const pN = E` and can treat temps
    // fed by pure math calls as primitives.
    const pureConsts = new Map<string, Node>();
    for (const [name, entry] of constDecls) {
        if (!entry) continue;
        const init = entry.decl.init;
        if (!init || init.type !== 'CallExpression' || !isMember(init.callee, 'math', 'param')) continue;
        if (init.arguments.length !== 3 || !isId(init.arguments[1], 'undefined') || init.arguments[0].type === 'SpreadElement') continue;
        const uses = refs.get(name) || [];
        const onlyPureArgs = uses.every((u) => {
            const p = u.path[u.path.length - 1];
            return u.fn === entry.fn && p.key === 'arguments' && isPureMathCall(p.node);
        });
        if (!onlyPureArgs) continue;
        entry.decl.init = init.arguments[0];
        changed = true;
    }
    for (const [name, entry] of constDecls) {
        if (entry && entry.decl.init && isPureMathCall(entry.decl.init)) pureConsts.set(name, entry.decl.init);
    }

    // ── 1. Scalar slots ───────────────────────────────────────────────────
    /** `call` is the `$.set` / `$.init` call; its value operand is read at rewrite time, after reads nested in it were replaced. */
    type Action = { kind: 'init' | 'get' | 'set' | 'arg' | 'initLeft'; frame: Frame; call?: Node };
    const pending: { local: string; actions: Action[] }[] = [];
    const lowered = new Map<Node | null, string[]>();

    for (const slot of slots.values()) {
        if (slot.name.startsWith('glb')) continue;
        const local = LOCAL_PREFIX + slot.name;
        if (declaredNames.has(local) || refs.has(local)) continue;

        const home = slot.occurrences[0].fn;
        if (!home || home.body.type !== 'BlockStatement') continue;
        const actions: Action[] = [];
        /** Blocks holding an init statement of this slot, with the statement's index. */
        const inits: { block: Node; key: string; index: number }[] = [];
        let ok = true;

        for (const occ of slot.occurrences) {
            if (occ.fn !== home) { ok = false; break; }
            const p = occ.path[occ.path.length - 1];
            const g = occ.path[occ.path.length - 2];
            const gg = occ.path[occ.path.length - 3];
            const parent = p.node;

            if (parent.type === 'CallExpression' && p.key === 'arguments' && p.index === 0 && isId(parent.callee.object, '$') && isMember(parent.callee, '$')) {
                const method = parent.callee.property.name;
                if (method === 'get' && parent.arguments.length === 2 && parent.arguments[1].type === 'Literal' && parent.arguments[1].value === 0) {
                    actions.push({ kind: 'get', frame: g });
                    continue;
                }
                if (method === 'set' && parent.arguments.length === 2 && g.node.type === 'ExpressionStatement') {
                    actions.push({ kind: 'set', frame: g, call: parent });
                    continue;
                }
                if (method === 'init' && parent.arguments.length === 2 && g.node.type === 'AssignmentExpression' && g.node.operator === '=' && g.key === 'right' && gg && gg.node.type === 'ExpressionStatement') {
                    const left = slotOf(g.node.left);
                    const stmt = occ.path[occ.path.length - 4];
                    if (left && `${left.ctx}.${left.kind}.${left.name}` === slot.key && stmt && stmt.index >= 0) {
                        actions.push({ kind: 'init', frame: gg, call: parent });
                        inits.push({ block: stmt.node, key: stmt.key, index: stmt.index });
                        continue;
                    }
                }
            }
            if (parent.type === 'AssignmentExpression' && p.key === 'left' && parent.operator === '=' && g.node.type === 'ExpressionStatement') {
                const r = parent.right;
                const target = r && r.type === 'CallExpression' && isMember(r.callee, '$', 'init') && r.arguments.length === 2 ? slotOf(r.arguments[0]) : null;
                if (target && `${target.ctx}.${target.kind}.${target.name}` === slot.key) {
                    actions.push({ kind: 'initLeft', frame: g });
                    continue;
                }
            }
            if (parent.type === 'CallExpression' && p.key === 'arguments' && p.index === 0 && isMember(parent.callee, 'array', 'param') && parent.arguments.length >= 2 && parent.arguments.length <= 3 && isId(parent.arguments[1], 'undefined')) {
                actions.push({ kind: 'arg', frame: g });
                continue;
            }
            ok = false;
            break;
        }
        if (!ok || inits.length === 0) continue;

        // Every read/write must follow an init statement in its own block or an enclosing one.
        const dominated = (occ: Occurrence) => {
            for (const f of occ.path) {
                if (f.index < 0) continue;
                for (const init of inits) {
                    if (init.block === f.node && init.key === f.key && init.index < f.index) return true;
                }
            }
            return false;
        };
        const allDominated = slot.occurrences.every((occ, i) => actions[i].kind === 'init' || actions[i].kind === 'initLeft' || dominated(occ));
        if (!allDominated) continue;

        pending.push({ local, actions });
        changed = true;
        let names = lowered.get(home);
        if (!names) lowered.set(home, (names = []));
        names.push(local);
    }

    // Rewrite in two phases across ALL lowered slots: reads first (they may sit
    // inside the value operand of another slot's write), then writes, taking the
    // operand from the call as it stands now.
    for (const { local, actions } of pending) {
        for (const a of actions) {
            if (a.kind === 'get' || a.kind === 'arg') replace(a.frame, { type: 'Identifier', name: local });
        }
    }
    for (const { local, actions } of pending) {
        const assign = (right: Node) => ({ type: 'AssignmentExpression', operator: '=', left: { type: 'Identifier', name: local }, right });
        for (const a of actions) {
            if (a.kind !== 'set' && a.kind !== 'init') continue;
            const value = a.call.arguments[1];
            if (a.kind === 'set') a.frame.node.expression = assign(call('$', 'precision', [value]));
            else a.frame.node.expression = assign(isPrimitiveExpr(value, pureConsts) ? value : call('$', 'val', [value]));
        }
    }

    if (!changed) return code;

    for (const [fn, names] of lowered) {
        fn.body.body.unshift({
            type: 'VariableDeclaration',
            kind: 'let',
            declarations: names.map((name) => ({ type: 'VariableDeclarator', id: { type: 'Identifier', name }, init: null })),
        });
    }
    return astring.generate(ast);
}
