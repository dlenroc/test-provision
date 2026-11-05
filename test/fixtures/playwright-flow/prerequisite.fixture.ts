import { test } from '@playwright/test'
import { mark } from '../../helpers/trace.js'

test('completes prerequisite project', () => {
  mark('prerequisite:ran')
})
