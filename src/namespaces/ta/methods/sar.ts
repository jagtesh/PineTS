// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * Parabolic SAR (Stop and Reverse)
 *
 * Parabolic SAR is a method devised by J. Welles Wilder, Jr., to find potential reversals
 * in the market price direction.
 *
 * @param start - Start acceleration factor
 * @param inc - Increment acceleration factor
 * @param max - Maximum acceleration factor
 * @returns Parabolic SAR value
 */
export function sar(context: any) {
    return (_start: any, _inc: any, _max: any, _callId?: string) => {
        const start = Series.val(_start);
        const inc = Series.val(_inc);
        const max = Series.val(_max);

        if (!context.taState) context.taState = {};
        const stateKey = _callId || `sar_${start}_${inc}_${max}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevResult: NaN,
                prevMaxMin: NaN,
                prevAcceleration: NaN,
                prevIsBelow: false,
                prevBarIndex: 0,
                // Tentative state
                currentResult: NaN,
                currentMaxMin: NaN,
                currentAcceleration: NaN,
                currentIsBelow: false,
                currentBarIndex: 0,
            };
        }

        const state = context.taState[stateKey];

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevResult = state.currentResult;
                state.prevMaxMin = state.currentMaxMin;
                state.prevAcceleration = state.currentAcceleration;
                state.prevIsBelow = state.currentIsBelow;
                state.prevBarIndex = state.currentBarIndex;
            }
            state.lastIdx = context.idx;
        }

        // Use tentative state variables, initialized from committed state
        let result = state.prevResult;
        let maxMin = state.prevMaxMin;
        let acceleration = state.prevAcceleration;
        let isBelow = state.prevIsBelow;
        let barIndex = state.prevBarIndex;

        // Get current OHLC
        const high = context.get(context.data.high, 0);
        const low = context.get(context.data.low, 0);
        const close = context.get(context.data.close, 0);

        // Get previous OHLC
        const prevClose = context.get(context.data.close, 1);
        const prevHigh = context.get(context.data.high, 1);
        const prevLow = context.get(context.data.low, 1);
        const prevHigh2 = context.get(context.data.high, 2);
        const prevLow2 = context.get(context.data.low, 2);

        // Handle NaN inputs
        if (isNaN(high) || isNaN(low) || isNaN(close)) {
             // Just propagate previous state if current bar is invalid
             state.currentResult = result;
             state.currentMaxMin = maxMin;
             state.currentAcceleration = acceleration;
             state.currentIsBelow = isBelow;
             state.currentBarIndex = barIndex;
             return NaN;
        }

        let isFirstTrendBar = false;

        // Initialize on second bar (bar_index 1)
        // Pine Script bar_index is 0-based. First bar is 0.
        if (barIndex === 1) {
            if (close > prevClose) {
                isBelow = true;
                maxMin = high;
                result = prevLow;
            } else {
                isBelow = false;
                maxMin = low;
                result = prevHigh;
            }
            isFirstTrendBar = true;
            acceleration = start;
        }

        // Only calculate if initialized
        if (barIndex >= 1) {
            // Calculate SAR
            // result := result + acceleration * (maxMin - result)
            result = result + acceleration * (maxMin - result);

            // Check for Reversal
            if (isBelow) {
                if (result > low) {
                    isFirstTrendBar = true;
                    isBelow = false;
                    result = Math.max(high, maxMin);
                    maxMin = low;
                    acceleration = start;
                }
            } else {
                if (result < high) {
                    isFirstTrendBar = true;
                    isBelow = true;
                    result = Math.min(low, maxMin);
                    maxMin = high;
                    acceleration = start;
                }
            }

            // Update Acceleration and MaxMin if not a reversal bar
            if (!isFirstTrendBar) {
                if (isBelow) {
                    if (high > maxMin) {
                        maxMin = high;
                        acceleration = Math.min(acceleration + inc, max);
                    }
                } else {
                    if (low < maxMin) {
                        maxMin = low;
                        acceleration = Math.min(acceleration + inc, max);
                    }
                }
            }

            // Ensure SAR doesn't penetrate recent prices
            if (isBelow) {
                result = Math.min(result, prevLow);
                if (barIndex > 1) {
                    result = Math.min(result, prevLow2);
                }
            } else {
                result = Math.max(result, prevHigh);
                if (barIndex > 1) {
                    result = Math.max(result, prevHigh2);
                }
            }
        }

        // Increment bar index for next call
        barIndex++;

        // Update tentative state
        state.currentResult = result;
        state.currentMaxMin = maxMin;
        state.currentAcceleration = acceleration;
        state.currentIsBelow = isBelow;
        state.currentBarIndex = barIndex;

        if (barIndex <= 1) {
            return NaN;
        }

        return context.precision(result);
    };
}
