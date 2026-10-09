// Whether a hook applies to a given chat/message (spec/20-hooks.md § Gate):
// the structural axes (`hookGateMatches`, `@patch/wire/hooks`) plus the
// optional JSONata `filter`, evaluated the same way a job's filter is
// (`../jobs/filter.ts`).

import { evaluateFilter, filterContext, FilterError } from '../jobs/filter.js';
import { hookGateMatches, type Hook, type HookCheckContext } from './types.js';

/**
 * True when `hook` applies to `ctx`. A bad `filter` is logged by the caller
 * and treated as NOT matching (fail-closed, same reasoning a job's bad filter
 * gets — never silently run a hook whose condition could not be evaluated).
 */
export async function hookMatches(
  hook: Hook,
  ctx: HookCheckContext,
  nowMs: number,
  onFilterError?: (err: FilterError) => void,
): Promise<boolean> {
  if (!hook.enabled) return false;
  if (!hookGateMatches(hook.gate, ctx)) return false;
  const filter = hook.gate.filter;
  if (filter === null || filter === undefined || filter.trim() === '') return true;
  try {
    return await evaluateFilter(filter, filterContext(nowMs, ctx));
  } catch (err) {
    if (err instanceof FilterError) {
      onFilterError?.(err);
      return false;
    }
    throw err;
  }
}
