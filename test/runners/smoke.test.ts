import { expect, test } from 'vitest'
import { runFixture } from '../helpers/external.ts'

for (const runner of ['playwright', 'vitest'] as const) {
  test(`${runner} shares services and isolates retries`, { timeout: 120_000 }, () => {
    const events = runFixture(runner)
    const resources = events.filter(event => event.type === 'resource')
    const created = resources.filter(event => event.stage === 'create')
    const cleaned = resources.filter(event => event.stage === 'cleanup')
    const used = events.filter(event => event.type === 'use')

    expect(events.filter(event => event.type === 'service')).toEqual([
      { type: 'service', stage: 'start' },
      { type: 'service', stage: 'cleanup' },
    ])
    expect(cleaned.map(({ name, id }) => [name, id]).toSorted()).toEqual(
      created.map(({ name, id }) => [name, id]).toSorted(),
    )
    expect(used.map(({ retry }) => retry).toSorted()).toEqual([0, 1])
    expect(used.map(({ id }) => id).toSorted()).toEqual(
      created.filter(event => event.name === 'Retry').map(({ id }) => id).toSorted(),
    )
    expect(new Set(used.map(({ id }) => id)).size).toBe(2)
    expect(created.filter(event => event.name === 'Skip')).toEqual([])
  })
}

test('Playwright CommonJS reporter accepts a CommonJS RpcTarget', { timeout: 120_000 }, () => {
  const events = runFixture('playwright', 'test/fixtures/playwright-cjs/playwright.config.cts')

  expect(events.map(event => event.type === 'flow' ? event.stage : '')).toEqual([
    'create:CjsCounter-1',
    'dispose:CjsCounter-1',
  ])
})
