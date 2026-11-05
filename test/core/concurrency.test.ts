import { expect, test } from 'vitest'
import { provider, resource } from '../../src/index.js'
import { collectRequirements } from '../../src/core/contract.js'
import { Coordinator } from '../../src/core/coordinator.js'
import { gate, nextTurn, withTimeout } from '../helpers/sync.ts'

test('mixed cancellation and delivery clean up every started allocation exactly once', async () => {
  const account = resource<{ group: number }, { id: number }>('account')

  // Repeat several controlled interleavings, not elapsed-time-dependent races.
  for (let round = 0; round < 9; round++) {
    let created = 0
    let active = 0
    let peak = 0
    const cleaned: number[] = []
    const finishCreation = gate()
    const coordinator = new Coordinator([
      provider(account, async (_input, { onCleanup }) => {
        const id = ++created
        active++
        peak = Math.max(peak, active)
        onCleanup(() => { cleaned.push(id) })
        try {
          // Hold the first wave until cancellation choices are final.
          await finishCreation.promise
          if ((id + round) % 2 === 0) await nextTurn()
          return { id }
        } finally {
          active--
        }
      }),
    ], { concurrency: { total: 1 + (round % 3), prefetch: 0 } })

    try {
      const attempts = Array.from({ length: 18 }, (_, i) => {
        const allocation = coordinator.open(`round-${round}-test-${i}`, collectRequirements([
          account('user', { group: i % 3 }),
        ]), 0)
        const outcome = allocation.ready().then(
          result => ({ status: 'ready' as const, id: (result.values.user as { id: number }).id }),
          (error: unknown) => ({
            status: 'rejected' as const,
            error,
          }),
        )
        return { allocation, outcome }
      })
      const cancellations: Promise<void>[] = []
      const canceled = new Set<number>()
      for (let i = 0; i < attempts.length; i++) {
        if ((i + round) % 4 === 0) {
          canceled.add(i)
          cancellations.push(attempts[i].allocation.release())
        }
      }

      await nextTurn()
      for (let i = 0; i < attempts.length; i++) {
        if ((i + round) % 6 === 0 && !canceled.has(i)) {
          canceled.add(i)
          cancellations.push(attempts[i].allocation.release())
        }
      }

      finishCreation.release()
      const outcomes = await withTimeout(Promise.all(attempts.map(attempt => attempt.outcome)))
      const delivered = outcomes.flatMap(outcome => outcome.status === 'ready' ? [outcome.id] : [])
      expect(new Set(delivered).size).toBe(delivered.length)
      for (const [index, outcome] of outcomes.entries()) {
        if (canceled.has(index)) {
          expect(outcome.status).toBe('rejected')
          if (outcome.status === 'rejected') {
            expect(outcome.error).toBeInstanceOf(Error)
            expect((outcome.error as Error).message).toMatch(/cancel/i)
          }
        } else {
          expect(outcome.status).toBe('ready')
        }
      }

      await Promise.all([...cancellations, ...attempts.map(attempt => attempt.allocation.release())])
      await withTimeout(coordinator.close())

      expect(active).toBe(0)
      expect(peak).toBeLessThanOrEqual(1 + (round % 3))
      expect(cleaned.toSorted((a, b) => a - b)).toEqual(
        Array.from({ length: created }, (_, i) => i + 1),
      )
    } finally {
      finishCreation.release()
      await coordinator.close()
    }
  }
})
