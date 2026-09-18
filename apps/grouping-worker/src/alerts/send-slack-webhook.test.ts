import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendSlackWebhook } from './send-slack-webhook'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendSlackWebhook', () => {
  it('POSTs the text as a Slack-shaped JSON payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    await sendSlackWebhook('https://hooks.slack.test/abc', 'hello from flare')

    expect(fetchMock).toHaveBeenCalledWith('https://hooks.slack.test/abc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello from flare' }),
    })
  })

  it('logs but does not throw on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('boom') })
    vi.stubGlobal('fetch', fetchMock)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(sendSlackWebhook('https://hooks.slack.test/abc', 'hello')).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('logs but does not throw when the request itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(sendSlackWebhook('https://hooks.slack.test/abc', 'hello')).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
