import type Stripe from 'stripe'

/**
 * Testing utilities: build Stripe webhook requests with valid signatures, no
 * `stripe listen`, no Stripe client, no network.
 *
 * The signing scheme is Stripe's documented `t=<ts>,v1=<hmac-sha256>` over
 * `${t}.${payload}`, implemented with WebCrypto (`crypto.subtle`) so it runs on
 * Node, Workers, Deno, Bun — anywhere Hono runs. Signatures produced here pass
 * `stripe.webhooks.constructEventAsync`.
 *
 * @example
 * ```ts
 * const req = await createWebhookRequest(
 *   createTestEvent('payment_intent.succeeded', { id: 'pi_1', amount: 1400 }),
 *   { secret: 'whsec_test' },
 * )
 * const res = await app.request(req)
 * ```
 */

const encoder = new TextEncoder()

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')

const requireSubtleCrypto = (): SubtleCrypto => {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error(
      'hono-stripe/testing: crypto.subtle is not available in this runtime; webhook fixtures cannot be signed.',
    )
  }
  return subtle
}

/**
 * Produce a `Stripe-Signature` header value (`t=...,v1=...`) for `payload`.
 *
 * @param timestamp Unix seconds. Defaults to now — override to test tolerance
 * handling (e.g. a timestamp older than 300s should fail verification).
 */
export const signStripePayload = async (
  payload: string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<string> => {
  const key = await requireSubtleCrypto().importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await requireSubtleCrypto().sign(
    'HMAC',
    key,
    encoder.encode(`${timestamp}.${payload}`),
  )
  return `t=${timestamp},v1=${toHex(signature)}`
}

export interface TestEventOptions {
  /** Event id. Default: `evt_test_<uuid>`. */
  id?: string
  /** `created` timestamp (Unix seconds). Default: now. */
  created?: number
  /** Default: false. */
  livemode?: boolean
  /** `previous_attributes` on `event.data`. */
  previousAttributes?: Record<string, unknown>
  /** `api_version` field. Default: null. */
  apiVersion?: string | null
  /** `request` field. Default: `{ id: null, idempotency_key: null }`. */
  request?: Stripe.Event['request']
  /** `pending_webhooks` count. Default: 1. */
  pendingWebhooks?: number
}

/** A `Stripe.Event` whose `data.object` carries the type of the fixture object. */
export type TestStripeEvent<O extends object> = Omit<Stripe.Event, 'data'> & {
  data: Omit<Stripe.Event['data'], 'object'> & { object: O }
}

/**
 * Build a fake `Stripe.Event`-shaped object around a `data.object` payload.
 *
 * Pass as much of the resource as your handler needs — the fixture is not
 * validated against Stripe's schema. For a fully-typed object, shape it to the
 * resource type (e.g. `Partial<Stripe.PaymentIntent>`).
 */
export const createTestEvent = <O extends object>(
  type: Stripe.Event['type'],
  object: O,
  options: TestEventOptions = {},
): TestStripeEvent<O> => ({
  id: options.id ?? `evt_test_${globalThis.crypto.randomUUID()}`,
  object: 'event',
  api_version: options.apiVersion ?? null,
  created: options.created ?? Math.floor(Date.now() / 1000),
  data: { object, previous_attributes: options.previousAttributes },
  livemode: options.livemode ?? false,
  pending_webhooks: options.pendingWebhooks ?? 1,
  request: options.request ?? { id: null, idempotency_key: null },
  type,
})

export interface CreateWebhookRequestOptions {
  /** Endpoint signing secret — must match what the app verifies against. */
  secret: string
  /** Request URL. Default: `http://localhost/webhook`. */
  url?: string | URL
  /** Signature timestamp (Unix seconds). Default: now. */
  timestamp?: number
  /** Extra request headers (merged after the signature header is set). */
  headers?: HeadersInit
}

/**
 * Wrap a payload in a `Request` with a valid `Stripe-Signature` header —
 * ready for `app.request(req)` in tests or a `fetch` against local dev.
 *
 * `event` may be a `createTestEvent` result, any object (JSON.stringify'd), or
 * a pre-serialized payload string — the signature covers the exact bytes sent.
 */
export const createWebhookRequest = async (
  event: object | string,
  options: CreateWebhookRequestOptions,
): Promise<Request> => {
  const payload = typeof event === 'string' ? event : JSON.stringify(event)
  const signature = await signStripePayload(payload, options.secret, options.timestamp)
  return new Request(options.url ?? 'http://localhost/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
      ...options.headers,
    },
    body: payload,
  })
}
