import { expect, test as base } from '@playwright/test'
import { needs, withResources } from '@dlenroc/test-provision/playwright'
import { slowAccount } from './contracts.js'
import { mark } from '../../helpers/trace.js'

const test = withResources(base)

test('uses the prepared account', {
  annotation: needs(slowAccount('account', {})),
}, async ({ prepared }) => {
  expect(prepared(slowAccount, 'account')).toBe('ready')
  mark('dependent:ran')
})
