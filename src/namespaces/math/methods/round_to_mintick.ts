// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';
import { Context } from '../../../Context.class';

// TradingView treats a value up to 1e-10 tick below a half tick as the half tick (measured with
// mintick 0.01 and 0.00001). Expressed as 2e10 * frac >= 1e10 - 2 to stay in integers.
const HALF_TICK_TOLERANCE_NUM = 10n ** 10n - 2n;
const HALF_TICK_TOLERANCE_DEN = 2n * 10n ** 10n;

/** Exact `[mantissa, exponent]` of a finite positive double: value = mantissa * 2^exponent. */
function decompose(value: number): [bigint, number] {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0);
    const exp = Number((bits >> 52n) & 0x7ffn);
    const frac = bits & ((1n << 52n) - 1n);
    return exp === 0 ? [frac, -1074] : [frac | (1n << 52n), exp - 1075];
}

/** A decimal mintick as `[numerator, scale]`: mintick = numerator / 10^scale. */
function decimalParts(mintick: number): [bigint, number] {
    const [coef, expPart] = String(mintick).split('e');
    const [int, frac = ''] = coef.split('.');
    const scale = frac.length - Number(expPart ?? 0);
    const digits = BigInt(int + frac);
    return scale >= 0 ? [digits, scale] : [digits * 10n ** BigInt(-scale), 0];
}

/**
 * Rounds |value| to a whole number of ticks the way TradingView does: half up on the exact binary
 * value (not on the rounded quotient `value / mintick`), with the half-tick tolerance above.
 */
function roundTicks(abs: number, mintick: number): number {
    const q = abs / mintick;
    const floor = Math.floor(q);
    // Away from a half tick the double quotient decides correctly (its error grows with q).
    if (Math.abs(q - floor - 0.5) > 1e-6 + q * 1e-12 || !Number.isSafeInteger(floor)) return Math.round(q);
    const [mant, exp] = decompose(abs);
    const [num, scale] = decimalParts(mintick);
    // q = N / D exactly
    let N = mant * 10n ** BigInt(scale);
    let D = num;
    if (exp >= 0) N <<= BigInt(exp);
    else D <<= BigInt(-exp);
    const k = BigInt(floor);
    return HALF_TICK_TOLERANCE_DEN * (N - k * D) >= HALF_TICK_TOLERANCE_NUM * D ? floor + 1 : floor;
}

/** ticks * mintick as the double nearest to the decimal result (ticks * 0.00001 can land one ulp off). */
function ticksToPrice(ticks: number, mintick: number): number {
    const [num, scale] = decimalParts(mintick);
    const scaled = ticks * Number(num);
    return Number.isSafeInteger(scaled) && scale <= 22 ? scaled / 10 ** scale : ticks * mintick;
}

export function round_to_mintick(context: Context) {
    return (source: any) => {
        const value = Series.val(source);
        const mintick = context.pine.syminfo.mintick;
        if (!Number.isFinite(value) || !(mintick > 0) || value === 0) {
            return context.precision(Math.round(value / mintick) * mintick);
        }
        const ticks = roundTicks(Math.abs(value), mintick);
        return context.precision(Math.sign(value) * ticksToPrice(ticks, mintick));
    };
}
