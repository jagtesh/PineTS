// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

/**
 * MACD - Moving Average Convergence Divergence
 *
 * MACD is a trend-following momentum indicator that shows the relationship between
 * two moving averages of a security's price.
 *
 * Formula:
 * - MACD Line = EMA(source, fastLength) - EMA(source, slowLength)
 * - Signal Line = EMA(MACD Line, signalLength)
 * - Histogram = MACD Line - Signal Line
 *
 * @param source - The data source (typically close price)
 * @param fastLength - The short period (default 12)
 * @param slowLength - The long period (default 26)
 * @param signalLength - The signal period (default 9)
 * @returns [macdLine, signalLine, histLine]
 */
export function macd(context: any) {
    return (source: any, _fastLength: any, _slowLength: any, _signalLength: any, _callId?: string) => {
        const fastLength = Series.val(_fastLength);
        const slowLength = Series.val(_slowLength);
        const signalLength = Series.val(_signalLength);

        // Generate unique IDs for internal EMAs
        // If _callId is provided, derive IDs from it.
        // Otherwise, generate a base ID based on parameters (standard behavior),
        // but this might be risky if multiple MACDs have same params.
        // However, the caller (transpiler) typically provides _callId for the main call.

        const baseId = _callId || `macd_${fastLength}_${slowLength}_${signalLength}`;

        const fastEmaId = `${baseId}_fast`;
        const slowEmaId = `${baseId}_slow`;
        const signalEmaId = `${baseId}_signal`;

        // Calculate Fast and Slow EMAs
        // context.pine.ta.ema returns the current EMA value
        const fastMA = context.pine.ta.ema(source, fastLength, fastEmaId);
        const slowMA = context.pine.ta.ema(source, slowLength, slowEmaId);

        // Calculate MACD Line
        // Handle NaN cases if EMAs are not yet valid
        let macdLine = NaN;
        if (!isNaN(fastMA) && !isNaN(slowMA)) {
            macdLine = fastMA - slowMA;
        }

        // Calculate Signal Line
        // We pass the current macdLine value to the EMA function.
        // The EMA function maintains state (prevEMA), so passing the current scalar is sufficient.
        // We must ensure we don't pass NaN to EMA, as it might corrupt the state (initSum).
        let signalLine = NaN;
        if (!isNaN(macdLine)) {
            signalLine = context.pine.ta.ema(macdLine, signalLength, signalEmaId);
        }

        // Calculate Histogram
        let histLine = NaN;
        if (!isNaN(macdLine) && !isNaN(signalLine)) {
            histLine = macdLine - signalLine;
        }

        return [[context.precision(macdLine), context.precision(signalLine), context.precision(histLine)]];
    };
}
