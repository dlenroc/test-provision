import { expect, test } from 'vitest'
import { Coordinator } from '../../src/core/coordinator.js'
import { RpcServer } from '../../src/core/server.js'

test('the provisioning RPC server rejects clients without its session token', async () => {
  const coordinator = new Coordinator([])
  const server = new RpcServer(() => coordinator)
  await server.start()

  try {
    const unauthorized = new URL(server.url!)
    unauthorized.pathname = '/invalid-token'
    const socket = new WebSocket(unauthorized)
    try {
      const code = await new Promise<number>((resolve, reject) => {
        socket.addEventListener('close', event => resolve(event.code), { once: true })
        socket.addEventListener('error', reject, { once: true })
      })
      expect(code).toBe(1008)
    } finally {
      socket.close()
    }
  } finally {
    await server.close()
    await coordinator.close()
  }
})
