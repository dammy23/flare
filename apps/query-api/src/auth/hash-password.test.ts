import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './hash-password'

describe('hashPassword / verifyPassword', () => {
  it('produces a hash that verifies against the original password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple')
    expect(await verifyPassword('correct-horse-battery-staple', hash)).toBe(true)
  })

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple')
    expect(await verifyPassword('wrong-password', hash)).toBe(false)
  })

  it('never stores the password in plaintext', async () => {
    const hash = await hashPassword('correct-horse-battery-staple')
    expect(hash).not.toContain('correct-horse-battery-staple')
  })
})
