import { defineConfig } from 'vitest/config'
import { provider } from '@dlenroc/test-provision'
import { provision } from '@dlenroc/test-provision/vitest/plugin'
import { mark } from '../../helpers/trace.js'
import { account } from './contracts.js'

const counts = new Map<string, number>()

export default defineConfig({
  plugins: [provision({
    providers: [provider(account, async ({ mode }, { signal, onCleanup }) => {
      const attempt = (counts.get(mode) ?? 0) + 1
      counts.set(mode, attempt)
      mark(`${mode}:start:${attempt}`)
      onCleanup(() => mark(`${mode}:cleanup:${attempt}`))

      if (mode === 'timeout' || (mode === 'recover' && attempt === 1)) {
        if (!signal.aborted) {
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        }
        mark(`${mode}:cancel:${attempt}`)
      }
      return { attempt }
    })],
    concurrency: { total: 2, prefetch: 0 },
    prefetchRetries: true,
  })],
  test: {
    include: ['test/fixtures/vitest-lifecycle/provision.fixture.ts'],
    maxWorkers: 1,
    testTimeout: 10_000,
  },
})
