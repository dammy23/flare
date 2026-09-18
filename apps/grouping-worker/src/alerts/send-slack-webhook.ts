/**
 * A plain fetch POST to a Slack incoming webhook. Logs (does not throw)
 * on a non-2xx response or a network failure -- alerting is a side
 * effect of ingestion, never a dependency of it, so a broken webhook
 * URL can never take down the error-ingestion write path.
 */
export async function sendSlackWebhook(webhookUrl: string, text: string): Promise<void> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!response.ok) {
      console.error(`slack webhook failed: ${response.status} ${await response.text()}`)
    }
  } catch (error) {
    console.error('slack webhook request failed:', error)
  }
}
