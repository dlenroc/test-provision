import { provider, resource, service, type Prepared } from '@dlenroc/test-provision'
import { provision as vitestProvision } from '@dlenroc/test-provision/vitest/plugin'
import { provision as playwrightProvision } from '@dlenroc/test-provision/playwright/reporter'
import { needs as vitestNeeds, withResources as vitestFixtures } from '@dlenroc/test-provision/vitest'
import { needs as playwrightNeeds, withResources as playwrightFixtures } from '@dlenroc/test-provision/playwright'
import { RpcPromise, RpcStub, RpcTarget } from 'capnweb'
import { expectTypeOf, test, test as vitest } from 'vitest'
import { test as playwright } from '@playwright/test'

class Counter extends RpcTarget { next() { return 1 } }
const account = resource<{ name: string }, { name: string; counter: Counter }>('account')
const counter = service<Counter>('counter')
const greet = service<(name: string) => string>('greet')
const alice = account('alice', { name: 'Alice' })

test('resource and service results retain their types', () => {
  expectTypeOf<Prepared<typeof account>>().toEqualTypeOf<{
    name: string; counter: RpcStub<Counter>
  }>()
  expectTypeOf<Prepared<typeof counter>>().toEqualTypeOf<RpcPromise<Counter>>()
  expectTypeOf<Prepared<typeof greet>>().toEqualTypeOf<RpcPromise<(name: string) => string>>()
  expectTypeOf<Prepared<typeof alice>>().toEqualTypeOf<Prepared<typeof account>>()
})

test('providers enforce inputs, results, and dependencies', () => {
  const accountProvider = provider(account, async (input, { signal, onCleanup, getService }) => {
    const name: string = input.name
    // @ts-expect-error Provider inputs are readonly.
    input.name = 'changed'
    signal.throwIfAborted()
    onCleanup(async () => {})
    const shared: Counter = await getService(counter)
    // @ts-expect-error Resources cannot be used as service dependencies.
    await getService(account)
    return { name, counter: shared }
  })
  const counterProvider = provider(counter, async ({ getService, onCleanup }) => {
    const other = await getService(greet)
    const greeting: string = other('Ada')
    onCleanup(() => greeting)
    return new Counter()
  })
  provider(greet, () => name => `Hello ${name}`)

  vitestProvision({ providers: [accountProvider, counterProvider] })
  playwrightProvision({ providers: [accountProvider, counterProvider] })

  // @ts-expect-error Resource inputs must be JSON-safe.
  resource<{ date: Date }, string>('invalid-input')
  // @ts-expect-error Resource requests require an input.
  account('missing')
  // @ts-expect-error Providers must return the declared result.
  provider(account, () => ({ name: 42, counter: new Counter() }))
  // @ts-expect-error Provider concurrency does not apply to services.
  provider(counter, { concurrency: 1 }, () => new Counter())
})

test('Playwright and Vitest fixtures enforce prepared values', () => {
  const requests = vitestNeeds(alice)
  playwrightNeeds(...requests)
  // @ts-expect-error needs() requires requests, not declarations.
  playwrightNeeds(account)
  // @ts-expect-error needs() cannot accept services.
  vitestNeeds(counter)

  const vt = vitestFixtures(vitest, { timeout: 1000 })
  const pw = playwrightFixtures(playwright, { timeout: 1000 })
  vt('prepared types', { meta: { provision: requests } }, async ({ prepared }) => {
    const value: string = prepared(alice).name
    const count: number = await prepared(counter).next()
    const greeting: string = await prepared(greet)('Ada')
    // @ts-expect-error Raw resources require an alias.
    prepared(account)
    // @ts-expect-error Requests already carry their alias.
    prepared(alice, 'other')
    void [value, count, greeting]
  })
  pw('prepared types', { annotation: playwrightNeeds(alice) }, async ({ prepared }) => {
    const value: string = prepared(account, 'alice').name
    const count: number = await prepared(counter).next()
    void [value, count]
  })

  // @ts-expect-error Fixture timeouts are numeric.
  vitestFixtures(vitest, { timeout: 'slow' })
  // @ts-expect-error Fixture timeouts are numeric.
  playwrightFixtures(playwright, { timeout: 'slow' })
})
