import { test } from '@playwright/test'
import { mark, waitFor } from '../../helpers/trace.js'

test('runs while another test is provisioning', async () => {
  await waitFor('prepare:started')
  mark('independent:ran')
})
