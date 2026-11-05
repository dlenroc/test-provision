export const deferred = <T = void>() => Promise.withResolvers<T>()

/** Releases a deliberately blocked provider even if the test fails. */
export function gate() {
  const { promise, resolve } = deferred()
  return { promise, release: resolve, [Symbol.dispose]: resolve }
}

export const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))

export async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  const { promise, reject } = deferred<never>()
  using _deadline = setTimeout(() => reject(new Error('Timed out waiting for test event')), 3_000)
  return await Promise.race([operation, promise])
}
