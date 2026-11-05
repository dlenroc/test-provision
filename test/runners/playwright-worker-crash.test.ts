import { spawnSync } from 'node:child_process'
import { mkdtempDisposableSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { RunnerEvent } from '../helpers/providers.js'

test('Playwright cleans up an allocated resource after its worker crashes', { timeout: 120_000 }, () => {
  using output = mkdtempDisposableSync(join(tmpdir(), 'test-provision-worker-crash-'))
  const eventFile = join(output.path, 'events.log')
  writeFileSync(eventFile, '')

  const result = spawnSync(join(process.cwd(), 'node_modules/.bin/playwright'), [
    'test', '--config', 'test/fixtures/playwright-crash/playwright.config.ts',
    '--output', join(output.path, 'results'),
  ], {
    cwd: process.cwd(),
    env: { ...process.env, PROVISION_TEST_EVENTS: eventFile, FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 60_000,
  })
  const outputText = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  expect(result.error, outputText).toBeUndefined()
  expect(result.status, outputText).toBe(1)
  expect(outputText).toMatch(/worker process exited unexpectedly/i)

  const events = readFileSync(eventFile, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as RunnerEvent)
  const resources = events.filter(event => event.type === 'resource')
  expect(resources).toEqual([
    { type: 'resource', stage: 'create', name: 'Crash', id: 1 },
    { type: 'resource', stage: 'cleanup', name: 'Crash', id: 1 },
  ])
  expect(events.filter(event => event.type === 'use')).toEqual([
    { type: 'use', name: 'Crash', retry: 0, id: 1 },
  ])
  expect(events.filter(event => event.type === 'service')).toEqual([
    { type: 'service', stage: 'start' },
    { type: 'service', stage: 'cleanup' },
  ])
})
