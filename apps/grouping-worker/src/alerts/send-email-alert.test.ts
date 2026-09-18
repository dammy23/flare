import { describe, expect, it, vi } from 'vitest'
import { createEmailTransport, sendEmailAlert } from './send-email-alert'

describe('createEmailTransport', () => {
  it('returns a transport with a sendMail function, without connecting', () => {
    const transport = createEmailTransport({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      user: 'flare',
      pass: 'secret',
      from: 'flare@example.test',
      to: 'alerts@example.test',
    })
    expect(typeof transport.sendMail).toBe('function')
  })
})

describe('sendEmailAlert', () => {
  it('sends mail with the configured from/to and the given subject/text', async () => {
    const sendMail = vi.fn().mockResolvedValue({})
    const config = { from: 'flare@example.test', to: 'alerts@example.test' }

    await sendEmailAlert({ sendMail }, config, 'Flare: new issue', 'New issue: TypeError: boom')

    expect(sendMail).toHaveBeenCalledWith({
      from: 'flare@example.test',
      to: 'alerts@example.test',
      subject: 'Flare: new issue',
      text: 'New issue: TypeError: boom',
    })
  })

  it('logs but does not throw when sending fails', async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error('smtp connection refused'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(
      sendEmailAlert({ sendMail }, { from: 'flare@example.test', to: 'alerts@example.test' }, 'subject', 'text')
    ).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
