import { expect, test } from 'vitest'
import { runFixture } from '../helpers/external.js'

const lifecycleFixture = 'test/fixtures/vitest-lifecycle/vitest.config.ts'

test('Vitest releases timed-out attempts and respects retry conditions', { timeout: 120_000 }, () => {
  const events = runFixture('vitest', lifecycleFixture)

  expect(events.filter(event => event.type === 'flow' &&
    /^(timeout|recover):/.test(event.stage))).toEqual([
    { type: 'flow', stage: 'timeout:start:1' },
    { type: 'flow', stage: 'timeout:cancel:1' },
    { type: 'flow', stage: 'timeout:cleanup:1' },
    { type: 'flow', stage: 'recover:start:1' },
    { type: 'flow', stage: 'recover:cancel:1' },
    { type: 'flow', stage: 'recover:cleanup:1' },
    { type: 'flow', stage: 'recover:start:2' },
    { type: 'flow', stage: 'recover:test:1' },
    { type: 'flow', stage: 'recover:cleanup:2' },
  ])
  expect(events.filter(event => event.type === 'flow' &&
    /^(conditional|expected):/.test(event.stage))).toEqual([
    { type: 'flow', stage: 'conditional:start:1' },
    { type: 'flow', stage: 'conditional:test:0' },
    { type: 'flow', stage: 'conditional:cleanup:1' },
    { type: 'flow', stage: 'conditional:start:2' },
    { type: 'flow', stage: 'conditional:test:1' },
    { type: 'flow', stage: 'conditional:cleanup:2' },
    { type: 'flow', stage: 'expected:start:1' },
    { type: 'flow', stage: 'expected:cleanup:1' },
  ])
  expect(events.filter(event => event.type === 'flow' && event.stage.startsWith('repeat:'))).toEqual([
    { type: 'flow', stage: 'repeat:start:1' },
    { type: 'flow', stage: 'repeat:test:1' },
    { type: 'flow', stage: 'repeat:cleanup:1' },
    { type: 'flow', stage: 'repeat:start:2' },
    { type: 'flow', stage: 'repeat:test:2' },
    { type: 'flow', stage: 'repeat:cleanup:2' },
  ])
})
