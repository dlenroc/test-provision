import type { TestDetailsAnnotation } from "@playwright/test";
import { collectRequirements } from "../core/contract.js";
import type { Requirements, ResourceRequest } from "../core/types.js";

const TYPE = "_test-provision:needs";

/**
 * Declare resources in Playwright test options using `needs()`.
 * Inputs appear in test annotations; do not include secrets.
 * Services need no `needs()`.
 *
 * @example
 * ```ts
 * const alice = user('alice', { name: 'Alice' })
 * test('user', { annotation: needs(alice) }, async ({ prepared }) => {
 *   expect(prepared(alice).name).toBe('Alice')
 * })
 * ```
 *
 * @throws
 * An {@link Error} if two requests use the same alias.
 */
export function needs(...requests: ResourceRequest[]) {
  return { type: TYPE, description: JSON.stringify(collectRequirements(requests)) };
}

export function readRequirements(annotations: readonly TestDetailsAnnotation[]): Requirements {
  const entries = new Map<string, Requirements[string]>();
  for (const annotation of annotations) {
    if (annotation.type !== TYPE) continue;
    const next = JSON.parse(annotation.description!) as Requirements;
    for (const name of Object.keys(next)) {
      if (entries.has(name)) throw new Error(`Duplicate resource alias '${name}'`);
      entries.set(name, next[name]);
    }
  }
  return Object.fromEntries(entries);
}
