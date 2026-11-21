import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          // Unit tests run in Node with a mocked Stripe client.
          // TODO(HID-267): add a workerd project via @cloudflare/vitest-pool-workers
          // to verify createFetchHttpClient is applied on the edge runtime.
          environment: 'node',
          include: ['test/**/*.test.{ts,tsx}'],
          exclude: ['test/integration/**'],
        },
      },
      {
        test: {
          name: 'integration',
          // Integration tests drive the real stripe-node SDK over HTTP against
          // stripe-mock (https://github.com/stripe/stripe-mock). The global setup
          // fails the run up front when stripe-mock is not reachable.
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
        },
      },
    ],
  },
})
