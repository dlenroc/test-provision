import { expect, test as base } from 'vitest'
import { needs, withResources } from '@dlenroc/test-provision/vitest'
import { counter, user } from '../../helpers/contracts.js'

const test = withResources(base)

test('each project receives its own allocation and the common service', {
  meta: { provision: needs(user('account', { name: 'Project' })) },
}, async ({ prepared }) => {
  const resource = prepared(user, 'account')
  expect(resource.name).toBe('Project')
  expect(await resource.greet('Ada')).toBe('Hello Ada')
  expect(await prepared(counter).next()).toBeGreaterThan(0)
})
