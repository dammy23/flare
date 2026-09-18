import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../AuthContext'
import { login } from '../api/query-client'
import { Card } from '../components/Card'
import { Field, Input } from '../components/Input'
import { Button } from '../components/Button'

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const { refresh } = useAuth()
  const navigate = useNavigate()

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(email, password)
      await refresh()
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'login failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flare-auth-screen">
      <div className="flare-auth-card">
        <Card>
          <div className="flare-auth-card__logo">Flare</div>
          {error && <p className="flare-auth-error">{error}</p>}
          <form onSubmit={handleSubmit}>
            <Field label="Email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </Field>
            <Field label="Password">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
          <p className="flare-auth-switch">
            No account yet? <Link to="/register">Register</Link>
          </p>
        </Card>
      </div>
    </div>
  )
}
