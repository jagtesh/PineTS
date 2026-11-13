// SPDX-License-Identifier: AGPL-3.0-only
// stream().notify(): a host that is pushed its data wakes the stream instead of waiting for the
// poll. Uses an in-memory provider so the timings depend on nothing but the stream loop.

import { describe, expect, it } from 'vitest';
import PineTS from 'PineTS.class';

const HOUR = 3_600_000;

/** A provider over a mutable in-memory bar list; the last bar is still forming. */
function pushedProvider(count: number) {
    const start = Date.now() - (count - 1) * HOUR;
    const bars = Array.from({ length: count }, (_, i) => {
        const openTime = start + i * HOUR;
        const close = 100 + i;
        return { openTime, closeTime: openTime + HOUR - 1, open: close, high: close + 1, low: close - 1, close, volume: 10 };
    });
    let polls = 0;
    return {
        bars,
        polls: () => polls,
        tick(close: number) {
            const last = bars[bars.length - 1];
            last.close = close;
            last.high = Math.max(last.high, close);
        },
        getMarketData: async (_t: string, _tf: string, _limit?: number, sDate?: number) => {
            if (sDate == null) return bars.map((b) => ({ ...b }));
            polls++;
            return bars.filter((b) => b.openTime >= sDate).map((b) => ({ ...b }));
        },
        getSymbolInfo: async () => ({ ticker: 'TEST', tickerid: 'TEST', mintick: 0.01, timezone: 'Etc/UTC' }),
    };
}

const script = `//@version=6
indicator("t")
plot(close, "c")`;

const lastClose = (ctx: any) => {
    const data = ctx.plots['c'].data;
    return data[data.length - 1].value;
};

/** Resolves with the first emission for which `pred` holds. */
function nextData(evt: any, pred: (ctx: any) => boolean, timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no matching emission within ${timeoutMs} ms`)), timeoutMs);
        evt.on('data', (ctx: any) => {
            if (pred(ctx)) {
                clearTimeout(timer);
                resolve(Date.now());
            }
        });
        evt.on('error', reject);
    });
}

describe('stream().notify()', () => {
    it('delivers a forming-bar update right after notify, not after the poll interval', async () => {
        const provider = pushedProvider(50);
        const pine = new PineTS(provider as any, 'TEST', '60', 50);
        const evt = pine.stream(script, { live: true, interval: 1000, pageSize: 50 });
        try {
            await nextData(evt, () => true, 3000); // history drained

            const latencies: number[] = [];
            for (const close of [201, 202, 203, 204]) {
                // land the tick at an arbitrary point inside the stream's wait
                await new Promise((r) => setTimeout(r, 60));
                const seen = nextData(evt, (ctx) => lastClose(ctx) === close, 3000);
                const at = Date.now();
                provider.tick(close);
                evt.notify();
                latencies.push((await seen) - at);
            }
            // Unnotified, each of these waits out the 1 s interval and then the 1 s
            // forming-candle throttle. Notified, only the re-execution remains.
            for (const ms of latencies) expect(ms).toBeLessThan(250);
        } finally {
            evt.stop();
        }
    });

    it('coalesces a burst of notifies and still ends on the newest value', async () => {
        const provider = pushedProvider(30);
        const pine = new PineTS(provider as any, 'TEST', '60', 30);
        const evt = pine.stream(script, { live: true, interval: 1000, pageSize: 30 });
        try {
            await nextData(evt, () => true, 3000);
            const pollsBefore = provider.polls();
            const seen = nextData(evt, (ctx) => lastClose(ctx) === 310, 3000);
            const at = Date.now();
            for (let c = 301; c <= 310; c++) {
                provider.tick(c);
                evt.notify();
            }
            expect((await seen) - at).toBeLessThan(400);
            // ten notifies in one turn of the event loop must not mean ten polls
            expect(provider.polls() - pollsBefore).toBeLessThanOrEqual(3);
        } finally {
            evt.stop();
        }
    });

    it('still picks up changes by polling when notify is never called', async () => {
        const provider = pushedProvider(30);
        const pine = new PineTS(provider as any, 'TEST', '60', 30);
        const evt = pine.stream(script, { live: true, interval: 200, pageSize: 30 });
        try {
            await nextData(evt, () => true, 3000);
            const seen = nextData(evt, (ctx) => lastClose(ctx) === 500, 5000);
            const at = Date.now();
            provider.tick(500);
            const waited = (await seen) - at;
            expect(waited).toBeGreaterThanOrEqual(150); // the poll + throttle path, unchanged
        } finally {
            evt.stop();
        }
    });
});
