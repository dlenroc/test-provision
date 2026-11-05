import { expect, vi } from 'vitest'
import { provider, resource } from '../../src/index.js'
import { collectRequirements } from '../../src/core/contract.js'
import { Coordinator } from '../../src/core/coordinator.js'
import { test } from '../helpers/scenario.ts'
import { deferred, gate, nextTurn, withTimeout } from '../helpers/sync.ts'

test('each test receives an isolated account', async ({ scenario }) => {
  const account = resource<{ name: string }, { id: number; greet(name: string): string }>('account')
  let nextId = 0
  const run = await scenario.launch({
    providers: [provider(account, (_input, { onCleanup }) => {
      const id = ++nextId
      onCleanup(() => scenario.log(`delete:${id}`))
      return { id, greet: (name: string) => `Hello ${name}` }
    })],
    tests: {
      alice: [account('user', { name: 'Alice' })],
      bob: [account('user', { name: 'Bob' })],
    },
  })

  const alice = run.startTest('alice')
  const bob = run.startTest('bob')
  const [aliceAccount, bobAccount] = await Promise.all([
    alice.resource(account, 'user'), bob.resource(account, 'user'),
  ])

  expect([aliceAccount.id, bobAccount.id].toSorted()).toEqual([1, 2])
  expect(await aliceAccount.greet('Ada')).toBe('Hello Ada')

  await Promise.all([alice.release(), alice.release(), bob.release()])
  await run.stop()

  expect(run.events.toSorted()).toEqual(['delete:1', 'delete:2'])
})

test('delivered resources are never reused by later tests with identical inputs', async ({ scenario }) => {
  const account = resource<{}, number>('account')
  let created = 0
  const run = await scenario.launch({
    providers: [provider(account, () => ++created)],
    tests: {
      first: [account('user', {})],
      second: [account('user', {})],
    },
    concurrency: { total: 1, prefetch: 0 },
  })

  const first = run.startTest('first')
  expect(await first.resources()).toEqual({ user: 1 })
  await first.release()

  const second = run.startTest('second')
  expect(await second.resources()).toEqual({ user: 2 })
  await second.release()
  expect(created).toBe(2)
})

test('missing providers identify the requested resource', async ({ scenario }) => {
  const account = resource<{}, string>('account')
  const run = await scenario.launch({
    providers: [],
    tests: { first: [account('user', {})] },
  })

  await expect(run.startTest('first').resources()).rejects.toMatchObject({
    message: expect.stringContaining("resource 'user'"),
    cause: { message: "No provider registered for resource 'account'" },
  })
})

test('releasing a test does not await resource cleanup', async ({ scenario }) => {
  const account = resource<{ name: string }, string>('account')
  const cleanupStarted = deferred()
  using finishCleanup = gate()
  const run = await scenario.launch({
    providers: [provider(account, ({ name }, { onCleanup }) => {
      onCleanup(async () => {
        if (name === 'first') {
          cleanupStarted.resolve()
          await finishCleanup.promise
        }
        scenario.log(name)
      })
      return name
    })],
    tests: {
      first: [account('user', { name: 'first' })],
      next: [account('user', { name: 'next' })],
    },
    concurrency: { total: 1 },
  })

  const first = run.startTest('first')
  expect(await first.resources()).toEqual({ user: 'first' })
  await withTimeout(first.release())
  await withTimeout(cleanupStarted.promise)
  const next = run.startTest('next')

  expect(await withTimeout(next.resources())).toEqual({ user: 'next' })
  expect(run.events).toEqual([])

  await next.release()
  const shutdown = run.finishTests()
  let finished = false
  void shutdown.then(() => { finished = true })
  await nextTurn()

  expect(finished).toBe(false)

  finishCleanup.release()
  await shutdown

  expect(run.events.toSorted()).toEqual(['first', 'next'])
})

test('cleanup failures are reported without rejecting a delivered resource', async ({ scenario }) => {
  const account = resource<{}, number>('account')
  using warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const run = await scenario.launch({
    providers: [provider(account, (_input, { onCleanup }) => {
      onCleanup(() => { throw new Error('DELETE_FAILED') })
      return 42
    })],
    tests: { first: [account('user', {})] },
  })

  const first = run.startTest('first')
  const result = await first.resources()
  await first.release()
  await run.stop()

  expect(result).toEqual({ user: 42 })
  expect(warning.mock.calls).toEqual([[expect.stringMatching(/DELETE_FAILED/)]])
})

test('failed creation retains its cause and cleans up in reverse order', async ({ scenario }) => {
  const account = resource<{}, never>('account')
  const run = await scenario.launch({
    providers: [provider(account, (_input, { onCleanup }) => {
      scenario.log('create')
      onCleanup(() => scenario.log('first'))
      onCleanup(async () => { await nextTurn(); scenario.log('second') })
      throw new Error('CREATE_FAILED')
    })],
    tests: { first: [account('user', {})] },
  })

  const failure = run.startTest('first').resources()

  await expect(failure).rejects.toMatchObject({
    message: expect.stringMatching(/resource 'user'/),
    cause: { message: 'CREATE_FAILED' },
  })
  await run.stop()

  expect(run.events).toEqual(['create', 'second', 'first'])
})

test('failed cleanup does not replace the creation error', async ({ scenario }) => {
  const account = resource<{}, never>('account')
  using warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const run = await scenario.launch({
    providers: [provider(account, (_input, { onCleanup }) => {
      onCleanup(() => scenario.log('released'))
      onCleanup(() => { throw new Error('CLEANUP_FAILED') })
      throw new Error('CREATE_FAILED')
    })],
    tests: { first: [account('user', {})] },
  })

  await expect(run.startTest('first').resources()).rejects.toMatchObject({
    cause: { message: 'CREATE_FAILED' },
  })
  await run.stop()

  expect(run.events).toEqual(['released'])
  expect(warning.mock.calls).toEqual([[expect.stringMatching(/CLEANUP_FAILED/)]])
})

test('shutdown waits for cleanup registered after cancellation', async ({ scenario }) => {
  const account = resource<{}, string>('account')
  const creationStarted = deferred()
  using finishCreation = gate()
  using finishCleanup = gate()
  const run = await scenario.launch({
    providers: [provider(account, async (_input, { signal, onCleanup }) => {
      creationStarted.resolve()
      await finishCreation.promise
      scenario.log(signal.aborted ? 'cancelled' : 'active')
      onCleanup(async () => {
        scenario.log('cleanup:start')
        await finishCleanup.promise
        scenario.log('cleanup:end')
      })
      return 'created'
    })],
    tests: { first: [account('user', {})] },
    concurrency: { total: 1, prefetch: 1 },
    shutdownTimeout: 3_000,
  })

  await withTimeout(creationStarted.promise)
  const shutdown = run.finishTests()
  await nextTurn()
  finishCreation.release()
  await nextTurn()

  expect(run.events).toEqual(['cancelled', 'cleanup:start'])

  let completed = false
  void shutdown.then(() => { completed = true })
  await nextTurn()

  expect(completed).toBe(false)

  finishCleanup.release()
  await shutdown

  expect(run.events).toEqual(['cancelled', 'cleanup:start', 'cleanup:end'])
})

test('shutdown reports a cleanup timeout', async ({ scenario }) => {
  const account = resource<{}, number>('account')
  using finishCleanup = gate()
  using warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const run = await scenario.launch({
    providers: [provider(account, (_input, { onCleanup }) => {
      onCleanup(() => finishCleanup.promise)
      return 42
    })],
    tests: { first: [account('user', {})] },
    shutdownTimeout: 30,
  })

  const first = run.startTest('first')
  expect(await first.resources()).toEqual({ user: 42 })
  await first.release()
  await run.finishTests()

  expect(warning.mock.calls).toEqual([[expect.stringMatching(/cleanup timed out/)]])
})

test('coordinator shutdown releases delivered work and cancels active and queued attempts', async () => {
  const account = resource<{ id: string }, string>('account')
  const events: string[] = []
  const activeStarted = deferred()
  using finishCreation = gate()
  const coordinator = new Coordinator([provider(account, async ({ id }, { signal, onCleanup }) => {
    events.push(`start:${id}`)
    onCleanup(() => events.push(`cleanup:${id}`))
    if (id === 'active') {
      activeStarted.resolve()
      // External providers may continue to run after cancellation.
      await finishCreation.promise
      events.push(signal.aborted ? 'active:aborted' : 'active:not-aborted')
    }
    return id
  })], { concurrency: { total: 1, prefetch: 0 } })
  const request = (id: string) => collectRequirements([account('user', { id })])

  // Simulate a worker that received a resource but never released its handle.
  const delivered = coordinator.open('delivered', request('delivered'), 0)
  expect((await delivered.ready()).values).toEqual({ user: 'delivered' })

  const active = coordinator.open('active', request('active'), 0)
  const activeRejection = expect(active.ready()).rejects.toThrow(/cancel/i)
  await withTimeout(activeStarted.promise)
  const queued = coordinator.open('queued', request('queued'), 0)
  const queuedRejection = expect(queued.ready()).rejects.toThrow(/cancel/i)

  const shutdown = coordinator.close()
  finishCreation.release()
  await withTimeout(shutdown)
  await Promise.all([activeRejection, queuedRejection])

  expect(events.toSorted()).toEqual([
    'active:aborted',
    'cleanup:active',
    'cleanup:delivered',
    'start:active',
    'start:delivered',
  ].toSorted())
})

test('two aliases with identical inputs receive separate instances', async ({ scenario }) => {
  const account = resource<{}, { id: number }>('account')
  let created = 0
  const run = await scenario.launch({
    providers: [provider(account, (_input, { onCleanup }) => {
      const id = ++created
      onCleanup(() => scenario.log(`dispose:${id}`))
      return { id }
    })],
    tests: { first: [account('left', {}), account('right', {})] },
    concurrency: { total: 2, prefetch: 2 },
  })

  const attempt = run.startTest('first')
  const values = await attempt.resources()

  expect(Object.values(values).map(value => (value as { id: number }).id).toSorted()).toEqual([1, 2])
  expect(values.left).not.toBe(values.right)

  await attempt.release()
  await run.stop()

  expect(run.events.toSorted()).toEqual(['dispose:1', 'dispose:2'])
})
