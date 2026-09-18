import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
const app = buildApp({ db, redis, storage: {} as never, queueConnection, cookieSecret: 'test-secret' })

afterAll(async () => {
  await db.destroy()
  redis.disconnect()
  queueConnection.disconnect()
  await app.close()
})

function sessionCookieFrom(response: { cookies: { name: string; value: string }[] }): string {
  const cookie = response.cookies.find((c) => c.name === 'flare_session')
  if (!cookie) throw new Error('no session cookie set')
  return `flare_session=${cookie.value}`
}

describe('POST /api/v1/auth/register', () => {
  it('registers a new user, sets a session cookie, and makes the first user an admin', async () => {
    const email = `first-${Date.now()}@example.test`
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'correct-horse-battery-staple', name: 'First User' },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.user.email).toBe(email)

    const cookie = sessionCookieFrom(response)
    const meResponse = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } })
    expect(meResponse.statusCode).toBe(200)
    expect(meResponse.json().user.email).toBe(email)
  })

  it('rejects a duplicate email with 409', async () => {
    const email = `dup-${Date.now()}@example.test`
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'correct-horse-battery-staple', name: 'First' },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'another-password', name: 'Second' },
    })
    expect(response.statusCode).toBe(409)
  })

  it('rejects a password shorter than 8 characters', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: `short-${Date.now()}@example.test`, password: 'short', name: 'Short Pw' },
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('POST /api/v1/auth/login', () => {
  it('logs in with the correct password and sets a session cookie', async () => {
    const email = `login-${Date.now()}@example.test`
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'correct-horse-battery-staple', name: 'Login Test' },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'correct-horse-battery-staple' },
    })
    expect(response.statusCode).toBe(200)

    const cookie = sessionCookieFrom(response)
    const meResponse = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } })
    expect(meResponse.json().user.email).toBe(email)
  })

  it('returns 401 for an incorrect password', async () => {
    const email = `wrongpw-${Date.now()}@example.test`
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'correct-horse-battery-staple', name: 'Wrong Pw Test' },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'not-the-right-password' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('returns 401 for an unknown email', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: `nobody-${Date.now()}@example.test`, password: 'irrelevant' },
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('POST /api/v1/auth/logout', () => {
  it('destroys the session so /api/v1/me subsequently 401s', async () => {
    const email = `logout-${Date.now()}@example.test`
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'correct-horse-battery-staple', name: 'Logout Test' },
    })
    const cookie = sessionCookieFrom(registerResponse)

    const logoutResponse = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } })
    expect(logoutResponse.statusCode).toBe(200)

    const meResponse = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } })
    expect(meResponse.statusCode).toBe(401)
  })
})

describe('GET /api/v1/me', () => {
  it('returns 401 without a session cookie', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/me' })
    expect(response.statusCode).toBe(401)
  })
})
