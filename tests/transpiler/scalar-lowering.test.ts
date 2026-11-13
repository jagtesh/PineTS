// SPDX-License-Identifier: AGPL-3.0-only
// Scalar lowering (src/transpiler/transformers/ScalarLoweringPass.ts) is an optimisation: it must
// never change what a script computes. So the reference here is PineTS itself with the pass
// switched off — every script below runs both ways and the plots must be identical, bar for bar.
// The shape tests pin which variables are lowered and, more importantly, which are not.

import { describe, it, expect } from 'vitest';
import { PineTS } from '../../src/PineTS.class';
import { transpile } from '../../src/transpiler';
import { lowerScalars } from '../../src/transpiler/transformers/ScalarLoweringPass';
import { Provider } from '@pinets/marketData/Provider.class';

const code = (pine: string, lower = true) => transpile(`//@version=6\nindicator("t")\n${pine}`, { debug: false, lower }).toString();

async function plotsOf(pine: string, lower: boolean): Promise<Record<string, any[]>> {
    const prev = process.env.PINETS_DISABLE_LOWERING;
    process.env.PINETS_DISABLE_LOWERING = lower ? '0' : '1';
    try {
        const pineTS = new PineTS(Provider.Mock, 'BTCUSDC', '60', null, new Date('2024-01-01').getTime(), new Date('2024-01-12').getTime());
        const { plots } = await pineTS.run(`//@version=6\nindicator("t")\n${pine}`);
        const out: Record<string, any[]> = {};
        for (const [name, p] of Object.entries<any>(plots)) {
            if (name.startsWith('__')) continue;
            out[name] = p.data.map((d: any) => (typeof d.value === 'number' && Number.isNaN(d.value) ? 'na' : d.value));
        }
        return out;
    } finally {
        if (prev === undefined) delete process.env.PINETS_DISABLE_LOWERING;
        else process.env.PINETS_DISABLE_LOWERING = prev;
    }
}

describe('scalar lowering — which variables become locals', () => {
    it('lowers function-local and loop-local scalars, and drops math.param around pure math calls', () => {
        const js = code(`f(float src, int n) =>
    float acc = 0.0
    for i = 0 to n - 1
        w = math.exp(-i / 4.0)
        acc += src[i] * w
    acc
plot(f(close, 10))`);
        expect(js).toContain('let __s_fn1_acc');
        expect(js).toMatch(/__s_for\d+_w = /);
        expect(js).not.toMatch(/\$\$\.let\.fn1_acc/);
        expect(js).not.toContain('math.param(');
        // the history read of the parameter is untouched
        expect(js).toContain('$.get(src, i)');
    });

    it('lowers a loop-local at global scope but never a global variable', () => {
        const js = code(`total = 0.0
for i = 0 to 9
    step = close[i] * 2
    total += step
plot(total)`);
        expect(js).toMatch(/__s_for\d+_step/);
        expect(js).toContain('$.let.glb1_total');
        expect(js).not.toContain('__s_glb1_total');
    });

    it('a function-local whose history is read keeps that history in its $.param series', () => {
        // The main transformation records `x[1]` of a function-local through a `$.param` series
        // fed the current value — so the variable itself can be a local and the history survives.
        const js = code(`f() =>
    x = close * 2
    x[1]
plot(f())`);
        expect(js).toMatch(/const (p\d+) = \$\.param\(__s_fn1_x, undefined, [^)]*\);\s*return \$\.precision\(\$\.get\(\1, 1\)\)/);
    });

    it('keeps a global whose history is read', () => {
        const js = code(`x = close * 2
plot(x[1])`);
        expect(js).toContain('$.let.glb1_x');
        expect(js).not.toContain('__s_');
    });

    it('keeps a variable handed to a stateful built-in or returned as a series', () => {
        const js = code(`f() =>
    x = close * 2
    ta.sma(x, 5)
g() =>
    y = close * 3
    y
plot(f() + g()[1])`);
        expect(js).toContain('$$.let.fn1_x');
        expect(js).not.toContain('__s_fn1_x');
    });

    it('keeps `var` variables and math calls that read a series history', () => {
        const js = code(`f() =>
    var int count = 0
    count += 1
    count
plot(f())
plot(math.sum(close, 5))`);
        expect(js).toContain('$$.var.fn1_count');
        expect(js).toContain('math.param(');
    });

    it('is the identity on code it does not recognise, and switches off with lower: false', () => {
        expect(lowerScalars('this is not javascript {')).toBe('this is not javascript {');
        const src = `f() =>
    a = close + 1
    a * 2
plot(f())`;
        expect(code(src, false)).not.toContain('__s_');
        expect(code(src, true)).toContain('__s_fn1_a');
    });
});

describe('scalar lowering — identical results with and without the pass', () => {
    const scripts: Record<string, string> = {
        'kernel / regression loops over history': `kernel(float src, int n, float h) =>
    float num = 0.0
    float den = 0.0
    for i = 0 to n - 1
        w = math.exp(-(i * i) / (2.0 * h * h))
        num += src[i] * w
        den += w
    num / den
slope(float src, int n) =>
    float sx = 0.0
    float sy = 0.0
    float sxy = 0.0
    float sxx = 0.0
    for i = 0 to n - 1
        y = src[i]
        sx += i
        sy += y
        sxy += i * y
        sxx += i * i
    (n * sxy - sx * sy) / (n * sxx - sx * sx)
plot(kernel(close, 20, 5), "k")
plot(slope(close, 20), "s")`,

        'array histogram in a global loop': `var array<float> hist = array.new<float>(8, 0.0)
hi = ta.highest(high, 20)
lo = ta.lowest(low, 20)
rng = hi - lo
array.fill(hist, 0.0)
if rng > 0
    for i = 0 to 19
        idx = math.min(7, math.max(0, math.floor((close[i] - lo) / rng * 8)))
        array.set(hist, idx, array.get(hist, idx) + volume[i])
best = 0
bestVol = 0.0
for i = 0 to 7
    v = array.get(hist, i)
    if v > bestVol
        bestVol := v
        best := i
plot(best, "best")
plot(bestVol, "vol")`,

        'loops used as values, nested loops, while': `n(int m) =>
    float acc = 0.0
    for i = 0 to 1
        for j = 0 to m
            acc += 1
g(int m) =>
    float r = na
    r := if m == 1
        int c = 0
        while c < 5
            c += 1
    else
        -2
    r
k = bar_index % 4
plot(n(k), "nested")
plot(g(k), "ifexpr")`,

        'conditionally assigned locals, na, bool and string locals': `f(float x) =>
    float r = na
    bool up = x > x[1]
    string tag = up ? "u" : "d"
    if up
        t = x * 2
        r := t + 1
    else if x < 0
        r := -1
    int len = str.length(tag)
    na(r) ? len : r + len
plot(f(close - open), "f")`,

        'switch arms and tuple returns with local scalars': `f(int m) =>
    a = m * 2
    b = switch m
        0 => a + 1
        1 =>
            c = a * 3
            c - 1
        => -1
    [a, b]
k = bar_index % 3
[x, y] = f(k)
plot(x, "x")
plot(y, "y")`,

        'locals holding objects: UDT instance, array, for-in': `type P
    float v
    int i
f() =>
    arr = array.new<float>(0)
    for i = 0 to 4
        p = P.new(close[i], i)
        q = p.v * (p.i + 1)
        array.push(arr, q)
    float s = 0.0
    for e in arr
        d = e / 2
        s += d
    s
plot(f(), "f")`,

        'history of function-locals and of values computed in a loop': `f(float src) =>
    x = src * 2
    y = x - x[1]
    float m = 0.0
    for i = 1 to 3
        d = x[i] - x[i - 1]
        m := math.max(m, math.abs(d))
    y + m[1]
plot(f(close), "f")
plot(f(hl2)[2], "g")`,

        'a function called from two sites keeps independent results': `f(float src, int n) =>
    float s = 0.0
    for i = 0 to n - 1
        s += src[i]
    s / n
plot(f(close, 5), "a")
plot(f(open, 9), "b")
plot(f(f(high, 3), 4), "c")`,
    };

    for (const [name, pine] of Object.entries(scripts)) {
        it(name, async () => {
            const lowered = await plotsOf(pine, true);
            const reference = await plotsOf(pine, false);
            expect(Object.keys(lowered).length).toBeGreaterThan(0);
            expect(lowered).toEqual(reference);
            // guard against a vacuous comparison: the script produced real numbers
            const anyNumber = Object.values(reference).some((series) => series.some((v) => typeof v === 'number'));
            expect(anyNumber).toBe(true);
        });
    }
});
