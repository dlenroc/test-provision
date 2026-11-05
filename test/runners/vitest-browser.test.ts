import { expect, test } from 'vitest'
import { runFixture } from '../helpers/external.ts'

test.skipIf(process.env.PROVISION_SKIP_BROWSER === '1')(
  'browser tests receive resources and runner services', { timeout: 120_000 }, () => {
    const events = runFixture('vitest', 'test/fixtures/vitest/vitest.config.ts', {
      PROVISION_TEST_BROWSER: '1',
    })

    expect(events.filter(event => event.type === 'service')).toEqual([
      { type: 'service', stage: 'start' },
      { type: 'service', stage: 'cleanup' },
    ])
    expect(events.flatMap(event => event.type === 'resource' && event.stage === 'create'
      ? [event.name] : []).toSorted()).toEqual(['Alice', 'Bob', 'Retry', 'Retry'])
    expect(events.filter(event => event.type === 'use').map(({ retry }) => retry).toSorted()).toEqual([0, 1])
  },
)
