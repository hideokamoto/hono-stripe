import { Hono } from 'hono'
import {
  stripeMiddleware,
  getStripe,
  createPaymentIntent,
  createCheckoutSession,
  verifyStripeSignature,
  type StripeEnv,
} from 'hono-stripe'
import { Layout } from './layout'

type Bindings = {
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  STRIPE_PUBLISHABLE_KEY: string
}

const app = new Hono<{ Bindings: Bindings } & StripeEnv>()

/**
 * The price is decided on the SERVER — never trust an amount sent by the client.
 * In a real app you would look this up from a price id or a cart by id.
 */
const PRODUCT = {
  name: 'Hono Sticker Pack',
  amount: 1400, // $14.00, in the smallest currency unit
  currency: 'usd',
} as const

// Inject `c.var.stripe` for the API routes and the post-checkout return page.
// On Workers the middleware applies Stripe.createFetchHttpClient() automatically.
app.use('/api/*', stripeMiddleware())
app.use('/return', stripeMiddleware())

// ---------------------------------------------------------------------------
// Layer 3 (UI) — pages served with hono/jsx. No React, no build step for the
// frontend: the payment UI is the <stripe-payment-element> web component from
// stripe-pwa-elements, loaded from a CDN.
// ---------------------------------------------------------------------------

app.get('/', (c) =>
  c.html(
    <Layout title="Pay with Payment Element">
      <h1>{PRODUCT.name}</h1>
      <p>
        ${(PRODUCT.amount / 100).toFixed(2)} {PRODUCT.currency.toUpperCase()}
      </p>

      {/*
        stripe-pwa-elements web component. It needs a publishable key and the
        client_secret of a PaymentIntent created on the server. Property names
        follow stripe-pwa-elements — see https://github.com/stripe/stripe-pwa-elements
      */}
      <stripe-payment-element id="payment" />

      <script type="module" src="https://cdn.jsdelivr.net/npm/stripe-pwa-elements/dist/stripe-pwa-elements/stripe-pwa-elements.esm.js" />
      <script
        type="module"
        // biome-ignore lint: inline bootstrap for the demo
        dangerouslySetInnerHTML={{
          __html: `
            const res = await fetch('/api/payment-intent', { method: 'POST' });
            const { clientSecret, publishableKey } = await res.json();
            const el = document.getElementById('payment');
            el.publishableKey = publishableKey;
            el.intentClientSecret = clientSecret;
          `,
        }}
      />

      <p>
        <a href="/checkout">Or pay with a Checkout Session →</a>
      </p>
    </Layout>,
  ),
)

app.get('/checkout', (c) =>
  c.html(
    <Layout title="Pay with Checkout Session">
      <h1>{PRODUCT.name}</h1>
      <p>Checkout Sessions flow (ui_mode: embedded_page).</p>
      <stripe-payment-element id="checkout" />

      <script type="module" src="https://cdn.jsdelivr.net/npm/stripe-pwa-elements/dist/stripe-pwa-elements/stripe-pwa-elements.esm.js" />
      <script
        type="module"
        dangerouslySetInnerHTML={{
          __html: `
            const res = await fetch('/api/checkout-session', { method: 'POST' });
            const { clientSecret, publishableKey } = await res.json();
            const el = document.getElementById('checkout');
            el.publishableKey = publishableKey;
            el.checkoutSessionClientSecret = clientSecret;
          `,
        }}
      />

      <p>
        <a href="/">← Back to Payment Element</a>
      </p>
    </Layout>,
  ),
)

// Where Stripe redirects the customer after the embedded Checkout Session
// completes (see `return_url` below). Looks the session up to show its status.
app.get('/return', async (c) => {
  const sessionId = c.req.query('session_id')
  if (!sessionId) return c.redirect('/')
  const session = await getStripe(c).checkout.sessions.retrieve(sessionId)
  const complete = session.status === 'complete'
  return c.html(
    <Layout title={complete ? 'Payment complete' : 'Payment status'}>
      <h1>{complete ? 'Payment complete 🎉' : 'Payment status'}</h1>
      <p>Thanks for your purchase.</p>
      <p>
        Status: {session.status} / {session.payment_status}
      </p>
      <p>
        <a href="/">← Back to home</a>
      </p>
    </Layout>,
  )
})

// ---------------------------------------------------------------------------
// Layer 1 (intent / session creation) — hono-stripe helpers.
// ---------------------------------------------------------------------------

app.post('/api/payment-intent', async (c) => {
  const intent = await createPaymentIntent(c, {
    amount: PRODUCT.amount,
    currency: PRODUCT.currency,
    automatic_payment_methods: { enabled: true },
    metadata: { product: PRODUCT.name },
  })
  return c.json({
    clientSecret: intent.client_secret,
    publishableKey: c.env.STRIPE_PUBLISHABLE_KEY,
  })
})

app.post('/api/checkout-session', async (c) => {
  const session = await createCheckoutSession(c, {
    // A ui_mode that returns a client_secret to drive the UI yourself (what
    // stripe-pwa-elements consumes). Values differ across Stripe versions —
    // 'embedded_page' here; recent SDKs also add 'custom'.
    ui_mode: 'embedded_page',
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: PRODUCT.currency,
          unit_amount: PRODUCT.amount,
          product_data: { name: PRODUCT.name },
        },
      },
    ],
    return_url: `${new URL(c.req.url).origin}/return?session_id={CHECKOUT_SESSION_ID}`,
  })
  return c.json({
    clientSecret: session.client_secret,
    publishableKey: c.env.STRIPE_PUBLISHABLE_KEY,
  })
})

// ---------------------------------------------------------------------------
// Layer 2 (webhook) — hono-stripe verifies the signature. Typed per-event
// routing is the job of @kotodayori/hono; reach for it when you outgrow the
// switch below.
// ---------------------------------------------------------------------------

app.post('/api/webhook', async (c) => {
  // On a missing/invalid signature, verifyStripeSignature throws an
  // HTTPException(400), which Hono renders as a 400 response — so a bad
  // signature already returns 400 (not 500) and does not trigger Stripe retries.
  const event = await verifyStripeSignature(c, { secret: c.env.STRIPE_WEBHOOK_SECRET })

  switch (event.type) {
    case 'payment_intent.succeeded':
      console.log('PaymentIntent succeeded:', event.data.object.id)
      break
    case 'checkout.session.completed':
      console.log('Checkout Session completed:', event.data.object.id)
      break
    default:
      // For typed routing across many event types, use @kotodayori/hono:
      // https://www.npmjs.com/package/@kotodayori/hono
      break
  }

  return c.body(null, 200)
})

export default app
