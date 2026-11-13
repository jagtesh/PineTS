// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

export function mom(context: any) {
    return (source: any, _length: any, _callId?: string) => {
        const length = Series.val(_length);

        // Momentum is same as change
        return context.pine.ta.change(source, length, _callId);
    };
}
