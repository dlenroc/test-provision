import { collectRequirements } from "../core/contract.js";
import type { ResourceRequest } from "../core/types.js";

/**
 * Declare resources in Vitest test metadata using `needs()`.
 * Services do not require `needs()`.
 *
 * @example
 * ```ts
 * const alice = user('alice', { name: 'Alice' })
 * test('user', { meta: { provision: needs(alice) } }, ({ prepared }) => {
 *   expect(prepared(alice).name).toBe('Alice')
 * })
 * ```
 *
 * @throws
 * An {@link Error} if two requests use the same alias.
 */
export function needs<const Requests extends readonly ResourceRequest[]>(...requests: Requests) {
  collectRequirements(requests);
  return requests;
}
