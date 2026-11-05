import { provider, resource, service, type Prepared } from '../../src/index.js'
import { expectTypeOf, test } from 'vitest'
import type { TestRun } from '../helpers/scenario.js'

const account = resource<{ name: string }, { name: string }>('account')
const counter = service<{ next(): number }>('counter')

test('the scenario harness retains planned test IDs and contract types', () => {
  const run = null! as TestRun<'first' | 'second'>

  expectTypeOf(run.service(counter)).toEqualTypeOf<Prepared<typeof counter>>()
  expectTypeOf(run.startTest('first').resource(account, 'alice'))
    .toEqualTypeOf<Promise<Prepared<typeof account>>>()
  // @ts-expect-error Only planned test IDs can start.
  run.startTest('missing')
})
