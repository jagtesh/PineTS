// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';
import { nonNaWindow } from '../utils/nonNaWindow';

export function sma(context: any) {
    return (source: any, _period: any, _callId?: string) => {
        const period = Series.val(_period);
        const series = Series.from(source);

        // Mean of the last `period` non-na values (na values are skipped, as on TradingView).
        const window = nonNaWindow(context, _callId || `sma_${period}`, series, period);
        if (!window) return NaN;

        return context.precision(window.sum / period);
    };
}
