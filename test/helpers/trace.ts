import { appendFileSync, readFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

function file() {
  const path = process.env.PROVISION_TEST_EVENTS
  if (!path) throw new Error('PROVISION_TEST_EVENTS is not configured')
  return path
}

export function mark(stage: string): void {
  appendFileSync(file(), JSON.stringify({ type: 'flow', stage }) + '\n')
}

export async function waitFor(stage: string): Promise<void> {
  const expected = JSON.stringify({ type: 'flow', stage })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (readFileSync(file(), 'utf8').includes(expected)) return
    await setTimeout(10)
  }
  throw new Error(`Timed out waiting for '${stage}'`)
}
