import { Hono } from 'hono'
import {
  stripeMiddleware,
  getStripe,
  createPaymentIntent,
  createCheckoutSession,
  type StripeEnv,
} from 'hono-stripe'
import { stripeWebhook, memoryEventStore } from 'hono-stripe/webhook'
import { StripePaymentForm } from 'hono-stripe/ui'
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
// UI — hono-stripe/ui renders the <stripe-payment-element> web component
// (stripe-pwa-elements) loaded from a CDN, plus a bootstrap script that POSTs
// to `endpoint` and assigns the returned { clientSecret, publishableKey }.
// No React, no frontend build step.
// ---------------------------------------------------------------------------

app.get('/', (c) =>
  c.html(
    <Layout title="Pay with Payment Element">
      <h1>{PRODUCT.name}</h1>
      <p>
        ${(PRODUCT.amount / 100).toFixed(2)} {PRODUCT.currency.toUpperCase()}
      </p>

      <StripePaymentForm
        endpoint="/api/payment-intent"
        publishableKey={c.env.STRIPE_PUBLISHABLE_KEY}
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

      <StripePaymentForm
        endpoint="/api/checkout-session"
        intent="checkout"
        publishableKey={c.env.STRIPE_PUBLISHABLE_KEY}
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
// Intent / Session creation — hono-stripe helpers.
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
// Webhook — hono-stripe/webhook: signature verification, typed per-event
// dispatch (event.data.object is narrowed by event name), and delivery dedupe.
// memoryEventStore is per-isolate, fine for dev — in production back it with
// Workers KV: dedupe: (c) => kvEventStore(c.env.STRIPE_EVENTS)
// ---------------------------------------------------------------------------

const processedEvents = memoryEventStore()

app.post(
  '/api/webhook',
  stripeWebhook({
    secret: (c) => c.env.STRIPE_WEBHOOK_SECRET,
    dedupe: processedEvents,
    on: {
      'payment_intent.succeeded': (event) => {
        console.log('PaymentIntent succeeded:', event.data.object.id)
      },
      'checkout.session.completed': (event) => {
        console.log('Checkout Session completed:', event.data.object.id)
      },
    },
  }),
)

export default app
