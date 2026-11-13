// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';

export function param(context: any) {
    return (source: any, index: number = 0) => {
        // Series.val avoids allocating a Series for a primitive in the common index-0 case.
        return index ? Series.from(source).get(index) : Series.val(source);
    };
}

