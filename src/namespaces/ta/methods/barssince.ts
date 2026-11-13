// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * Bars Since
 *
 * Counts the number of bars since the last time the condition was true.
 */
export function barssince(context: any) {
    return (condition: any, _callId?: string) => {
        if (!context.taState) context.taState = {};
        const stateKey = _callId || 'barssince';

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevLastTrueIndex: null,
                // Tentative state
                currentLastTrueIndex: null,
            };
        }
        const state = context.taState[stateKey];

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevLastTrueIndex = state.currentLastTrueIndex;
            }
            state.lastIdx = context.idx;
        }

        const cond = Series.val(condition);

        // Use committed previous last true index as base
        let lastTrueIndex = state.prevLastTrueIndex;

        if (cond) {
            lastTrueIndex = context.idx;
        }

        // Update tentative state
        state.currentLastTrueIndex = lastTrueIndex;

        if (lastTrueIndex === null) {
            return NaN;
        }

        return context.idx - lastTrueIndex;
    };
}
