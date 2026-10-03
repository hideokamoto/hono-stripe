/**
 * DDL for the billing mirror tables. Apply via your own migration tool —
 * the strings are dialect-specific and dependency-free.
 *
 * SQLite variant covers Cloudflare D1, libsql/Turso, and better-sqlite3.
 * Timestamps are unix seconds (integer), matching Stripe's representation.
 */
export const BILLING_SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS stripe_customers (
  user_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  raw TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stripe_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  price_ids TEXT NOT NULL,
  quantity INTEGER,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  canceled_at INTEGER,
  trial_end INTEGER,
  ended_at INTEGER,
  last_event_created INTEGER NOT NULL,
  raw TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_user
  ON stripe_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_customer
  ON stripe_subscriptions(stripe_customer_id);
`

/**
 * Postgres variant — same shape, JSONB for the JSON columns, BOOLEAN for
 * cancel_at_period_end.
 */
export const BILLING_SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS stripe_customers (
  user_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  raw JSONB,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS stripe_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  price_ids JSONB NOT NULL,
  quantity INTEGER,
  current_period_end BIGINT,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  canceled_at BIGINT,
  trial_end BIGINT,
  ended_at BIGINT,
  last_event_created BIGINT NOT NULL,
  raw JSONB,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_user
  ON stripe_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_customer
  ON stripe_subscriptions(stripe_customer_id);
`
