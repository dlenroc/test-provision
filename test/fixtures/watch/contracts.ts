import { resource, service } from '@dlenroc/test-provision'

export const account = resource<{}, { run: string }>('watch.account')
export const shared = service<{ next(): number }>('watch.shared')
