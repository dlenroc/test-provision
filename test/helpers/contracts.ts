import { resource, service } from '@dlenroc/test-provision'

export const user = resource<{ name: string }, {
  id: number
  name: string
  greet(name: string): string
  markUsed(retry: number): void
}>('test.user')

export const counter = service<{ next(): number }>('test.counter')
