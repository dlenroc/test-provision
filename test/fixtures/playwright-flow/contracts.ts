import { provider, resource } from '@dlenroc/test-provision'
import { mark, waitFor } from '../../helpers/trace.js'

export const slowAccount = resource<{}, string>('slow-account')
export const cleanupAccount = resource<{}, string>('cleanup-account')
export const teardownAccount = resource<{}, string>('teardown-account')

export const slowAccountProvider = provider(slowAccount, async () => {
  mark('prepare:started')
  await waitFor('independent:ran')
  mark('prepare:finished')
  return 'ready'
})

export const cleanupAccountProvider = provider(cleanupAccount, (_input, { onCleanup }) => {
  onCleanup(async () => {
    mark('cleanup:started')
    await waitFor('next-test:ran')
    mark('cleanup:finished')
  })
  return 'ready'
})

export const teardownAccountProvider = provider(teardownAccount, (_input, { onCleanup }) => {
  mark('teardown:prepare')
  onCleanup(() => mark('teardown:cleanup'))
  return 'ready'
})
