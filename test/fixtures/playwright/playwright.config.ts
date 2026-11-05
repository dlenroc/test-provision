import { defineConfig } from '@playwright/test'
import { provision } from '@dlenroc/test-provision/playwright/reporter'
import { counterProvider, userProvider } from '../../helpers/providers.js'

export default defineConfig({
  testDir: '.',
  testMatch: '**/provision.fixture.ts',
  reporter: [provision({
    providers: [userProvider, counterProvider],
    concurrency: { total: 2, prefetch: 1 },
    prefetchRetries: true,
  })],
  retries: 1,
  workers: 2,
})
