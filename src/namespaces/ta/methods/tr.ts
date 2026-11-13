// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';
import { Context } from '../../../Context.class';

export function tr(context: Context) {
    return (handle_na?: boolean, _callId?: string) => {
        // True Range calculation
        // TR = max(high - low, abs(high - close[1]), abs(low - close[1]))
        // handle_na: if true, returns high - low when close[1] is NaN (default behavior)
        //            if false, returns NaN when close[1] is NaN

        // Default to true to maintain backward compatibility with the getter behavior
        let handleNa = true;
        if (typeof handle_na === 'string') {
            _callId = handle_na;
        } else if (handle_na !== undefined) {
            handleNa = Series.val(handle_na);
        }
        //const handleNa = handle_na !== undefined ? Series.val(handle_na) : true;

        const high0 = context.get(context.data.high, 0);
        const low0 = context.get(context.data.low, 0);
        const close1 = context.get(context.data.close, 1);

        if (isNaN(close1)) {
            // If handle_na is true, return high - low, otherwise return NaN
            return handleNa ? context.precision(high0 - low0) : NaN;
        }

        const val = Math.max(high0 - low0, Math.abs(high0 - close1), Math.abs(low0 - close1));
        return context.precision(val);
    };
}
