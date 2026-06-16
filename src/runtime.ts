import { getRuntimeKey } from 'hono/adapter'
import Stripe from 'stripe'
import type { StripeMiddlewareOptions } from './types'

/**
 * The Stripe client config type (second constructor argument).
 *
 * `StripeConfig` is a top-level export of `stripe` rather than a member of the
 * `Stripe` namespace, so we derive it from the constructor to stay robust
 * across the supported peer range.
 */
export type StripeClientConfig = NonNullable<ConstructorParameters<typeof Stripe>[1]>

/**
 * True when running on a Node.js runtime.
 *
 * Delegates to Hono's `getRuntimeKey()` so this stays consistent with the
 * runtime detection used by `env()` for secret-key resolution.
 */
export const isNodeRuntime = (): boolean => getRuntimeKey() === 'node'

/**
 * True when running on Cloudflare Workers (`workerd`).
 */
export const isWorkersRuntime = (): boolean => getRuntimeKey() === 'workerd'

/**
 * Whether the Stripe SDK should use the Fetch-based HTTP client.
 *
 * On Cloudflare Workers (and other non-Node edge runtimes) the default Node
 * `http`/`https` client is unavailable, so Stripe must be initialized with
 * `Stripe.createFetchHttpClient()`. This is the single most common "gotcha"
 * when running stripe-node on the edge, and hono-stripe handles it for you.
 */
export const shouldUseFetchHttpClient = (): boolean => !isNodeRuntime()

// One Stripe client per unique (key + config) — reused across requests.
const clientCache = new Map<string, Stripe>()

// SubtleCrypto provider is required for async webhook verification on the edge.
let cryptoProvider: ReturnType<typeof Stripe.createSubtleCryptoProvider> | undefined

/**
 * Build the Stripe client config, applying the Fetch HTTP client automatically
 * on edge runtimes unless the caller supplied their own `httpClient`.
 */
const buildConfig = (options: StripeMiddlewareOptions): StripeClientConfig => {
  const config: StripeClientConfig = { ...options.config }
  if (options.apiVersion) {
    config.apiVersion = options.apiVersion
  }
  if (!config.httpClient && shouldUseFetchHttpClient()) {
    config.httpClient = Stripe.createFetchHttpClient()
  }
  return config
}

/**
 * Build the cache key from the secret key and the options that affect client
 * construction, so the same key initialized with different config does not
 * silently reuse the first client.
 */
const getCacheKey = (apiKey: string, options: StripeMiddlewareOptions): string => {
  try {
    return `${apiKey}:${JSON.stringify({ apiVersion: options.apiVersion, config: options.config })}`
  } catch {
    // config may hold non-serializable values (e.g. a custom httpClient); fall
    // back to keying by apiKey alone rather than throwing.
    return apiKey
  }
}

/**
 * Get (or lazily create and cache) a Stripe client for the given secret key
 * and options.
 */
export const getStripeClient = (apiKey: string, options: StripeMiddlewareOptions): Stripe => {
  const cacheKey = getCacheKey(apiKey, options)
  const cached = clientCache.get(cacheKey)
  if (cached) return cached
  const client = new Stripe(apiKey, buildConfig(options))
  clientCache.set(cacheKey, client)
  return client
}

/**
 * Get (or lazily create) the shared SubtleCrypto provider used to verify
 * webhook signatures asynchronously on runtimes without Node crypto.
 */
export const getCryptoProvider = (): ReturnType<typeof Stripe.createSubtleCryptoProvider> => {
  if (!cryptoProvider) {
    cryptoProvider = Stripe.createSubtleCryptoProvider()
  }
  return cryptoProvider
}

/** Test-only: reset the internal caches. */
export const __resetCaches = (): void => {
  clientCache.clear()
  cryptoProvider = undefined
}
