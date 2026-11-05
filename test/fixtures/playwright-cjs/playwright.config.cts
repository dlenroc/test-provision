import { defineConfig } from '@playwright/test'
import { provision } from '@dlenroc/test-provision/playwright/reporter'
import { counterProvider } from './provider.cjs'

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.fixture.cts',
  reporter: [provision({ providers: [counterProvider] })],
  workers: 1,
  timeout: 10_000,
})
