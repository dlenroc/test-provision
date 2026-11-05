import { expect, test as base } from 'vitest'
import { needs, withResources } from '@dlenroc/test-provision/vitest'
import { account, shared } from './contracts.js'

const test = withResources(base)

for (const accountName of ['alice', 'bob']) {
  test(`uses prepared account ${accountName}`, {
    meta: { provision: needs(account(accountName, {})) },
  }, async ({ prepared }) => {
    const accountResource = prepared(account, accountName)
    const counter = await prepared(shared).next()

    expect(['recovered', 'updated']).toContain(accountResource.run)
    expect(counter).toBeGreaterThan(0)
  })
}
