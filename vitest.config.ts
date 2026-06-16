import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Unit tests run in Node with a mocked Stripe client.
    // TODO(HID-267): add a workerd project via @cloudflare/vitest-pool-workers
    // to verify createFetchHttpClient is applied on the edge runtime.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
