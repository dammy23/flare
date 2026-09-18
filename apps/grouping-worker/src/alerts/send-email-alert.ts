import nodemailer, { type Transporter } from 'nodemailer'

export interface EmailAlertConfig {
  host: string
  port: number
  secure: boolean
  user: string | null
  pass: string | null
  from: string
  to: string
}

export function createEmailTransport(config: EmailAlertConfig): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
  })
}

/**
 * Logs, never throws, on a send failure -- same posture as
 * sendSlackWebhook. Alerting is a side effect of ingestion, never a
 * dependency of it; a misconfigured/unreachable SMTP server can't be
 * allowed to take down error ingestion.
 */
export async function sendEmailAlert(
  transport: Pick<Transporter, 'sendMail'>,
  config: Pick<EmailAlertConfig, 'from' | 'to'>,
  subject: string,
  text: string
): Promise<void> {
  try {
    await transport.sendMail({ from: config.from, to: config.to, subject, text })
  } catch (error) {
    console.error('email alert failed:', error)
  }
}
