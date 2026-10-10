import type { Context, MiddlewareHandler } from 'hono'
import { env } from 'hono/adapter'
import type Stripe from 'stripe'
import { getStripeClient } from './runtime'
import type { StripeMiddlewareOptions } from './types'
import { constructVerifiedEvent, verifyStripeSignature } from './webhook'
import type { VerifyStripeSignatureOptions } from './webhook'
import type { StripeEventStore } from './dedupe'

export { verifyStripeSignature }
export type { VerifyStripeSignatureOptions }
export { memoryEventStore, kvEventStore } from './dedupe'
export type { StripeEventStore, KVNamespaceLike } from './dedupe'

const DEFAULT_WEBHOOK_SECRET_VAR = 'STRIPE_WEBHOOK_SECRET'
const DEFAULT_API_KEY_VAR = 'STRIPE_SECRET_KEY'
// Stripe retries deliveries for up to ~3 days; keep processed ids that long.
const DEFAULT_DEDUPE_TTL_SECONDS = 3 * 24 * 60 * 60

/** All event type literals known to the installed stripe SDK. */
export type StripeEventType = Stripe.Event['type']

/**
 * A `Stripe.Event` narrowed to the member matching event type `K`, so
 * `data.object` carries the concrete resource type (e.g.
 * `Stripe.PaymentIntent` for `'payment_intent.succeeded'`).
 *
 * On stripe >= 18 `Stripe.Event` is a discriminated union and this narrows
 * fully; on older peer versions it degrades gracefully to `Stripe.Event`.
 */
export type TypedStripeEvent<K extends StripeEventType> = [
  Extract<Stripe.Event, { type: K }>,
] extends [never]
  ? Stripe.Event
  : Extract<Stripe.Event, { type: K }>

export type StripeWebhookHandler<E extends Stripe.Event = Stripe.Event> = (
  event: E,
  c: Context,
) => void | Response | Promise<void | Response>

/**
 * Per-event-type handlers. `event.data.object` is narrowed for every event
 * type the installed stripe SDK knows.
 *
 * @example
 * ```ts
 * stripeWebhook({
 *   on: {
 *     'payment_intent.succeeded': (event) => {
 *       event.data.object.amount // typed as Stripe.PaymentIntent
 *     },
 *   },
 * })
 * ```
 */
export type StripeWebhookHandlers = {
  [K in StripeEventType]?: StripeWebhookHandler<TypedStripeEvent<K>>
}

/**
 * Combine per-event-type handler maps, preserving every handler. When the
 * same event type appears in multiple maps, handlers run in argument order
 * and the first non-undefined return value becomes the response. Useful for
 * layering `billing.handlers` under your own:
 *
 * @example
 * ```ts
 * stripeWebhook({
 *   on: mergeWebhookHandlers(billing.handlers, {
 *     'checkout.session.completed': fulfill,
 *   }),
 * })
 * ```
 */
export const mergeWebhookHandlers = (
  ...maps: StripeWebhookHandlers[]
): StripeWebhookHandlers => {
  const merged: Record<string, StripeWebhookHandler | undefined> = {}
  for (const map of maps) {
    for (const [key, handler] of Object.entries(map)) {
      const prev = merged[key]
      // Same narrowing caveat as the dispatch site: handlers are keyed by
      // event-type literal, so the merged slot holds a narrowed handler.
      const next = handler as StripeWebhookHandler | undefined
      merged[key] = prev
        ? async (event, c) => (await prev(event, c)) ?? (await next?.(event, c))
        : next
    }
  }
  return merged as StripeWebhookHandlers
}

export interface StripeWebhookOptions
  extends Pick<StripeMiddlewareOptions, 'apiVersion' | 'config'> {
  /**
   * Webhook signing secret (`whsec_...`). A string, or a function called per
   * request (e.g. to read a per-tenant secret). Falls back to the env binding /
   * `process.env` key named by {@link StripeWebhookOptions.webhookSecretVar}.
   */
  secret?: string | ((c: Context) => string | Promise<string>)
  /**
   * Env binding / `process.env` key holding the webhook signing secret.
   * Default: `STRIPE_WEBHOOK_SECRET`. Ignored when `secret` is set.
   */
  webhookSecretVar?: string
  /**
   * API key used to build a Stripe client for signature verification when no
   * client is on the context. Falls back to the env binding / `process.env` key
   * named by {@link StripeWebhookOptions.apiKeyVar}. Unnecessary when
   * `stripeMiddleware()` runs before this middleware.
   */
  apiKey?: string
  /**
   * Env binding / `process.env` key holding the API key for the verification
   * client. Default: `STRIPE_SECRET_KEY`.
   */
  apiKeyVar?: string
  /** Header carrying the signature. Default: `stripe-signature`. */
  signatureHeader?: string
  /** Allowed timestamp tolerance in seconds. Defaults to Stripe's value (300s). */
  tolerance?: number
  /** Typed per-event-type handlers. */
  on: StripeWebhookHandlers
  /**
   * Fallback for verified events with no matching handler in `on`. Default:
   * respond `200 { "received": true }` — the correct acknowledgement for
   * events you don't care about (a non-2xx makes Stripe retry).
   */
  onUnhandled?: (event: Stripe.Event, c: Context) => Response | Promise<Response>
  /**
   * Store for processed event ids — or a function returning one per request.
   * The function form exists because Cloudflare Workers env bindings (KV
   * namespaces) only exist at request time, not at route registration:
   * `dedupe: (c) => kvEventStore(c.env.STRIPE_EVENTS)`.
   *
   * When set, a second delivery of the same `event.id` short-circuits to
   * `200 { "received": true, "duplicate": true }` without invoking the
   * handler. The id is recorded only when the outcome is a 2xx-equivalent
   * acknowledgement (no return value, or a returned 2xx `Response`) — a
   * handler that throws or returns a non-2xx `Response` leaves the event
   * unrecorded so Stripe's retry re-runs it. See `memoryEventStore` /
   * `kvEventStore`.
   */
  dedupe?: StripeEventStore | ((c: Context) => StripeEventStore)
  /**
   * Retention for recorded event ids, in seconds. Default: 259200 (3 days —
   * Stripe's maximum retry window).
   */
  dedupeTtlSeconds?: number
}

const resolveWebhookSecret = async (
  c: Context,
  options: StripeWebhookOptions,
): Promise<string> => {
  const explicit =
    typeof options.secret === 'function' ? await options.secret(c) : options.secret
  if (explicit) return explicit
  const secretVar = options.webhookSecretVar ?? DEFAULT_WEBHOOK_SECRET_VAR
  const fromEnv = env<Record<string, string | undefined>>(c)[secretVar]
  if (!fromEnv) {
    throw new Error(
      `hono-stripe: webhook signing secret not found. Pass { secret } or set the "${secretVar}" env binding / process.env value.`,
    )
  }
  return fromEnv
}

/**
 * Signature verification needs a Stripe client but no network access, so when
 * `stripeMiddleware()` has not run we lazily build one from `apiKey` /
 * `STRIPE_SECRET_KEY` (cached in the shared client cache).
 */
const resolveStripeClient = (c: Context, options: StripeWebhookOptions): Stripe => {
  const existing = c.get('stripe') as Stripe | undefined
  if (existing) return existing
  const apiKeyVar = options.apiKeyVar ?? DEFAULT_API_KEY_VAR
  const apiKey = options.apiKey ?? env<Record<string, string | undefined>>(c)[apiKeyVar]
  if (!apiKey) {
    throw new Error(
      `hono-stripe: no Stripe client on context. Register stripeMiddleware(), or pass { apiKey } / set the "${apiKeyVar}" env value so a verification client can be built.`,
    )
  }
  return getStripeClient(apiKey, { apiVersion: options.apiVersion, config: options.config })
}

/**
 * Webhook middleware that verifies the Stripe signature and dispatches the
 * event to a typed per-event-type handler.
 *
 * - Verification uses `constructEventAsync`, so it works on Cloudflare
 *   Workers and Node alike. Bad/missing signatures respond 400.
 * - Handlers keyed by event type get a narrowed `event.data.object` (the
 *   stripe SDK discriminates `Stripe.Event` by `type`). A handler may return a
 *   `Response` (used verbatim) or nothing (`200 { "received": true }`).
 * - With `dedupe` set, repeat deliveries of the same `event.id` are
 *   acknowledged without re-invoking the handler.
 * - A handler that throws produces a 500 (via Hono's error handling), which
 *   correctly makes Stripe retry the delivery.
 *
 * @example
 * ```ts
 * app.post(
 *   '/webhook',
 *   stripeWebhook({
 *     dedupe: (c) => kvEventStore(c.env.STRIPE_EVENTS), // Workers KV binding
 *     on: {
 *       'payment_intent.succeeded': (event) => {
 *         console.log('paid', event.data.object.id)
 *       },
 *       'checkout.session.completed': async (event, c) => {
 *         await fulfill(event.data.object)
 *       },
 *     },
 *   }),
 * )
 * ```
 */
export const stripeWebhook = (options: StripeWebhookOptions): MiddlewareHandler => {
  return async (c) => {
    const secret = await resolveWebhookSecret(c, options)
    const stripe = resolveStripeClient(c, options)
    const event = await constructVerifiedEvent(stripe, c, {
      secret,
      signatureHeader: options.signatureHeader,
      tolerance: options.tolerance,
    })

    const store =
      typeof options.dedupe === 'function' ? options.dedupe(c) : options.dedupe
    if (store && (await store.has(event.id))) {
      return c.json({ received: true, duplicate: true })
    }

    // The handler map is typed per event literal; at the dispatch site the
    // event is only known as Stripe.Event, so the narrowed handler signature
    // cannot be proven — but `on` keys are exactly `event.type` values.
    const handler = options.on[event.type] as StripeWebhookHandler | undefined
    const result = handler
      ? await handler(event, c)
      : await options.onUnhandled?.(event, c)

    // Record the event id only when the outcome is what Stripe treats as
    // acknowledged (2xx). A thrown error already skips this via propagation,
    // but a handler that *returns* a non-2xx Response must also not be
    // recorded — otherwise Stripe's retry arrives, hits the dedupe store,
    // and is acknowledged as a duplicate without the handler re-running.
    const acknowledged =
      result === undefined ||
      (result instanceof Response && result.status >= 200 && result.status < 300)
    if (store && acknowledged) {
      await store.put(event.id, options.dedupeTtlSeconds ?? DEFAULT_DEDUPE_TTL_SECONDS)
    }
    return result instanceof Response ? result : c.json({ received: true })
  }
}
