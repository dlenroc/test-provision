import { provision } from '@dlenroc/test-provision/vitest/plugin'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import { counterProvider, userProvider } from '../../helpers/providers.js'

const browser = process.env.PROVISION_TEST_BROWSER === '1'

export default defineConfig({
  plugins: [provision({
    providers: [userProvider, counterProvider],
    concurrency: { total: 2, prefetch: 1 },
    prefetchRetries: true,
    precollect: !browser,
  })],
  test: {
    include: ['test/fixtures/vitest/provision.fixture.ts'],
    browser: {
      enabled: browser,
      headless: true,
      screenshotFailures: false,
      traceView: false,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
})
