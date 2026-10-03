import type {
  BillingCustomerRow,
  BillingStore,
  BillingSubscriptionRow,
  SubscriptionWriteResult,
  UpsertSubscriptionOptions,
} from '../types'

/**
 * Minimal database handle: executes SQL and returns result rows as objects.
 * Covers D1 (`env.DB.prepare().bind().all()`), better-sqlite3, postgres.js,
 * pg.Pool, libsql — wrap whatever driver you already use.
 */
export type SqlExecutor = (
  sql: string,
  params?: unknown[],
) => Promise<Record<string, unknown>[]>

export type SqlDialect = 'sqlite' | 'pg'

export interface SqlBillingStoreOptions {
  dialect?: SqlDialect
  /** Table name overrides if you prefix billing tables. */
  tables?: { customers?: string; subscriptions?: string }
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * SQL-backed BillingStore — the correctness-complete adapter. The ordering
 * guard runs inside the database as
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE excluded.last_event_created >
 * stored.last_event_created`, so the check-and-write is atomic. This is the
 * store the sync protocol is proven to converge under
 * (spec/quint/billing_sync_2ev.qnt).
 */
export const sqlBillingStore = (
  execute: SqlExecutor,
  options: SqlBillingStoreOptions = {},
): BillingStore => {
  const dialect = options.dialect ?? 'sqlite'
  const ph = (i: number) => (dialect === 'pg' ? `$${i + 1}` : '?')
  const params = (n: number) => Array.from({ length: n }, (_, i) => ph(i)).join(', ')
  const customersTable = options.tables?.customers ?? 'stripe_customers'
  const subscriptionsTable = options.tables?.subscriptions ?? 'stripe_subscriptions'

  const SUB_COLS = [
    'id', 'user_id', 'stripe_customer_id', 'status', 'price_ids', 'quantity',
    'current_period_end', 'cancel_at_period_end', 'canceled_at', 'trial_end',
    'ended_at', 'last_event_created', 'raw', 'created_at', 'updated_at',
  ] as const

  const subParams = (r: BillingSubscriptionRow): unknown[] => [
    r.id, r.userId, r.stripeCustomerId, r.status,
    JSON.stringify(r.priceIds), r.quantity, r.currentPeriodEnd,
    dialect === 'pg' ? r.cancelAtPeriodEnd : (r.cancelAtPeriodEnd ? 1 : 0),
    r.canceledAt, r.trialEnd, r.endedAt, r.lastEventCreated,
    r.raw === null || r.raw === undefined ? null : JSON.stringify(r.raw),
    r.createdAt, r.updatedAt,
  ]

  const toSubRow = (r: Record<string, unknown>): BillingSubscriptionRow => ({
    id: r.id as string,
    userId: r.user_id as string,
    stripeCustomerId: r.stripe_customer_id as string,
    status: r.status as string,
    priceIds:
      typeof r.price_ids === 'string'
        ? (JSON.parse(r.price_ids) as string[])
        : (r.price_ids as string[]),
    quantity: (r.quantity as number | null) ?? null,
    currentPeriodEnd: (r.current_period_end as number | null) ?? null,
    cancelAtPeriodEnd: Boolean(r.cancel_at_period_end),
    canceledAt: (r.canceled_at as number | null) ?? null,
    trialEnd: (r.trial_end as number | null) ?? null,
    endedAt: (r.ended_at as number | null) ?? null,
    lastEventCreated: r.last_event_created as number,
    raw:
      typeof r.raw === 'string'
        ? (JSON.parse(r.raw) as unknown)
        : ((r.raw as unknown) ?? null),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  })

  const toCustomerRow = (r: Record<string, unknown>): BillingCustomerRow => ({
    userId: r.user_id as string,
    stripeCustomerId: r.stripe_customer_id as string,
    raw:
      typeof r.raw === 'string'
        ? (JSON.parse(r.raw) as unknown)
        : ((r.raw as unknown) ?? null),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  })

  const upsertSubscription = async (
    row: BillingSubscriptionRow,
    options?: UpsertSubscriptionOptions,
  ): Promise<SubscriptionWriteResult> => {
    const setClauses = SUB_COLS.filter((c) => c !== 'id' && c !== 'created_at')
      .map((c) => `${c} = excluded.${c}`)
      .join(', ')
    const guard = options?.force
      ? ''
      : ` WHERE excluded.last_event_created > ${subscriptionsTable}.last_event_created`
    const written = await execute(
      `INSERT INTO ${subscriptionsTable} (${SUB_COLS.join(', ')})
       VALUES (${params(SUB_COLS.length)})
       ON CONFLICT (id) DO UPDATE SET ${setClauses}${guard}
       RETURNING id`,
      subParams(row),
    )
    if (written.length > 0) return 'written'
    if (options?.force) return 'written'
    // Guard skipped the write — classify stale vs same-second tie.
    const existing = await execute(
      `SELECT last_event_created FROM ${subscriptionsTable} WHERE id = ${ph(0)}`,
      [row.id],
    )
    const stored = existing[0]?.last_event_created as number | undefined
    return stored === row.lastEventCreated ? 'tie' : 'stale'
  }

  return {
    upsertCustomer: async (row) => {
      await execute(
        `INSERT INTO ${customersTable} (user_id, stripe_customer_id, raw, created_at, updated_at)
         VALUES (${params(5)})
         ON CONFLICT (stripe_customer_id) DO UPDATE SET
           raw = excluded.raw, updated_at = excluded.updated_at`,
        [
          row.userId,
          row.stripeCustomerId,
          row.raw === null || row.raw === undefined ? null : JSON.stringify(row.raw),
          row.createdAt,
          row.updatedAt,
        ],
      )
    },
    upsertSubscription,
    getSubscriptionsByUserId: async (userId) => {
      const rows = await execute(
        `SELECT * FROM ${subscriptionsTable} WHERE user_id = ${ph(0)}`,
        [userId],
      )
      return rows.map(toSubRow)
    },
    getCustomerByUserId: async (userId) => {
      const rows = await execute(
        `SELECT * FROM ${customersTable} WHERE user_id = ${ph(0)}`,
        [userId],
      )
      return rows[0] ? toCustomerRow(rows[0]) : null
    },
    getCustomerByStripeId: async (stripeCustomerId) => {
      const rows = await execute(
        `SELECT * FROM ${customersTable} WHERE stripe_customer_id = ${ph(0)}`,
        [stripeCustomerId],
      )
      return rows[0] ? toCustomerRow(rows[0]) : null
    },
    relinkCustomer: async (stripeCustomerId, userId) => {
      const now = nowSeconds()
      await execute(
        `UPDATE ${customersTable} SET user_id = ${ph(0)}, updated_at = ${ph(1)}
         WHERE stripe_customer_id = ${ph(2)}`,
        [userId, now, stripeCustomerId],
      )
      await execute(
        `UPDATE ${subscriptionsTable} SET user_id = ${ph(0)}, updated_at = ${ph(1)}
         WHERE stripe_customer_id = ${ph(2)}`,
        [userId, now, stripeCustomerId],
      )
    },
  }
}
