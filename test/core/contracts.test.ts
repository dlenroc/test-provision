import { expect, test } from 'vitest'
import { provider, resource, service } from '../../src/index.js'
import { needs } from '../../src/playwright/needs.js'
import { splitProviders } from '../../src/core/provider.js'

test('requests snapshot their inputs', () => {
  const account = resource<{ name: string; roles: string[] }, {}>('account')
  const input = { name: 'Alice', roles: ['admin'] }

  const request = account('user', input)
  input.roles.push('viewer')

  expect(request).toEqual({
    key: 'account',
    alias: 'user',
    input: { name: 'Alice', roles: ['admin'] },
  })
})

test('resource and service providers can share a key', () => {
  const account = resource<{}, {}>('shared')
  const accounts = service<{}>('shared')

  const providers = [provider(account, () => ({})), provider(accounts, () => ({}))]

  expect(() => splitProviders(providers)).not.toThrow()
})

test('resource requests reject duplicate aliases', () => {
  const account = resource<{ name: string }, {}>('account')
  const alice = account('user', { name: 'Alice' })
  const bob = account('user', { name: 'Bob' })

  expect(() => needs(alice, bob)).toThrow(/Duplicate resource alias/)
})

test('resource requests require an alias', () => {
  const account = resource<{ name: string }, {}>('account')

  expect(() => account('', { name: 'Alice' })).toThrow(/nonempty alias/)
})

test('providers reject duplicate keys', () => {
  const accounts = service<{}>('accounts')
  const first = provider(accounts, () => ({}))
  const second = provider(accounts, () => ({}))

  expect(() => splitProviders([first, second])).toThrow(/Duplicate provider/)
})
