import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import { getCurrentUser, getInvite, joinWithInvite } from './api'
import type { CurrentUser, InvitePublic } from './types'

interface JoinScreenProps {
  token: string
  onJoined: (accessToken: string, user: CurrentUser) => void
}

export function JoinScreen({ token, onJoined }: JoinScreenProps) {
  const [invite, setInvite] = useState<InvitePublic | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    getInvite(token)
      .then((next) => {
        setInvite(next)
        setEmail(next.email ?? '')
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Invite is not valid'))
  }, [token])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const result = await joinWithInvite(token, password, email)
      const user = await getCurrentUser(result.access_token)
      onJoined(result.access_token, user)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not join')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-story">
        <div className="brand brand-light">
          <span className="brand-mark">S</span>
          <span>Swasemi Fleet</span>
        </div>
        <div className="story-copy">
          <p className="eyebrow">Invite only</p>
          <h1>You were allowed in.</h1>
          <p>Set a password to join {invite?.org_name ?? 'your organization'}. There is no public signup.</p>
        </div>
      </section>
      <section className="login-panel">
        <form className="login-form" onSubmit={submit}>
          <div>
            <p className="eyebrow dark">Super Admin invite</p>
            <h2>Join the fleet</h2>
            <p className="muted">
              {invite ? `Organization: ${invite.org_name}` : 'Checking this invite…'}
            </p>
          </div>
          <label>
            Email address
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={Boolean(invite?.email)}
              required
            />
          </label>
          <label>
            Choose a password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              required
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button type="submit" className="primary-button" disabled={submitting || !invite}>
            {submitting ? 'Joining…' : 'Accept invite'}
          </button>
        </form>
      </section>
    </main>
  )
}
