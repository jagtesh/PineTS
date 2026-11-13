// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * Keltner Channels (KC)
 *
 * Formula:
 * basis = ta.ema(src, length)
 * span = useTrueRange ? ta.tr : (high - low)
 * rangeEma = ta.ema(span, length)
 * upper = basis + rangeEma * mult
 * lower = basis - rangeEma * mult
 * Returns [basis, upper, lower]
 */
export function kc(context: any) {
    return (source: any, _length: any, _mult: any, _useTrueRange?: any, _callId?: string) => {
        const length = Series.val(_length);
        const mult = Series.val(_mult);
        let useTrueRange = true;
        if (typeof _useTrueRange === 'string') {
            //this is the _callId passed by the transpiler
            _callId = _useTrueRange;
        } else if (_useTrueRange !== undefined) {
            useTrueRange = Series.val(_useTrueRange);
        }

        // Calculate span
        let span;
        const high = context.get(context.data.high, 0);
        const low = context.get(context.data.low, 0);

        if (useTrueRange) {
            // Calculate TR
            const close1 = context.get(context.data.close, 1);
            if (isNaN(close1)) {
                span = NaN;
            } else {
                span = Math.max(high - low, Math.abs(high - close1), Math.abs(low - close1));
            }
        } else {
            span = high - low;
        }

        const currentValue = Series.val(source);

        if (!context.taState) context.taState = {};
        const stateKey = _callId || `kc_${length}_${mult}_${useTrueRange}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                basisState: { prevEma: null, initSum: 0, initCount: 0 },
                rangeState: { prevEma: null, initSum: 0, initCount: 0 },
                // Tentative state
                currentBasisState: { prevEma: null, initSum: 0, initCount: 0 },
                currentRangeState: { prevEma: null, initSum: 0, initCount: 0 },
            };
        }

        const state = context.taState[stateKey];

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                // Commit tentative states to committed states
                state.basisState = { ...state.currentBasisState };
                state.rangeState = { ...state.currentRangeState };
            }
            state.lastIdx = context.idx;
        }

        // Helper to update EMA state
        // We read from 'prev' state and write to 'current' state (tentative)
        const updateEma = (committedState: any, tentativeState: any, value: number, period: number) => {
            if (isNaN(value)) {
                // As ta.ema: na on the na bar, the state carried to the next one
                Object.assign(tentativeState, committedState);
                return NaN;
            }

            let initCount = committedState.initCount;
            let initSum = committedState.initSum;
            let prevEma = committedState.prevEma;

            if (initCount < period) {
                initSum += value;
                initCount++;

                tentativeState.initSum = initSum;
                tentativeState.initCount = initCount;
                tentativeState.prevEma = prevEma; // Unchanged until initialized

                if (initCount === period) {
                    const ema = initSum / period;
                    tentativeState.prevEma = ema;
                    return ema;
                }
                return NaN;
            }

            const alpha = 2 / (period + 1);
            const ema = value * alpha + prevEma * (1 - alpha);
            
            tentativeState.prevEma = ema;
            tentativeState.initSum = initSum;
            tentativeState.initCount = initCount;

            return ema;
        };

        const basis = updateEma(state.basisState, state.currentBasisState, currentValue, length);
        const rangeEma = updateEma(state.rangeState, state.currentRangeState, span, length);

        if (isNaN(basis) || isNaN(rangeEma)) {
            return [[NaN, NaN, NaN]];
        }

        const upper = basis + rangeEma * mult;
        const lower = basis - rangeEma * mult;

        return [[context.precision(basis), context.precision(upper), context.precision(lower)]];
    };
}
