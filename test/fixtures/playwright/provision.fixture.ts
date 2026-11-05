import { expect, test as base } from '@playwright/test'
import { needs, withResources } from '@dlenroc/test-provision/playwright'
import { counter, user } from '../../helpers/contracts.js'

const test = withResources(base)
const alice = user('alice', { name: 'Alice' })

test('uses an isolated account and shared counter', {
  annotation: needs(alice),
}, async ({ prepared }) => {
  const account = prepared(alice)

  expect(account.name).toBe('Alice')
  expect(await account.greet('Ada')).toBe('Hello Ada')
  expect(await prepared(counter).next()).toBeGreaterThan(0)
})

test('uses a shared service without declaring a resource', async ({ prepared }) => {
  const next = await prepared(counter).next()

  expect(next).toBeGreaterThan(0)
})

test('retry receives a fresh account', {
  annotation: needs(user('account', { name: 'Retry' })),
}, async ({ prepared }, info) => {
  const account = prepared(user, 'account')

  expect(account.name).toBe('Retry')

  await account.markUsed(info.retry)
  if (info.retry === 0) throw new Error('EXPECTED_FIRST_ATTEMPT')
})

test.skip('skipped tests do not create accounts', {
  annotation: needs(user('unused', { name: 'Skip' })),
}, () => { throw new Error('SKIPPED_TEST_RAN') })
