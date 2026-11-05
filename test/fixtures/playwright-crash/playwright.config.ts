import { defineConfig } from '@playwright/test'
import { provision } from '@dlenroc/test-provision/playwright/reporter'
import { counterProvider, userProvider } from '../../helpers/providers.js'

export default defineConfig({
  testDir: '.',
  testMatch: '**/provision.fixture.ts',
  workers: 1,
  retries: 0,
  reporter: [provision({ providers: [userProvider, counterProvider] })],
})
