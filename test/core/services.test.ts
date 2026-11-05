import { expect, vi } from 'vitest'
import { RpcTarget } from 'capnweb'
import { provider, resource, service } from '../../src/index.js'
import { test } from '../helpers/scenario.ts'
import { deferred, gate, nextTurn, withTimeout } from '../helpers/sync.ts'

test('RPC clients share a single service instance', async ({ scenario }) => {
  const counter = service<Counter>('counter')
  const initialized = deferred()
  using finishInitialization = gate()

  class Counter extends RpcTarget {
    #value = 0
    next() { return ++this.#value }
  }

  const run = await scenario.launch({
    providers: [provider(counter, async ({ onCleanup }) => {
      scenario.log('init')
      onCleanup(() => scenario.log('dispose'))
      initialized.resolve()
      await finishInitialization.promise
      return new Counter()
    })],
  })

  const anotherClient = run.connect()
  const first = run.service(counter)
  const second = anotherClient.service(counter)
  const calls = [first.next(), second.next()]

  expect(run.events).toEqual([])

  await initialized.promise

  expect(run.events).toEqual(['init'])

  finishInitialization.release()

  expect((await Promise.all(calls)).toSorted()).toEqual([1, 2])

  await run.finishTests()

  expect(await run.service(counter).next()).toBe(3)

  await run.stop()

  expect(run.events).toEqual(['init', 'dispose'])
})

test('a failed service initializes and cleans up only once', async ({ scenario }) => {
  const counter = service<{ next(): number }>('counter')
  const run = await scenario.launch({
    providers: [provider(counter, ({ onCleanup }) => {
      scenario.log('init')
      onCleanup(async () => { await nextTurn(); scenario.log('dispose') })
      throw new Error('START_FAILED')
    })],
  })

  const client = run.connect()
  const requests = [run.service(counter), client.service(counter), run.service(counter)]
  await Promise.all(requests.map(value => expect(Promise.resolve(value.next())).rejects.toThrow(/START_FAILED/)))
  await run.stop()

  expect(run.events).toEqual(['init', 'dispose'])
})

test('resource cleanup precedes its shared service dependencies', async ({ scenario }) => {
  const counter = service<{ next(): number }>('counter')
  const accounts = service<{ create(name: string): { id: number; name: string } }>('accounts')
  const account = resource<{ name: string }, { id: number; name: string }>('account')
  let nextId = 0
  const run = await scenario.launch({
    providers: [
      provider(counter, ({ onCleanup }) => {
        onCleanup(() => scenario.log('counter'))
        return { next: () => ++nextId }
      }),
      provider(accounts, async ({ getService, onCleanup }) => {
        const shared = await getService(counter)
        onCleanup(() => { shared.next(); scenario.log('accounts') })
        return { create: (name: string) => ({ id: shared.next(), name }) }
      }),
      provider(account, async ({ name }, { getService, onCleanup }) => {
        const client = await getService(accounts)
        onCleanup(() => scenario.log(`account:${name}`))
        return client.create(name)
      }),
    ],
    tests: {
      first: [account('alice', { name: 'Alice' })],
      next: [account('bob', { name: 'Bob' })],
    },
  })

  const first = run.startTest('first')
  const next = run.startTest('next')
  const accountsReady = await Promise.all([first.resources(), next.resources()])

  expect(accountsReady).toMatchObject([
    { alice: { name: 'Alice' } },
    { bob: { name: 'Bob' } },
  ])
  expect(await run.service(counter).next()).toBe(3)

  await Promise.all([first.release(), next.release()])
  await run.stop()

  expect(run.events.slice(0, 2).toSorted()).toEqual(['account:Alice', 'account:Bob'])
  expect(run.events.slice(2)).toEqual(['accounts', 'counter'])
})

test('circular service dependencies fail without deadlock', async ({ scenario }) => {
  const first = service<{}>('first')
  const second = service<{}>('second')
  const self = service<{}>('self')
  const bothStarted = deferred()
  let started = 0
  const rendezvous = async () => {
    if (++started === 2) bothStarted.resolve()
    await bothStarted.promise
  }
  const run = await scenario.launch({
    providers: [
      provider(first, async ({ getService }) => {
        await rendezvous()
        return getService(second)
      }),
      provider(second, async ({ getService }) => {
        await rendezvous()
        return getService(first)
      }),
      provider(self, ({ getService }) => getService(self)),
    ],
  })

  const result = await Promise.allSettled([run.resolveService(first), run.resolveService(second)])

  expect(result).toMatchObject([
    { status: 'rejected', reason: { message: expect.stringMatching(/Circular service dependency/) } },
    { status: 'rejected', reason: { message: expect.stringMatching(/Circular service dependency/) } },
  ])
  await expect(run.resolveService(self)).rejects.toThrow(/Circular service dependency/)
  await expect(run.resolveService(first)).rejects.toThrow(/Circular service dependency/)
})

test('shutdown aborts initialization and executes service cleanup', async ({ scenario }) => {
  const counter = service<{ next(): number }>('counter')
  const unused = service<{}>('unused')
  const started = deferred()
  const run = await scenario.launch({
    providers: [
      provider(counter, async ({ signal, onCleanup }) => {
        scenario.log('init')
        onCleanup(() => scenario.log('early'))
        started.resolve()
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
        onCleanup(() => scenario.log('late'))
        return { next: () => 1 }
      }),
      provider(unused, () => { throw new Error('UNUSED_SERVICE_STARTED') }),
    ],
  })

  const pending = expect(Promise.resolve(run.service(counter).next()))
    .rejects.toThrow(/Service runner shutting down/)
  await started.promise
  await Promise.all([run.closeServices(), run.closeServices()])
  await pending
  await run.stop()

  expect(run.events).toEqual(['init', 'late', 'early'])
})

test('service shutdown stays bounded when initialization ignores cancellation', async ({ scenario }) => {
  const serviceValue = service<{ read(): string }>('slow-service')
  const started = deferred()
  const cleaned = deferred()
  using finishInitialization = gate()
  using warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const run = await scenario.launch({
    providers: [provider(serviceValue, async ({ signal, onCleanup }) => {
      started.resolve()
      onCleanup(() => scenario.log('early-cleanup'))
      await finishInitialization.promise
      scenario.log(signal.aborted ? 'aborted' : 'not-aborted')
      onCleanup(() => {
        scenario.log('late-cleanup')
        cleaned.resolve()
      })
      return { read: () => 'ready' }
    })],
    shutdownTimeout: 30,
  })

  const pending = expect(run.resolveService(serviceValue))
    .rejects.toThrow(/Service runner shutting down/)
  await withTimeout(started.promise)
  await withTimeout(run.closeServices())

  expect(warning.mock.calls).toEqual([
    [expect.stringMatching(/Service cleanup timed out/)],
  ])

  finishInitialization.release()
  await Promise.all([pending, withTimeout(cleaned.promise)])

  // Early cleanup may run during cancellation, before initialization finishes.
  // A callback registered afterward must still execute exactly once.
  expect(run.events.toSorted()).toEqual(['aborted', 'late-cleanup', 'early-cleanup'].toSorted())
})

test('services transport functions and objects over RPC', async ({ scenario }) => {
  const greeting = service<(name: string) => string>('greeting')
  const calculator = service<{ values: number[]; add(a: number, b: number): number }>('calculator')
  const run = await scenario.launch({
    providers: [
      provider(greeting, () => (name: string) => `Hello ${name}`),
      provider(calculator, () => ({ values: [1, 2], add: (a: number, b: number) => a + b })),
    ],
  })

  const remote = await run.service(calculator)

  expect(await run.service(greeting)('Ada')).toBe('Hello Ada')
  expect(remote.values).toEqual([1, 2])
  expect(await remote.add(3, 4)).toBe(7)
})

test('a failed dependent cleans up before its service', async ({ scenario }) => {
  const counter = service<{ ping(): string }>('counter')
  const dependent = service<{}>('dependent')
  const run = await scenario.launch({
    providers: [
      provider(counter, ({ onCleanup }) => {
        onCleanup(() => scenario.log('counter'))
        return { ping: () => 'alive' }
      }),
      provider(dependent, async ({ getService, onCleanup }) => {
        const shared = await getService(counter)
        onCleanup(() => scenario.log(`dependent:${shared.ping()}`))
        throw new Error('DEPENDENT_FAILED')
      }),
    ],
  })

  await expect(run.resolveService(dependent)).rejects.toThrow(/DEPENDENT_FAILED/)
  await run.stop()

  expect(run.events).toEqual(['dependent:alive', 'counter'])
})

test('cancelling a test does not cancel its shared service', async ({ scenario }) => {
  const counter = service<{ value: number }>('counter')
  const account = resource<{}, number>('account')
  const initialized = deferred()
  using finishInitialization = gate()
  const run = await scenario.launch({
    providers: [
      provider(counter, async () => {
        scenario.log('init')
        initialized.resolve()
        await finishInitialization.promise
        return { value: 42 }
      }),
      provider(account, async (_input, { getService }) => (await getService(counter)).value),
    ],
    tests: {
      cancelled: [account('user', {})],
      next: [account('user', {})],
    },
    concurrency: { total: 2, prefetch: 0 },
  })

  const cancelled = run.startTest('cancelled')
  const pending = cancelled.resources()
  await initialized.promise
  const next = run.startTest('next')
  const nextReady = next.resources()
  await cancelled.release()
  await expect(pending).rejects.toThrow(/cancel/i)
  finishInitialization.release()

  expect(await nextReady).toEqual({ user: 42 })
  expect(run.events).toEqual(['init'])
})

test('cancelled waits do not accumulate promise reactions', async ({ scenario }) => {
  const counter = service<{ value: number }>('counter')
  const account = resource<{ id: number }, number>('account')
  using finishInitialization = gate()
  const allStarted = deferred()
  let started = 0
  const run = await scenario.launch({
    providers: [
      provider(counter, async () => {
        await finishInitialization.promise
        return { value: 42 }
      }),
      provider(account, async (_input, { getService }) => {
        if (++started === 20) allStarted.resolve()
        return (await getService(counter)).value
      }),
    ],
    tests: Object.fromEntries(Array.from({ length: 20 }, (_, id) => [
      `test-${id}`, [account('user', { id })],
    ])),
    concurrency: { total: 20, prefetch: 0 },
  })

  const initialized = run.resolveService(counter)
  using subscriptions = vi.spyOn(initialized, 'then')
  const attempts = Array.from({ length: 20 }, (_, id) => run.startTest(`test-${id}`))
  const failures = attempts.slice(0, -1).map(attempt => expect(attempt.resources()).rejects.toThrow(/cancel/i))
  const surviving = attempts[19].resources()
  await allStarted.promise
  await Promise.all(attempts.slice(0, -1).map(attempt => attempt.release()))
  await Promise.all(failures)

  expect(subscriptions).toHaveBeenCalledTimes(1)

  finishInitialization.release()

  expect(await surviving).toEqual({ user: 42 })
})

test('missing services identify the requested service', async ({ scenario }) => {
  const missing = service<{ ping(): string }>('missing')
  const run = await scenario.launch({ providers: [] })

  await expect(run.service(missing).ping()).rejects.toThrow("Service 'missing' is not registered")
})

test('service dependencies are only resolved during initialization', async ({ scenario }) => {
  const counter = service<{ next(): number }>('counter')
  const delayed = service<{ getCount(): Promise<number> }>('delayed')
  const run = await scenario.launch({
    providers: [
      provider(counter, () => ({ next: () => 1 })),
      provider(delayed, ({ getService }) => ({
        getCount: async () => (await getService(counter)).next(),
      })),
    ],
  })

  await expect(run.service(delayed).getCount()).rejects.toThrow(/only available during initialization/)
})


test('a failed service propagates through dependent resource creation', async ({ scenario }) => {
  const database = service<{ connect(): string }>('database')
  const account = resource<{}, string>('account')
  const run = await scenario.launch({
    providers: [
      provider(database, ({ onCleanup }) => {
        scenario.log('database:start')
        onCleanup(() => scenario.log('database:cleanup'))
        throw new Error('DATABASE_UNAVAILABLE')
      }),
      provider(account, async (_input, { getService, onCleanup }) => {
        scenario.log('account:start')
        onCleanup(() => scenario.log('account:cleanup'))
        return (await getService(database)).connect()
      }),
    ],
    tests: { first: [account('user', {})] },
  })

  await expect(run.startTest('first').resources()).rejects.toMatchObject({
    cause: { message: expect.stringContaining('DATABASE_UNAVAILABLE') },
  })
  await run.stop()

  expect(run.events).toEqual([
    'account:start',
    'database:start',
    'database:cleanup',
    'account:cleanup',
  ])
})


test('service cleanup errors are reported without interrupting shutdown', async ({ scenario }) => {
  const cache = service<{ read(): string }>('cache')
  using warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const run = await scenario.launch({
    providers: [provider(cache, ({ onCleanup }) => {
      onCleanup(() => { throw new Error('CACHE_CLEANUP_FAILED') })
      return { read: () => 'ready' }
    })],
  })

  expect(await run.service(cache).read()).toBe('ready')
  await run.stop()

  expect(warning.mock.calls).toEqual([
    [expect.stringContaining('CACHE_CLEANUP_FAILED')],
  ])
})

test('service shutdown has a bounded cleanup timeout', async ({ scenario }) => {
  const cache = service<{ read(): string }>('cache')
  using finishCleanup = gate()
  using warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const run = await scenario.launch({
    providers: [provider(cache, ({ onCleanup }) => {
      onCleanup(() => finishCleanup.promise)
      return { read: () => 'ready' }
    })],
    shutdownTimeout: 30,
  })

  expect(await run.service(cache).read()).toBe('ready')
  await run.stop()

  expect(warning.mock.calls).toEqual([
    [expect.stringMatching(/Service cleanup timed out/)],
  ])
})


test('closed services reject new requests without initializing providers', async ({ scenario }) => {
  const cache = service<{ read(): string }>('cache')
  const run = await scenario.launch({
    providers: [provider(cache, () => {
      scenario.log('init')
      return { read: () => 'ready' }
    })],
  })

  await run.closeServices()

  await expect(run.resolveService(cache)).rejects.toThrow('Service provisioning has stopped')
  expect(run.events).toEqual([])
})

test('missing service dependencies fail initialization and release its cleanup', async ({ scenario }) => {
  const database = service<{ read(): string }>('database')
  const accounts = service<{ read(): string }>('accounts')
  const run = await scenario.launch({
    providers: [provider(accounts, async ({ getService, onCleanup }) => {
      scenario.log('accounts:start')
      onCleanup(() => scenario.log('accounts:cleanup'))
      return getService(database)
    })],
  })

  await expect(run.resolveService(accounts)).rejects.toThrow("Service 'database' is not registered")
  await run.stop()

  expect(run.events).toEqual(['accounts:start', 'accounts:cleanup'])
})


test('multiple services can share one dependency without a cycle', async ({ scenario }) => {
  const database = service<{ id: string }>('database')
  const reader = service<{ read(): string }>('reader')
  const writer = service<{ write(): string }>('writer')
  const application = service<{ run(): string }>('application')
  const run = await scenario.launch({
    providers: [
      provider(database, ({ onCleanup }) => {
        scenario.log('database:init')
        onCleanup(() => scenario.log('database:cleanup'))
        return { id: 'primary' }
      }),
      provider(reader, async ({ getService, onCleanup }) => {
        const shared = await getService(database)
        onCleanup(() => scenario.log('reader:cleanup'))
        return { read: () => `read:${shared.id}` }
      }),
      provider(writer, async ({ getService, onCleanup }) => {
        const shared = await getService(database)
        onCleanup(() => scenario.log('writer:cleanup'))
        return { write: () => `write:${shared.id}` }
      }),
      provider(application, async ({ getService, onCleanup }) => {
        const [read, write] = await Promise.all([getService(reader), getService(writer)])
        onCleanup(() => scenario.log('application:cleanup'))
        return { run: () => `${read.read()},${write.write()}` }
      }),
    ],
  })

  const result = await run.service(application).run()
  await run.stop()

  expect(result).toBe('read:primary,write:primary')
  expect(run.events[0]).toBe('database:init')
  expect(run.events.slice(1).toSorted()).toEqual([
    'application:cleanup', 'database:cleanup', 'reader:cleanup', 'writer:cleanup',
  ])
  for (const dependent of ['reader:cleanup', 'writer:cleanup']) {
    expect(run.events.indexOf('application:cleanup')).toBeLessThan(run.events.indexOf(dependent))
    expect(run.events.indexOf(dependent)).toBeLessThan(run.events.indexOf('database:cleanup'))
  }
})
