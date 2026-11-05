import { test as base } from '@playwright/test'
import { needs, withResources } from '@dlenroc/test-provision/playwright'
import { user } from '../../helpers/contracts.js'

const test = withResources(base)
const account = user('account', { name: 'Crash' })

test('worker crashes after receiving a resource', { annotation: needs(account) }, async ({ prepared }) => {
  await prepared(account).markUsed(0)
  process.exit(42)
})
