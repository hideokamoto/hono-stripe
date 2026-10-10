import { Hono } from 'hono'
import type { HtmlEscapedString } from 'hono/utils/html'
import { describe, expect, it } from 'vitest'
import {
  STRIPE_ELEMENTS_CDN_URL,
  StripeElementsScript,
  StripePaymentForm,
} from '../src/ui'

const render = async (
  element: HtmlEscapedString | Promise<HtmlEscapedString>,
): Promise<string> => {
  const app = new Hono().get('/', (c) => c.html(element))
  const res = await app.request('/')
  return res.text()
}

describe('StripeElementsScript', () => {
  it('renders a module script pointing at the default CDN URL', async () => {
    const html = await render(<StripeElementsScript />)
    expect(html).toContain(`src="${STRIPE_ELEMENTS_CDN_URL}"`)
    expect(html).toContain('type="module"')
  })

  it('honours a custom src', async () => {
    const html = await render(<StripeElementsScript src="/static/elements.js" />)
    expect(html).toContain('src="/static/elements.js"')
  })
})

describe('StripePaymentForm', () => {
  it('renders the element, loader script, and an endpoint bootstrap', async () => {
    const html = await render(
      <StripePaymentForm endpoint="/api/payment-intent" publishableKey="pk_test_1" />,
    )
    expect(html).toContain('<stripe-payment-element')
    expect(html).toContain('id="hono-stripe-payment"')
    expect(html).toContain('publishable-key="pk_test_1"')
    expect(html).toContain(STRIPE_ELEMENTS_CDN_URL)
    expect(html).toContain('fetch("/api/payment-intent"')
    expect(html).toContain('el.intentClientSecret = data.clientSecret')
  })

  it('uses checkoutSessionClientSecret in checkout mode', async () => {
    const html = await render(
      <StripePaymentForm endpoint="/api/checkout" intent="checkout" />,
    )
    expect(html).toContain('el.checkoutSessionClientSecret = data.clientSecret')
  })

  it('renders an SSR clientSecret as an attribute without a bootstrap script', async () => {
    const html = await render(<StripePaymentForm clientSecret="pi_1_secret_abc" />)
    expect(html).toContain('intent-client-secret="pi_1_secret_abc"')
    expect(html).not.toContain('fetch(')
  })

  it('throws when neither endpoint nor clientSecret is provided', async () => {
    const app = new Hono().get('/', (c) =>
      c.html(<StripePaymentForm publishableKey="pk_test_1" />),
    )
    app.onError((err, c) => c.text(err.message, 500))
    const res = await app.request('/')
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('requires either `clientSecret`')
  })
})
