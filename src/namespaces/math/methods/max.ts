// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

export function max(context: any) {
    return (...source: any[]) => {
        const args = source.map((e) => Series.val(e));
        return Math.max(...args);
    };
}

