import { defineConfig } from '@playwright/test'
import { provision } from '@dlenroc/test-provision/playwright/reporter'
import { slowAccountProvider, cleanupAccountProvider, teardownAccountProvider } from './contracts.js'

export default defineConfig({
  testDir: '.',
  projects: [
    { name: 'prerequisite', testMatch: '**/prerequisite.fixture.ts' },
    { name: 'dependent', dependencies: ['prerequisite'], teardown: 'teardown', testMatch: [
      '**/dependent.fixture.ts', '**/cleanup.fixture.ts', '**/independent.fixture.ts',
    ] },
    { name: 'teardown', testMatch: '**/teardown.fixture.ts' },
  ],
  workers: 3,
  reporter: [provision({
    providers: [slowAccountProvider, cleanupAccountProvider, teardownAccountProvider],
    concurrency: { total: 3, prefetch: 2 },
  })],
})
