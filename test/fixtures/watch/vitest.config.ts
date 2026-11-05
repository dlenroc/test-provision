import { defineConfig } from 'vitest/config'
import { readFileSync, appendFileSync } from 'node:fs'
import { provider } from '@dlenroc/test-provision'
import { provision } from '@dlenroc/test-provision/vitest/plugin'
import { account, shared } from './contracts.js'

const log = (type: string, data = '') =>
  appendFileSync(process.env.PROVISION_WATCH_EVENTS!, `${type}:${data}\n`)

export default defineConfig({
  plugins: [provision({
    providers: [
      provider(shared, ({ onCleanup }) => {
        log('service-start')
        onCleanup(() => log('service-clean'))
        let count = 0
        return { next: () => ++count }
      }),
      provider(account, async (_input, { id, getService, onCleanup }) => {
        const client = await getService(shared)
        client.next()
        const run = readFileSync(process.env.PROVISION_WATCH_CONTROL!, 'utf8')
        log('create', `${run}:${id}`)
        onCleanup(() => log('clean', `${run}:${id}`))
        if (run === 'initial-failure') throw new Error('EXPECTED_FAILURE')
        return { run }
      }),
    ],
    concurrency: { total: 1, prefetch: 0 },
  })],
  test: { include: ['test/fixtures/watch/provision.fixture.ts'], maxWorkers: 1, isolate: false },
})
