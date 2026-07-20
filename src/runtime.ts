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

// Maximum number of Stripe clients retained. Bounds memory (and retained
// secrets) in multi-tenant / key-rotation setups where many distinct secret
// keys flow through the middleware over the process lifetime.
const MAX_CACHE_ENTRIES = 100

// One Stripe client per unique (key + config) — reused across requests.
// Insertion order is significant: `Map` preserves it, so the first-inserted
// entry is the oldest and is evicted first (FIFO) once the cap is exceeded.
const clientCache = new Map<string, Stripe>()

// Stable per-options-object identity token, keyed by object identity. Lets the
// cache key distinguish two options objects whose `config` is non-serializable
// or otherwise not comparable via `JSON.stringify` (e.g. a custom `httpClient`),
// while a repeated call with the same options object reuses its token without
// re-serializing. A `WeakMap` lets tokens be GC'd alongside their options.
let optionsTokens = new WeakMap<object, string>()
let optionsTokenSeq = 0

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
 * Whether a config carries values that a JSON representation cannot faithfully
 * compare, so keying by its serialized form would let distinct configs collide.
 *
 * A custom `httpClient` is a runtime object/class instance whose *identity*
 * (not its often-empty enumerable shape) determines behavior — two different
 * clients both serialize to the same string — so its mere presence is treated
 * as non-serializable. Function-valued config is likewise flagged because
 * `JSON.stringify` silently drops functions.
 */
const hasNonSerializableConfig = (config: StripeClientConfig): boolean => {
  if (config.httpClient !== undefined) return true
  return Object.values(config).some((value) => typeof value === 'function')
}

/**
 * Compute a stable token identifying the client-construction inputs of an
 * options object.
 *
 * For plainly serializable options the token is the JSON form, so two distinct
 * but equivalent options objects share a client. When `config` is
 * non-serializable (custom `httpClient`, functions) or `JSON.stringify` throws
 * (e.g. circular refs), a unique token is minted instead, so such options never
 * collide with one another.
 */
const computeOptionsToken = (options: StripeMiddlewareOptions): string => {
  const { apiVersion, config } = options
  if (config && hasNonSerializableConfig(config)) {
    return `#${++optionsTokenSeq}`
  }
  try {
    return JSON.stringify({ apiVersion, config })
  } catch {
    return `#${++optionsTokenSeq}`
  }
}

/**
 * Build the cache key from the secret key and the options that affect client
 * construction, so the same key initialized with different config does not
 * silently reuse the first client.
 *
 * The per-options token is memoized in a `WeakMap` keyed by the options object
 * identity: the same options object (the common per-middleware case) reuses its
 * token without re-running `JSON.stringify` on every request.
 */
const getCacheKey = (apiKey: string, options: StripeMiddlewareOptions): string => {
  let token = optionsTokens.get(options)
  if (token === undefined) {
    token = computeOptionsToken(options)
    optionsTokens.set(options, token)
  }
  return `${apiKey}:${token}`
}

/**
 * Get (or lazily create and cache) a Stripe client for the given secret key
 * and options. The cache is bounded to {@link MAX_CACHE_ENTRIES}; the oldest
 * entry is evicted (FIFO) when the cap would be exceeded.
 *
 * `options` is typed as required, but this is also a public entry point that
 * an untyped JS caller can invoke with `undefined`/`null`. Normalize to `{}`
 * up front so that never reaches the `WeakMap` used internally, which throws
 * on a non-object key.
 */
export const getStripeClient = (apiKey: string, options: StripeMiddlewareOptions): Stripe => {
  const opts = options ?? {}
  const cacheKey = getCacheKey(apiKey, opts)
  const cached = clientCache.get(cacheKey)
  if (cached) return cached
  const client = new Stripe(apiKey, buildConfig(opts))
  clientCache.set(cacheKey, client)
  if (clientCache.size > MAX_CACHE_ENTRIES) {
    const oldest = clientCache.keys().next().value
    if (oldest !== undefined) clientCache.delete(oldest)
  }
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

/** Test-only: current number of cached Stripe clients. */
export const __cacheSize = (): number => clientCache.size

/** Test-only: reset the internal caches. */
export const __resetCaches = (): void => {
  clientCache.clear()
  optionsTokens = new WeakMap<object, string>()
  optionsTokenSeq = 0
  cryptoProvider = undefined
}
