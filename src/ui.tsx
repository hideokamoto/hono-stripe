import type { Child, FC } from 'hono/jsx'

/**
 * Server-side JSX helpers (hono/jsx, HonoX-compatible) that render the
 * [stripe-pwa-elements](https://github.com/stripe/stripe-pwa-elements) web
 * components — Payment Element without React.
 *
 * The browser-side component code is NOT bundled here: it is loaded as an ES
 * module from a CDN (default jsDelivr) or wherever {@link StripeElementsScript}'s
 * `src` points. This module only produces the markup + bootstrap script.
 */

/**
 * Module URL for the stripe-pwa-elements lazy loader (registers all
 * `stripe-*` custom elements). Pinned to major version 3.
 */
export const STRIPE_ELEMENTS_CDN_URL =
  'https://cdn.jsdelivr.net/npm/stripe-pwa-elements@3/dist/stripe-elements/stripe-elements.esm.js'

interface StripePaymentElementAttributes {
  id?: string
  class?: string
  style?: string
  'publishable-key'?: string
  'intent-client-secret'?: string
  'checkout-session-client-secret'?: string
  children?: Child
}

declare module 'hono/jsx' {
  namespace JSX {
    interface IntrinsicElements {
      'stripe-payment-element': StripePaymentElementAttributes
    }
  }
}

export interface StripeElementsScriptProps {
  /** Module URL for the elements bundle. Default: {@link STRIPE_ELEMENTS_CDN_URL}. */
  src?: string
}

/**
 * `<script type="module">` tag that registers the stripe-pwa-elements custom
 * elements. Rendering it more than once is harmless — module scripts are
 * deduplicated by URL — so components below include it unconditionally.
 */
export const StripeElementsScript: FC<StripeElementsScriptProps> = ({ src }) => (
  <script type="module" src={src ?? STRIPE_ELEMENTS_CDN_URL} />
)

export interface StripePaymentFormProps {
  /**
   * Server endpoint (POST) returning `{ clientSecret, publishableKey? }` —
   * typically backed by `createPaymentIntent` / `createCheckoutSession`.
   * Required unless `clientSecret` is given.
   */
  endpoint?: string
  /**
   * A `client_secret` created during SSR (via `createPaymentIntent` /
   * `createCheckoutSession` in the same request). When set, no fetch is made
   * and the secret is rendered as an element attribute directly.
   */
  clientSecret?: string
  /**
   * Stripe publishable key (`pk_...`). In endpoint mode it is only a fallback —
   * a `publishableKey` in the endpoint response wins.
   */
  publishableKey?: string
  /** Which kind of secret drives the element. Default: `payment`. */
  intent?: 'payment' | 'checkout'
  /** DOM id for the `<stripe-payment-element>`. Default: `hono-stripe-payment`. */
  id?: string
  class?: string
  /** Passed through to {@link StripeElementsScript}. */
  src?: string
}

/**
 * Renders a `<stripe-payment-element>` wired to a PaymentIntent or embedded
 * Checkout Session client_secret.
 *
 * Two modes:
 * - **`endpoint`** (client fetch): the browser POSTs to `endpoint`, expects
 *   `{ clientSecret, publishableKey? }` back, and assigns it to the element.
 * - **`clientSecret`** (SSR): the secret is rendered as an attribute — no
 *   client-side fetch.
 *
 * @example
 * ```tsx
 * app.get('/', (c) => c.html(
 *   <StripePaymentForm endpoint="/api/payment-intent" publishableKey={c.env.STRIPE_PK} />
 * ))
 * ```
 */
export const StripePaymentForm: FC<StripePaymentFormProps> = (props) => {
  if (!props.clientSecret && !props.endpoint) {
    throw new Error(
      'hono-stripe/ui: <StripePaymentForm> requires either `clientSecret` (SSR) or `endpoint` (client fetch).',
    )
  }
  const id = props.id ?? 'hono-stripe-payment'
  const isCheckout = props.intent === 'checkout'
  return (
    <>
      <stripe-payment-element
        id={id}
        class={props.class}
        publishable-key={props.publishableKey}
        intent-client-secret={!isCheckout ? props.clientSecret : undefined}
        checkout-session-client-secret={isCheckout ? props.clientSecret : undefined}
      />
      <StripeElementsScript src={props.src} />
      {props.endpoint ? (
        <script
          type="module"
          dangerouslySetInnerHTML={{ __html: bootstrapScript(id, props) }}
        />
      ) : null}
    </>
  )
}

const bootstrapScript = (id: string, props: StripePaymentFormProps): string => {
  const secretProp = props.intent === 'checkout' ? 'checkoutSessionClientSecret' : 'intentClientSecret'
  const fallbackKey = JSON.stringify(props.publishableKey ?? null)
  return `const res = await fetch(${JSON.stringify(props.endpoint)}, { method: 'POST' });
if (!res.ok) throw new Error('[hono-stripe] payment endpoint failed: ' + res.status);
const data = await res.json();
const el = document.getElementById(${JSON.stringify(id)});
el.publishableKey = data.publishableKey ?? ${fallbackKey};
el.${secretProp} = data.clientSecret;`
}
