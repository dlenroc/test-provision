import { expect, test } from 'vitest'
import { Demand } from '../../src/core/demand.js'
import type { Pool } from '../../src/core/allocation.js'

test('an active test takes surviving work before speculative forecasts', () => {
  let available = 1
  const account: Pool = {
    key: 'account',
    input: {},
    failure: { error: new Error('ACCOUNT_UNAVAILABLE') },
    creating: new Set(),
    ready: new Set(),
    get available() { return available },
  }
  const workspace: Pool = {
    key: 'workspace',
    input: {},
    creating: new Set(),
    ready: new Set(),
    get available() { return 0 },
  }
  const demand = new Demand()
  demand.register('forecast', new Map([['account', account], ['workspace', workspace]]))
  demand.register('running', new Map([['account', account]]))

  demand.inventoryChanged(account)
  demand.changes()

  expect([demand.count(account), demand.count(workspace)]).toEqual([1, 1])

  demand.activate('running', 0)
  demand.changes()

  expect([demand.count(account), demand.count(workspace)]).toEqual([1, 0])

  demand.finish('running')
  demand.changes()

  expect([demand.count(account), demand.count(workspace)]).toEqual([1, 1])

  available = 0
  demand.inventoryChanged(account)
  demand.changes()

  expect([demand.count(account), demand.count(workspace)]).toEqual([0, 0])
})

test('reconciling discovery removes stale forecasts and replaces changed requests', () => {
  const account: Pool = { key: 'account', input: {}, creating: new Set(), ready: new Set(), available: 0 }
  const workspace: Pool = { key: 'workspace', input: {}, creating: new Set(), ready: new Set(), available: 0 }
  const demand = new Demand()
  demand.register('first', new Map([['account', account]]))
  demand.register('filtered-out', new Map([['account', account]]))
  demand.changes()

  demand.reconcile(['first', 'filtered-out'], new Map([
    ['first', new Map([['workspace', workspace]])],
  ]))

  expect(demand.count(account)).toBe(0)
  expect(demand.count(workspace)).toBe(1)
  expect([...demand.changes()].toSorted((a, b) => a.key.localeCompare(b.key)))
    .toEqual([account, workspace])
})

test('an activated forecast is not replaced by later collection telemetry', () => {
  const account: Pool = { key: 'account', input: {}, creating: new Set(), ready: new Set(), available: 0 }
  const workspace: Pool = { key: 'workspace', input: {}, creating: new Set(), ready: new Set(), available: 0 }
  const requirements = new Map([['user', account]])
  const demand = new Demand()
  demand.register('first', requirements)
  demand.activate('first', 0)

  demand.reconcile(['first'], new Map([['first', new Map([['space', workspace]])]]))

  expect(demand.starting(account)).toBe(1)
  expect(demand.count(workspace)).toBe(0)

  demand.open('first', 0, requirements)

  expect(demand.count(account)).toBe(0)
  expect(() => demand.open('first', 0, requirements)).toThrow(/Duplicate resource allocation/)
})

test('retry forecasts represent only unopened attempts and stop at shutdown', () => {
  const account: Pool = { key: 'account', input: {}, creating: new Set(), ready: new Set(), available: 0 }
  const requirements = new Map([['user', account]])
  const demand = new Demand()
  demand.register('flaky', requirements)
  demand.open('flaky', 0, requirements)

  demand.retry('flaky', 1)
  demand.retry('flaky', 1)
  expect(demand.count(account)).toBe(1)

  demand.activate('flaky', 1)
  expect(demand.starting(account)).toBe(1)

  demand.open('flaky', 1, requirements)
  expect([demand.count(account), demand.starting(account)]).toEqual([0, 0])

  demand.stop()
  demand.retry('flaky', 2)
  demand.register('new-test', requirements)
  expect(demand.count(account)).toBe(0)
})

test('a failed provider cannot satisfy multiple aliases with one available instance', () => {
  const account: Pool = {
    key: 'account', input: {}, failure: { error: new Error('UNAVAILABLE') },
    creating: new Set(), ready: new Set(), available: 1,
  }
  const demand = new Demand()
  demand.register('two-accounts', new Map([['first', account], ['second', account]]))
  demand.inventoryChanged(account)
  demand.changes()

  expect(demand.count(account)).toBe(0)
})
