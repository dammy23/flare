export function parseSentryAuthHeader(headerValue: string | undefined): string | null {
  if (!headerValue) return null
  const match = headerValue.match(/sentry_key=([^,\s]+)/)
  return match ? match[1] : null
}
