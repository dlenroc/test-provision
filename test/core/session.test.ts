import { beforeEach, expect, test, vi } from 'vitest'

const rpc = vi.hoisted(() => {
  const connections: Array<{
    breakConnection(): void
    [Symbol.dispose](): void
  }> = []
  const newWebSocketRpcSession = vi.fn((_url: string) => {
    let onBroken: () => void = () => {}
    const connection = {
      onRpcBroken(callback: () => void) { onBroken = callback },
      [Symbol.dispose]: vi.fn(),
      breakConnection() { onBroken() },
    }
    connections.push(connection)
    return connection
  })
  return { connections, newWebSocketRpcSession }
})

vi.mock('capnweb', () => ({ newWebSocketRpcSession: rpc.newWebSocketRpcSession }))

import { getSession } from '../../src/core/session.js'

beforeEach(() => {
  rpc.connections.length = 0
  rpc.newWebSocketRpcSession.mockClear()
})

test('RPC sessions are reused until the connection breaks', () => {
  const first = getSession('ws://runner/first')

  expect(getSession('ws://runner/first')).toBe(first)
  expect(rpc.newWebSocketRpcSession).toHaveBeenCalledTimes(1)

  rpc.connections[0].breakConnection()
  const replacement = getSession('ws://runner/first')

  expect(replacement).not.toBe(first)
  expect(rpc.connections[0][Symbol.dispose]).toHaveBeenCalledOnce()
  expect(rpc.newWebSocketRpcSession).toHaveBeenCalledTimes(2)
})

test('a stale disconnect cannot remove a newer session', () => {
  const first = getSession('ws://runner/second')
  const old = rpc.connections.at(-1)!
  old.breakConnection()
  const replacement = getSession('ws://runner/second')

  old.breakConnection()

  expect(getSession('ws://runner/second')).toBe(replacement)
  expect(replacement).not.toBe(first)
})
