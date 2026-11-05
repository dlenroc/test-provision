import { expect, test, vi } from 'vitest'
import { resource, service } from '../../src/core/contract.js'
import type { RpcStub } from 'capnweb'
import { collectRequirements } from '../../src/core/contract.js'
import { PreparedScope } from '../../src/core/prepared.js'
import type { ProvisionEndpoint } from '../../src/core/server.js'

test('prepared resources can be read by request or alias', () => {
  const account = resource<{}, { id: number }>('account')
  const request = account('user', {})
  using scope = new PreparedScope(
    { user: { id: 42 } },
    collectRequirements([request]),
    () => { throw new Error('Unexpected service access') },
  )

  expect(scope.prepared(request)).toEqual({ id: 42 })
  expect(scope.prepared(account, 'user')).toEqual({ id: 42 })
})

test('prepared resources reject incorrect aliases and types', () => {
  const account = resource<{}, number>('account')
  const workspace = resource<{}, number>('workspace')
  using scope = new PreparedScope(
    { user: 42 },
    collectRequirements([account('user', {})]),
    () => { throw new Error('Unexpected service access') },
  )

  expect(() => scope.prepared(account, '')).toThrow(/nonempty alias/)
  expect(() => scope.prepared(account, 'missing')).toThrow("Resource 'missing' was not declared")
  expect(() => scope.prepared(workspace, 'user')).toThrow("Resource 'user' has type 'account'")
})

test('declared resources must have a prepared value', () => {
  const account = resource<{}, number>('account')
  using scope = new PreparedScope(
    {},
    collectRequirements([account('user', {})]),
    () => { throw new Error('Unexpected service access') },
  )

  expect(() => scope.prepared(account, 'user')).toThrow("Declared resource 'user' was not returned")
})

test('shared service handles are disposed once with their scope', () => {
  const accounts = service<{ ping(): string }>('accounts')
  const handle = { ping: () => 'pong', [Symbol.dispose]: vi.fn() }
  const getService = vi.fn(() => handle)
  const connect = vi.fn(() => ({ getService }) as unknown as RpcStub<ProvisionEndpoint>)
  const scope = new PreparedScope({}, {}, connect)

  const shared = scope.prepared(accounts)

  expect(shared).toBe(handle)
  expect(getService).toHaveBeenCalledWith('accounts')
  expect(connect).toHaveBeenCalledOnce()

  scope[Symbol.dispose]()
  scope[Symbol.dispose]()

  expect(handle[Symbol.dispose]).toHaveBeenCalledOnce()
  expect(() => scope.prepared(accounts)).toThrow('Prepared scope has been released')
})

test('prepared resources are inaccessible after their scope is disposed', () => {
  const account = resource<{}, number>('account')
  const scope = new PreparedScope(
    { user: 42 },
    collectRequirements([account('user', {})]),
    () => { throw new Error('Unexpected service access') },
  )

  scope[Symbol.dispose]()

  expect(() => scope.prepared(account, 'user')).toThrow('Prepared scope has been released')
})
