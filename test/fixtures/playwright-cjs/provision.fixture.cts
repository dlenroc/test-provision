import { test as base, expect } from '@playwright/test'
import { withResources, needs } from '@dlenroc/test-provision/playwright'
import { counter } from './provider.cjs'
const test = withResources(base)

test('CommonJS provider returns RpcTarget', {
  annotation: needs(counter('one', {})),
}, async ({ prepared }) => {
  const one = prepared(counter, 'one')
  expect(await one.next()).toBe(1)
})
