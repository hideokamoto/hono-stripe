import { STRIPE_MOCK_URL, TEST_KEY } from './stripe-mock'

/**
 * Fail the integration run immediately (instead of skipping) when stripe-mock
 * is not reachable, so a missing service can never produce a green build.
 */
export default async function setup(): Promise<void> {
  const url = `${STRIPE_MOCK_URL}/v1/customers`
  let status: number | string
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${TEST_KEY}` } })
    status = res.status
  } catch (err) {
    status = err instanceof Error ? err.message : String(err)
  }
  if (status !== 200) {
    throw new Error(
      `stripe-mock is not reachable at ${STRIPE_MOCK_URL} (GET /v1/customers → ${status}). ` +
        'Start it first, e.g. `docker run --rm -p 12111-12112:12111-12112 stripe/stripe-mock:v0.206.0`, ' +
        'or set STRIPE_MOCK_HOST / STRIPE_MOCK_PORT.',
    )
  }
}
