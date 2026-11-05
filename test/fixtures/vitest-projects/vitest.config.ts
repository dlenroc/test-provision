import { defineConfig } from 'vitest/config'
import { provision } from '@dlenroc/test-provision/vitest/plugin'
import { counterProvider, userProvider } from '../../helpers/providers.js'

export default defineConfig({
  plugins: [provision({ providers: [userProvider, counterProvider], concurrency: { total: 2, prefetch: 1 } })],
  test: {
    projects: [
      { extends: true, test: { name: 'first', include: ['test/fixtures/vitest-projects/provision.fixture.ts'] } },
      { extends: true, test: { name: 'second', include: ['test/fixtures/vitest-projects/provision.fixture.ts'] } },
    ],
  },
})
