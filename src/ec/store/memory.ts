import type { CartItem, CartStore } from '../types'

/**
 * In-memory CartStore — development, tests, single-isolate workloads.
 * Every line is an independent map entry (`cart:{id}:item:{priceId}` layout),
 * so all mutations stay pure puts/deletes as the spec requires.
 */
export const memoryCartStore = (): CartStore => {
  const carts = new Map<string, Map<string, CartItem>>()
  return {
    list: async (cartId) =>
      [...(carts.get(cartId)?.values() ?? [])].map((item) => ({ ...item })),
    put: async (cartId, item) => {
      let cart = carts.get(cartId)
      if (!cart) {
        cart = new Map()
        carts.set(cartId, cart)
      }
      cart.set(item.priceId, { ...item })
    },
    delete: async (cartId, priceId) => {
      carts.get(cartId)?.delete(priceId)
    },
  }
}
