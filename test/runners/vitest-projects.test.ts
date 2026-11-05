import { expect, test } from 'vitest'
import { runFixture } from '../helpers/external.js'

test('Vitest projects isolate resources but share the runner service', { timeout: 120_000 }, () => {
  const events = runFixture('vitest', 'test/fixtures/vitest-projects/vitest.config.ts')
  const resources = events.filter(event => event.type === 'resource')
  const created = resources.filter(event => event.stage === 'create')
  const cleaned = resources.filter(event => event.stage === 'cleanup')

  expect(events.filter(event => event.type === 'service')).toEqual([
    { type: 'service', stage: 'start' },
    { type: 'service', stage: 'cleanup' },
  ])
  expect(created).toHaveLength(2)
  expect(new Set(created.map(event => event.id)).size).toBe(2)
  expect(cleaned.map(event => event.id).toSorted()).toEqual(created.map(event => event.id).toSorted())
})
