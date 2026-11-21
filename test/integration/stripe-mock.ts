/**
 * Connection settings for stripe-mock, shared by the integration tests.
 *
 * Defaults match `stripe/stripe-mock`'s HTTP port. Override with
 * STRIPE_MOCK_HOST / STRIPE_MOCK_PORT (CircleCI runs it as a secondary
 * container on localhost).
 */
export const STRIPE_MOCK_HOST = process.env.STRIPE_MOCK_HOST ?? 'localhost'
export const STRIPE_MOCK_PORT = Number(process.env.STRIPE_MOCK_PORT ?? '12111')
export const STRIPE_MOCK_URL = `http://${STRIPE_MOCK_HOST}:${STRIPE_MOCK_PORT}`

/** stripe-mock accepts any "valid looking" test-mode secret key. */
export const TEST_KEY = 'sk_test_123'

/** Stripe client `config` that points the SDK at stripe-mock. */
export const stripeMockConfig = () => ({
  host: STRIPE_MOCK_HOST,
  port: STRIPE_MOCK_PORT,
  protocol: 'http' as const,
  // Fail fast: retries only slow the error-path tests down.
  maxNetworkRetries: 0,
})
