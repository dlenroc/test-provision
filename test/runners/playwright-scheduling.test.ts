import { expect, test } from 'vitest'
import { runFixture } from '../helpers/external.js'

test('Playwright projects defer provisioning and workers proceed during preparation and cleanup', { timeout: 120_000 }, () => {
  const events = runFixture('playwright', 'test/fixtures/playwright-flow/playwright.config.ts')
  const stages = events.flatMap(event => event.type === 'flow' ? [event.stage] : [])

  expect(stages.filter(stage =>
    ['prerequisite:ran', 'independent:ran', 'dependent:ran'].includes(stage) || stage.startsWith('prepare:'),
  )).toEqual(['prerequisite:ran', 'prepare:started', 'independent:ran', 'prepare:finished', 'dependent:ran'])

  expect(stages.filter(stage => ['first-test:ran', 'next-test:ran', 'cleanup:finished'].includes(stage)))
    .toEqual(['first-test:ran', 'next-test:ran', 'cleanup:finished'])

  // The dependent tests run concurrently; their relative completion order is not guaranteed.
  const teardownStart = stages.indexOf('teardown:prepare')
  expect(teardownStart).toBeGreaterThan(-1)
  expect(stages.indexOf('dependent:ran')).toBeGreaterThan(-1)
  expect(stages.indexOf('cleanup:finished')).toBeGreaterThan(-1)
  expect(teardownStart).toBeGreaterThan(stages.indexOf('dependent:ran'))
  expect(teardownStart).toBeGreaterThan(stages.indexOf('cleanup:finished'))
  expect(stages.slice(teardownStart).filter(stage => stage.startsWith('teardown:')))
    .toEqual(['teardown:prepare', 'teardown:ran', 'teardown:cleanup'])
})
