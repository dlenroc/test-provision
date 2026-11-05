import { expect, test as base } from '@playwright/test'
import { needs, withResources } from '@dlenroc/test-provision/playwright'
import { teardownAccount } from './contracts.js'
import { mark } from '../../helpers/trace.js'

const test = withResources(base)

test('teardown project provisions only after its dependent project finishes', {
  annotation: needs(teardownAccount('account', {})),
}, async ({ prepared }) => {
  expect(prepared(teardownAccount, 'account')).toBe('ready')
  mark('teardown:ran')
})
