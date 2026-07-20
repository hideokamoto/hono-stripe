import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
) as { engines?: { node?: unknown } }

describe('package.json engines', () => {
  it('declares an engines.node constraint', () => {
    expect(pkg.engines).toBeDefined()
    expect(typeof pkg.engines?.node).toBe('string')
  })

  it('requires Node >= 20', () => {
    const node = pkg.engines?.node
    expect(node).toBeTypeOf('string')
    expect(node).toMatch(/>=\s*20/)
  })
})
