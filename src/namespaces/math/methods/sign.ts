// SPDX-License-Identifier: AGPL-3.0-only

import { Series } from '../../../Series';
import { Context } from '../../../Context.class';

export function sign(context: Context) {
    return (source: any) => {
        return Math.sign(Series.val(source));
    };
}
