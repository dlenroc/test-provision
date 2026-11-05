import { appendFileSync } from 'node:fs'
import { provider } from '@dlenroc/test-provision'
import { counter, user } from './contracts.js'

export type RunnerEvent =
  | { type: 'service'; stage: 'start' | 'cleanup' }
  | { type: 'resource'; stage: 'create' | 'cleanup'; name: string; id: number }
  | { type: 'use'; name: string; retry: number; id: number }
  | { type: 'flow'; stage: string }

const log = (event: RunnerEvent) => {
  if (process.env.PROVISION_TEST_EVENTS) {
    appendFileSync(process.env.PROVISION_TEST_EVENTS, JSON.stringify(event) + '\n')
  }
}

let nextId = 0
export const counterProvider = provider(counter, ({ onCleanup }) => {
  log({ type: 'service', stage: 'start' })
  let count = 0
  onCleanup(() => log({ type: 'service', stage: 'cleanup' }))
  return { next: () => ++count }
})

export const userProvider = provider(user, async ({ name }, { getService, onCleanup }) => {
  const id = ++nextId
  const shared = await getService(counter)
  shared.next()
  log({ type: 'resource', stage: 'create', name, id })
  onCleanup(async () => {
    await Promise.resolve()
    log({ type: 'resource', stage: 'cleanup', name, id })
  })
  return {
    id,
    name,
    greet: (to: string) => `Hello ${to}`,
    markUsed: (retry: number) => log({ type: 'use', name, retry, id }),
  }
})
