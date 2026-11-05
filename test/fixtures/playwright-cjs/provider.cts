import { appendFileSync } from 'node:fs'
import { RpcTarget } from 'capnweb'
import { resource, provider } from '@dlenroc/test-provision'

function log(event: string) {
  if (process.env.PROVISION_TEST_EVENTS)
    appendFileSync(process.env.PROVISION_TEST_EVENTS, JSON.stringify({ type: 'flow', stage: event }) + '\n')
}

let nextId = 0
class Counter extends RpcTarget {
  private count = 0
  constructor(private readonly id: string) { super() }
  next() { return ++this.count }
  close() { log(`dispose:${this.id}`) }
}

export const counter = resource<{}, Counter>('test.cjs.counter')
export const counterProvider = provider(counter, (_input, { onCleanup }) => {
  const id = `CjsCounter-${++nextId}`
  const value = new Counter(id)
  onCleanup(() => value.close())
  log(`create:${id}`)
  return value
})
