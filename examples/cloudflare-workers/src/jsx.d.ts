// Teach hono/jsx about the stripe-pwa-elements custom element so TSX usage of
// <stripe-payment-element> type-checks. Properties (publishableKey,
// intentClientSecret, ...) are set imperatively from a <script>, so only the
// attributes used in markup need to be declared here.
import {} from 'hono/jsx'

declare module 'hono/jsx' {
  namespace JSX {
    interface IntrinsicElements {
      'stripe-payment-element': {
        id?: string
        children?: Child
      }
    }
  }
}
