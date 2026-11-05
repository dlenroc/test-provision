import { expect, test as base } from 'vitest'
import { needs, withResources } from '@dlenroc/test-provision/vitest'
import { mark } from '../../helpers/trace.js'
import { account } from './contracts.js'

const test = withResources(base, { timeout: 300 })

test.fails('cancels preparation after its fixture timeout', {
  meta: { provision: needs(account('user', { mode: 'timeout' })) },
}, () => {
  mark('timeout:body')
})

test('retries with a new allocation after preparation times out', {
  retry: 1,
  meta: { provision: needs(account('user', { mode: 'recover' })) },
}, ({ prepared, task }) => {
  mark(`recover:test:${task.result?.retryCount ?? 0}`)

  expect(prepared(account, 'user')).toEqual({ attempt: 2 })
})

test('retries when the error matches the condition', {
  retry: { count: 1, condition: /RETRY_ME/ },
  meta: { provision: needs(account('user', { mode: 'conditional' })) },
}, ({ prepared, task }) => {
  mark(`conditional:test:${task.result?.retryCount ?? 0}`)
  if (!task.result?.retryCount) throw new Error('RETRY_ME')

  expect(prepared(account, 'user')).toEqual({ attempt: 2 })
})

test.fails('expected failures do not trigger another allocation', {
  retry: 1,
  meta: { provision: needs(account('user', { mode: 'expected' })) },
}, ({ prepared }) => {
  expect(prepared(account, 'user')).toEqual({ attempt: 1 })
  throw new Error('EXPECTED_FAILURE')
})


test('repeated runs each receive a fresh allocation', {
  repeats: 1,
  meta: { provision: needs(account('user', { mode: 'repeat' })) },
}, ({ prepared }) => {
  const { attempt } = prepared(account, 'user')
  mark(`repeat:test:${attempt}`)
  expect(attempt).toBeGreaterThan(0)
})
