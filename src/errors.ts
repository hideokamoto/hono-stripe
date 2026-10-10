import type { Context, ErrorHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import Stripe from 'stripe'
import { getDeclineMessage, isSoftDecline, type Locale } from 'stripe-decline-codes'

const { errors } = Stripe

/** Error body shape returned by {@link stripeErrorHandler}. */
export interface StripeErrorBody {
  error: {
    type: string
    /** Developer-facing message (Stripe's raw message — English, technical). */
    message: string
    /** Stripe error code / decline code when present. */
    code?: string
    /**
     * Localized, user-facing guidance for card declines — from
     * `stripe-decline-codes`. Only set on `card_error` when the decline code
     * is known and `locale` matched a translation.
     */
    userMessage?: string
    /**
     * For card declines: whether retrying as-is may succeed (soft decline).
     * `false` means the customer needs a different payment method.
     */
    retryable?: boolean
    /** Stripe request id — safe to surface, useful for support tickets. */
    requestId?: string
  }
}

const json = (c: Context, status: number, body: StripeErrorBody) =>
  c.json(body, status as never)

type StripeError = InstanceType<typeof Stripe.errors.StripeError>

/**
 * Map a `StripeError` to an HTTP response.
 *
 * - `StripeCardError` → 402 (message/decline_code are user-facing, safe;
 *   adds localized `userMessage` and `retryable` from stripe-decline-codes)
 * - `StripeInvalidRequestError` / `TemporarySessionExpiredError` → 400
 * - `StripeIdempotencyError` → 409
 * - `StripeSignatureVerificationError` → 400 (raised by `constructEvent` when
 *   it escapes our wrappers — e.g. raw SDK verification in user code)
 * - `StripeRateLimitError` / `RateLimitError` → 429
 * - `StripeConnectionError` / `StripeAPIError` → 502 (upstream failure)
 * - `StripeAuthenticationError` / `StripePermissionError` → 500 with a generic
 *   message — Stripe's raw message can leak account/key details
 * - Anything else with a client-error `statusCode` → that status; else 502
 */
export const stripeErrorResponse = (
  c: Context,
  err: StripeError,
  locale?: Locale,
): Response => {
  const body = (
    status: number,
    type: string,
    message: string,
    extra?: Partial<StripeErrorBody['error']>,
  ): Response =>
    json(c, status, {
      error: { type, message, requestId: err.requestId, ...extra },
    })

  if (err instanceof errors.StripeCardError) {
    const declineCode = err.decline_code ?? err.code
    return body(402, 'card_error', err.message, {
      code: declineCode,
      userMessage: declineCode ? getDeclineMessage(declineCode, locale) : undefined,
      retryable: declineCode ? isSoftDecline(declineCode) : undefined,
    })
  }
  if (
    err instanceof errors.StripeInvalidRequestError ||
    err instanceof errors.TemporarySessionExpiredError
  ) {
    return body(400, 'invalid_request', err.message, { code: err.code })
  }
  if (err instanceof errors.StripeIdempotencyError) {
    return body(409, 'idempotency_error', err.message, { code: err.code })
  }
  if (err instanceof errors.StripeSignatureVerificationError) {
    return body(400, 'signature_verification_failed', 'Webhook signature verification failed.')
  }
  if (err instanceof errors.StripeRateLimitError || err instanceof errors.RateLimitError) {
    return body(429, 'rate_limit', 'Stripe rate limit reached — retry the request.')
  }
  if (
    err instanceof errors.StripeConnectionError ||
    err instanceof errors.StripeAPIError
  ) {
    return body(502, 'stripe_unavailable', 'Stripe request failed upstream — safe to retry.')
  }
  if (
    err instanceof errors.StripeAuthenticationError ||
    err instanceof errors.StripePermissionError ||
    err instanceof errors.StripeOAuthError
  ) {
    return body(500, 'stripe_auth_error', 'Stripe integration is misconfigured.')
  }
  if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
    return body(err.statusCode, 'stripe_error', err.message, { code: err.code })
  }
  return body(502, 'stripe_error', 'Stripe request failed.')
}

export interface StripeErrorHandlerOptions {
  /**
   * Locale for card-decline `userMessage` — `'en'` (default) or `'ja'`,
   * resolved via `stripe-decline-codes`. Accepts a per-request function, e.g.
   * to follow the `Accept-Language` header:
   * `locale: (c) => c.req.header('accept-language')?.startsWith('ja') ? 'ja' : 'en'`
   */
  locale?: Locale | ((c: Context) => Locale | undefined)
  /**
   * Called for errors that are NOT `StripeError` (after HTTPException
   * passthrough). Default: generic `500 { error: { type: 'internal_error' } }`.
   */
  fallback?: (err: Error, c: Context) => Response | Promise<Response>
}

/**
 * Hono `onError` handler that maps Stripe SDK errors to the right HTTP status
 * instead of letting every Stripe failure become a 500 (or worse, a 500 that
 * Stripe webhooks then retry forever).
 *
 * Covers errors thrown anywhere in the app — route handlers calling
 * `getStripe(c)` directly, `stripeWebhook` handlers, the `/return` lookup —
 * not just a specific helper. HTTPExceptions (e.g. the 400s thrown by
 * `verifyStripeSignature`) pass through untouched.
 *
 * Card declines additionally carry `error.userMessage` (localized via
 * `stripe-decline-codes`) and `error.retryable` (soft-decline detection), so
 * clients can distinguish "try again" from "use another card".
 *
 * @example
 * ```ts
 * import { stripeErrorHandler } from 'hono-stripe'
 * app.onError(stripeErrorHandler({ locale: 'ja' }))
 * ```
 */
export const stripeErrorHandler = (options?: StripeErrorHandlerOptions): ErrorHandler => {
  return (err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    if (err instanceof errors.StripeError) {
      const locale =
        typeof options?.locale === 'function' ? options.locale(c) : options?.locale
      return stripeErrorResponse(c, err, locale)
    }
    if (options?.fallback) return options.fallback(err, c)
    return json(c, 500, {
      error: { type: 'internal_error', message: 'Internal server error' },
    })
  }
}
