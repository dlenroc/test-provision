import { expect } from 'vitest'
import { provider, resource } from '../../src/index.js'
import { test } from '../helpers/scenario.ts'
import { deferred, gate, nextTurn, withTimeout } from '../helpers/sync.ts'

test('only selected tests are prefetched', async ({ scenario }) => {
  const account = resource<{ name: string }, string>('account')
  const creationStarted = deferred()
  const run = await scenario.launch({
    providers: [provider(account, ({ name }, { onCleanup }) => {
      scenario.log(`create:${name}`)
      onCleanup(() => scenario.log(`delete:${name}`))
      creationStarted.resolve()
      return name
    })],
    tests: {
      selected: [account('user', { name: 'Alice' })],
      skipped: [account('user', { name: 'Bob' })],
    },
    skipped: ['skipped'],
    concurrency: { total: 1, prefetch: 1 },
  })

  await withTimeout(creationStarted.promise)
  const selected = run.startTest('selected')
  const result = await selected.resources()
  await selected.release()
  await run.stop()

  expect(result).toEqual({ user: 'Alice' })
  expect(run.events).toEqual(['create:Alice', 'delete:Alice'])
})

test('an unused prepared resource can serve the next test', async ({ scenario }) => {
  const account = resource<{}, number>('account')
  const failing = resource<{}, never>('failing')
  const run = await scenario.launch({
    providers: [
      provider(account, (_input, { onCleanup }) => {
        scenario.log('create:account')
        onCleanup(() => scenario.log('delete:account'))
        return 42
      }),
      provider(failing, () => { throw new Error('CREATE_FAILED') }),
    ],
    tests: {
      failed: [account('unused', {}), failing('error', {})],
      next: [account('user', {})],
    },
    concurrency: { total: 2, prefetch: 0 },
  })

  await expect(run.startTest('failed').resources()).rejects.toThrow(/Failed to prepare/)
  const next = run.startTest('next')
  const result = await next.resources()
  await next.release()
  await run.stop()

  expect(result).toEqual({ user: 42 })
  expect(run.events).toEqual(['create:account', 'delete:account'])
})

test('cancelled creation still occupies a slot until it settles', async ({ scenario }) => {
  const account = resource<{ id: number }, number>('account')
  const firstStarted = deferred()
  using finishFirst = gate()
  let running = 0
  let peak = 0
  const run = await scenario.launch({
    providers: [provider(account, async ({ id }, { onCleanup }) => {
      onCleanup(() => scenario.log(`early:${id}`))
      running++
      peak = Math.max(peak, running)
      using _active = { [Symbol.dispose]: () => { running-- } }
      if (id === 1) {
        firstStarted.resolve()
        await finishFirst.promise
        onCleanup(() => scenario.log(`late:${id}`))
      }
      return id
    })],
    tests: {
      first: [account('user', { id: 1 })],
      next: [account('user', { id: 2 })],
    },
    concurrency: { total: 1, prefetch: 0 },
  })

  const first = run.startTest('first')
  const cancelled = Promise.allSettled([first.resources()])
  await withTimeout(firstStarted.promise)
  const next = run.startTest('next')
  const nextReady = next.resources()
  await first.release()
  finishFirst.release()
  expect(await cancelled).toMatchObject([{
    status: 'rejected',
    reason: { message: expect.stringMatching(/cancel/i) },
  }])
  const result = await nextReady
  await next.release()
  await run.stop()

  expect(result).toEqual({ user: 2 })
  expect(peak).toBe(1)
  expect(run.events.toSorted()).toEqual(['early:1', 'early:2', 'late:1'])
})

test('rate limits space provider starts', async ({ scenario }) => {
  const account = resource<{ id: number }, number>('account')
  const starts: number[] = []
  const run = await scenario.launch({
    providers: [provider(account, { rateLimit: { limit: 1, interval: 40 } }, ({ id }) => {
      starts.push(performance.now())
      return id
    })],
    tests: {
      first: [account('user', { id: 1 })],
      next: [account('user', { id: 2 })],
    },
    concurrency: { total: 2, prefetch: 0 },
  })

  const first = run.startTest('first')
  const next = run.startTest('next')
  const results = await Promise.all([first.resources(), next.resources()])

  expect(results).toEqual([{ user: 1 }, { user: 2 }])
  expect(starts).toHaveLength(2)
  expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(30)
})

test('a test can claim resource preparation already in progress', async ({ scenario }) => {
  const account = resource<{}, number>('account')
  const creationStarted = deferred()
  using finishCreation = gate()
  const run = await scenario.launch({
    providers: [provider(account, async (_input, { onCleanup }) => {
      scenario.log('create')
      onCleanup(() => scenario.log('delete'))
      creationStarted.resolve()
      await finishCreation.promise
      return 42
    })],
    tests: { first: [account('user', {})] },
    concurrency: { total: 1, prefetch: 1 },
  })

  await withTimeout(creationStarted.promise)
  const first = run.startTest('first')
  finishCreation.release()
  const result = await first.resources()
  await first.release()
  await run.stop()

  expect(result).toEqual({ user: 42 })
  expect(run.events).toEqual(['create', 'delete'])
})

test('claiming a prefetch schedules another resource while unrelated tests run', async ({ scenario }) => {
  const account = resource<{ id: number }, number>('account')
  const started = [deferred(), deferred(), deferred()]
  using finishCreation = gate()
  const run = await scenario.launch({
    providers: [provider(account, async ({ id }) => {
      scenario.log(`start:${id}`)
      started[id - 1].resolve()
      await finishCreation.promise
      return id
    })],
    tests: {
      first: [account('user', { id: 1 })],
      next: [account('user', { id: 2 })],
      later: [account('user', { id: 3 })],
      independent: [],
    },
    concurrency: { total: 3, prefetch: 2 },
  })

  await withTimeout(Promise.all([started[0].promise, started[1].promise]))
  const independent = run.startTest('independent')
  const unrelated = await withTimeout(independent.resources())
  await independent.release()
  const first = run.startTest('first')
  await withTimeout(started[2].promise)

  expect(unrelated).toEqual({})
  expect(run.events).toEqual(['start:1', 'start:2', 'start:3'])

  finishCreation.release()
  const firstResult = await first.resources()
  const next = run.startTest('next')
  const later = run.startTest('later')
  const rest = await Promise.all([next.resources(), later.resources()])

  expect(firstResult).toEqual({ user: 1 })
  expect(rest).toEqual([{ user: 2 }, { user: 3 }])
})

test('cleanup does not occupy creation slots', async ({ scenario }) => {
  const account = resource<{ id: number }, number>('account')
  using finishCleanup = gate()
  const run = await scenario.launch({
    providers: [provider(account, ({ id }, { onCleanup }) => {
      scenario.log(`create:${id}`)
      onCleanup(async () => {
        scenario.log(`cleanup:start:${id}`)
        await finishCleanup.promise
        scenario.log(`cleanup:end:${id}`)
      })
      return id
    })],
    tests: Object.fromEntries(Array.from({ length: 12 }, (_, id) => [
      `test-${id}`, [account('user', { id })],
    ])),
    concurrency: { total: 1, prefetch: 0 },
  })

  for (let id = 0; id < 12; id++) {
    const attempt = run.startTest(`test-${id}`)
    await attempt.resources()
    await attempt.release()
  }
  await nextTurn()

  expect(run.events.filter(event => event.startsWith('create:'))).toHaveLength(12)
  expect(run.events.filter(event => event.startsWith('cleanup:start:'))).toHaveLength(12)
  expect(run.events.filter(event => event.startsWith('cleanup:end:'))).toEqual([])

  finishCleanup.release()
  await run.finishTests()

  expect(run.events.filter(event => event.startsWith('cleanup:end:')).toSorted()).toEqual(
    Array.from({ length: 12 }, (_, id) => `cleanup:end:${id}`).toSorted(),
  )
})

test('per-provider limits do not block other resource types', async ({ scenario }) => {
  const account = resource<{ id: number }, number>('account')
  const workspace = resource<{}, string>('workspace')
  const firstStarted = deferred()
  const secondStarted = deferred()
  using finishFirst = gate()
  let running = 0
  let peak = 0
  const run = await scenario.launch({
    providers: [
      provider(account, { concurrency: 1 }, async ({ id }) => {
        scenario.log(`account:${id}`)
        running++
        peak = Math.max(peak, running)
        using _active = { [Symbol.dispose]: () => { running-- } }
        if (id === 1) {
          firstStarted.resolve()
          await finishFirst.promise
        } else secondStarted.resolve()
        return id
      }),
      provider(workspace, () => 'ready'),
    ],
    tests: {
      first: [account('user', { id: 1 })],
      next: [account('user', { id: 2 })],
      unrelated: [workspace('space', {})],
    },
    concurrency: { total: 3, prefetch: 0 },
  })

  const first = run.startTest('first')
  await withTimeout(firstStarted.promise)
  const next = run.startTest('next')
  const unrelated = run.startTest('unrelated')
  const independentResult = await withTimeout(unrelated.resources())
  await unrelated.release()
  finishFirst.release()
  await withTimeout(secondStarted.promise)
  const results = await Promise.all([first.resources(), next.resources()])

  expect(independentResult).toEqual({ space: 'ready' })
  expect(results).toEqual([{ user: 1 }, { user: 2 }])
  expect(peak).toBe(1)
  expect(run.events).toEqual(['account:1', 'account:2'])
})

test('a failed attempt prefetches its retry when enabled', async ({ scenario }) => {
  const account = resource<{}, number>('account')
  const retryStarted = deferred()
  let creations = 0
  const run = await scenario.launch({
    providers: [provider(account, () => {
      const id = ++creations
      scenario.log(`create:${id}`)
      if (id === 2) retryStarted.resolve()
      return id
    })],
    tests: { flaky: [account('user', {})] },
    retries: 1,
    prefetchRetries: true,
    concurrency: { total: 2, prefetch: 1 },
  })

  const initial = run.startTest('flaky', 0)
  const first = await initial.resources()
  await initial.release()
  run.finishAttempt('flaky', 0, 'failed')
  await withTimeout(retryStarted.promise)
  const retry = run.startTest('flaky', 1)
  const second = await retry.resources()
  await retry.release()

  expect([first, second]).toEqual([{ user: 1 }, { user: 2 }])
  expect(run.events).toEqual(['create:1', 'create:2'])
})


test('identical failed resource requests share their failure', async ({ scenario }) => {
  const account = resource<{ name: string }, string>('account')
  const run = await scenario.launch({
    providers: [provider(account, ({ name }) => {
      scenario.log(`create:${name}`)
      throw new Error('ACCOUNT_UNAVAILABLE')
    })],
    tests: {
      first: [account('user', { name: 'Alice' })],
      second: [account('user', { name: 'Alice' })],
    },
    concurrency: { total: 1, prefetch: 0 },
  })

  const results = await Promise.allSettled([
    run.startTest('first').resources(),
    run.startTest('second').resources(),
  ])
  await run.stop()

  expect(results).toMatchObject([
    { status: 'rejected', reason: { cause: { message: 'ACCOUNT_UNAVAILABLE' } } },
    { status: 'rejected', reason: { cause: { message: 'ACCOUNT_UNAVAILABLE' } } },
  ])
  expect(run.events).toEqual(['create:Alice'])
})
