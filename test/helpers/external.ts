import { spawnSync } from 'node:child_process'
import { mkdtempDisposableSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunnerEvent } from './providers.js'

/** Runs an installed CLI runner as a subprocess; includes output in failures. */
export function runCli(binary: 'vitest' | 'playwright', args: string[], env: NodeJS.ProcessEnv = {}) {
  using output = binary === 'playwright' && args[0] === 'test'
    ? mkdtempDisposableSync(join(tmpdir(), 'test-provision-playwright-output-'))
    : undefined
  const runnerArgs = output ? [...args, '--output', join(output.path, 'results')] : args
  const processResult = spawnSync(join(process.cwd(), 'node_modules/.bin', binary), runnerArgs, {
    cwd: process.cwd(),
    env: { ...process.env, ...env, FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 110_000,
  })
  if (processResult.status !== 0) {
    throw new Error(`${binary} failed: ${processResult.error ?? ''}\n${processResult.stdout ?? ''}\n${processResult.stderr ?? ''}`)
  }
  return `${processResult.stdout ?? ''}\n${processResult.stderr ?? ''}`
}

/** Executes the real runner fixtures and reads their structured provider events. */
export function runFixture(
  binary: 'vitest' | 'playwright',
  config = `test/fixtures/${binary}/${binary}.config.ts`,
  env: NodeJS.ProcessEnv = {},
): RunnerEvent[] {
  using directory = mkdtempDisposableSync(join(tmpdir(), `test-provision-${binary}-`))
  const file = join(directory.path, 'events.log')
  writeFileSync(file, '')

  runCli(binary, [binary === 'vitest' ? 'run' : 'test', '--config',
    config], { ...env, PROVISION_TEST_EVENTS: file })

  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as RunnerEvent)
}
