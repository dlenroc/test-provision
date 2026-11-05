import { mkdtempDisposableSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base, vi } from 'vitest'
import { createVitest } from 'vitest/node'

/**
 * Runs Vitest in watch mode against an isolated fixture project.
 * The fixture owns its temporary files, environment variables, and runner shutdown.
 */
export const test = base.extend<{
  watch: {
    /** Starts watch mode on the first phase, then reruns the loaded suite. */
    runPhase(phase: string): Promise<{ states: string[]; errors: unknown[] }>
    /** Returns logged provider events matching a prefix, in emission order. */
    events(prefix: string): string[]
    close(): Promise<void>
  }
}>({
  watch: async ({}, use) => {
    using directory = mkdtempDisposableSync(join(tmpdir(), 'provision-watch-'))
    const eventsFile = join(directory.path, 'events.log')
    const controlFile = join(directory.path, 'run')
    using _restoreEnv = { [Symbol.dispose]: () => vi.unstubAllEnvs() }
    vi.stubEnv('PROVISION_WATCH_EVENTS', eventsFile)
    vi.stubEnv('PROVISION_WATCH_CONTROL', controlFile)
    writeFileSync(eventsFile, '')

    const runner = await createVitest({
      root: process.cwd(),
      config: 'test/fixtures/watch/vitest.config.ts',
      watch: true,
      reporters: [],
    })
    await using cleanup = new AsyncDisposableStack()
    const originalExitCode = process.exitCode
    cleanup.defer(() => { process.exitCode = originalExitCode })
    cleanup.defer(() => runner.close())
    let started = false
    await use({
      async runPhase(phase) {
        writeFileSync(controlFile, phase)
        const result = started
          ? await runner.rerunTestSpecifications(await runner.globTestSpecifications())
          : await runner.start()
        started = true
        return {
          states: result.testModules.flatMap(module =>
            [...module.children.allTests()].map(test => test.result().state)),
          errors: result.unhandledErrors,
        }
      },
      events(prefix) {
        return readFileSync(eventsFile, 'utf8')
          .trim().split('\n').filter(event => event.startsWith(prefix))
      },
      close: () => cleanup.disposeAsync(),
    })
  },
})
