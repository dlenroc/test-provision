import { expect } from 'vitest'
import { test } from '../helpers/watch.ts'

test('watch reruns replace resources but keep the shared service', { timeout: 120_000 }, async ({ watch }) => {
  const originalExitCode = process.exitCode

  const failed = await watch.runPhase('initial-failure')

  expect(failed).toEqual({ states: ['failed', 'failed'], errors: [] })
  expect(watch.events('create:initial-failure:')).toHaveLength(1)

  const second = await watch.runPhase('recovered')

  expect(second).toEqual({ states: ['passed', 'passed'], errors: [] })
  expect(watch.events('create:recovered:')).toHaveLength(2)

  const third = await watch.runPhase('updated')

  expect(third).toEqual({ states: ['passed', 'passed'], errors: [] })
  expect(watch.events('create:updated:')).toHaveLength(2)
  expect(watch.events('clean:').map(event => event.replace('clean:', 'create:')).toSorted())
    .toEqual(watch.events('create:').toSorted())

  await watch.close()

  expect(watch.events('service-')).toEqual(['service-start:', 'service-clean:'])
  expect(process.exitCode).toBe(originalExitCode)
})
