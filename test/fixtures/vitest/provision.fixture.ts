import { expect, test as base } from 'vitest'
import { needs, withResources } from '@dlenroc/test-provision/vitest'
import { counter, user } from '../../helpers/contracts.js'

const test = withResources(base)
const alice = user('alice', { name: 'Alice' })

test('uses isolated accounts and a shared service', {
  meta: { provision: needs(alice, user('bob', { name: 'Bob' })) },
}, async ({ prepared }) => {
  const first = prepared(alice)
  const second = prepared(user, 'bob')

  expect([first.name, second.name]).toEqual(['Alice', 'Bob'])
  expect(first.id).not.toBe(second.id)
  expect(await first.greet('Ada')).toBe('Hello Ada')
  expect(await prepared(counter).next()).toBeGreaterThan(2)
})

test('uses a shared service without declaring a resource', async ({ prepared }) => {
  const next = await prepared(counter).next()

  expect(next).toBeGreaterThan(0)
})

test('retry receives a fresh account', {
  retry: 1,
  meta: { provision: needs(user('account', { name: 'Retry' })) },
}, async ({ prepared, task }) => {
  const account = prepared(user, 'account')
  const retry = task.result?.retryCount ?? 0

  expect(account.name).toBe('Retry')

  await account.markUsed(retry)
  if (retry === 0) throw new Error('EXPECTED_FIRST_ATTEMPT')
})

test.skip('skipped tests do not create accounts', {
  meta: { provision: needs(user('unused', { name: 'Skip' })) },
}, () => { throw new Error('SKIPPED_TEST_RAN') })
