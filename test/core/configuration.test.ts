import { expect } from 'vitest'
import { provider, resource } from '../../src/index.js'
import { test } from '../helpers/scenario.ts'

test('rejects zero total concurrency', async ({ scenario }) => {
  const account = resource<{}, number>('account')

  await expect(scenario.launch({
    providers: [provider(account, () => 1)],
    concurrency: { total: 0 },
  })).rejects.toThrow(/concurrency.total/)
})

test('rejects prefetch above total concurrency', async ({ scenario }) => {
  const account = resource<{}, number>('account')

  await expect(scenario.launch({
    providers: [provider(account, () => 1)],
    concurrency: { total: 1, prefetch: 2 },
  })).rejects.toThrow(/concurrency.prefetch/)
})

test('rejects negative prefetch concurrency', async ({ scenario }) => {
  const account = resource<{}, number>('account')

  await expect(scenario.launch({
    providers: [provider(account, () => 1)],
    concurrency: { prefetch: -1 },
  })).rejects.toThrow(/concurrency.prefetch/)
})

test('rejects zero provider concurrency', async ({ scenario }) => {
  const account = resource<{}, number>('account')

  await expect(scenario.launch({
    providers: [provider(account, { concurrency: 0 }, () => 1)],
  })).rejects.toThrow(/Provider 'account' concurrency/)
})

test('rejects invalid provider rate limits', async ({ scenario }) => {
  const account = resource<{}, number>('account')

  await expect(scenario.launch({
    providers: [provider(account, { rateLimit: { limit: 0, interval: 10 } }, () => 1)],
  })).rejects.toThrow(/rateLimit/)
})

test('rejects invalid shutdown timeouts', async ({ scenario }) => {
  const account = resource<{}, number>('account')

  await expect(scenario.launch({
    providers: [provider(account, () => 1)],
    shutdownTimeout: 0,
  })).rejects.toThrow(/shutdownTimeout/)
})
