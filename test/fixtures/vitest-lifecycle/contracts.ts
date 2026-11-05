import { resource } from '@dlenroc/test-provision'

export const account = resource<{ mode: 'timeout' | 'recover' | 'conditional' | 'expected' | 'repeat' }, { attempt: number }>('account')
