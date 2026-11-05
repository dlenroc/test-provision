import { expect, test as base } from '@playwright/test'
import { needs, withResources } from '@dlenroc/test-provision/playwright'
import { cleanupAccount } from './contracts.js'
import { mark } from '../../helpers/trace.js'

const test = withResources(base)

test('uses a resource', {
  annotation: needs(cleanupAccount('account', {})),
}, async ({ prepared }) => {
  expect(prepared(cleanupAccount, 'account')).toBe('ready')
  mark('first-test:ran')
})

test('starts without awaiting previous cleanup', async () => {
  mark('next-test:ran')
})
