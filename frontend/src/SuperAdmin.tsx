import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import { createInvite, createOrganization, listInvites, listOrganizationUsers, listOrganizations } from './api'
import type { CurrentUser, Invite, Organization } from './types'

interface SuperAdminProps {
  token: string
  onClose: () => void
}

export function SuperAdmin({ token, onClose }: SuperAdminProps) {
  const [orgs, setOrgs] = useState<Organization[]>([])
  const [users, setUsers] = useState<CurrentUser[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [orgId, setOrgId] = useState<number | null>(null)
  const [orgName, setOrgName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [copied, setCopied] = useState('')
  const [error, setError] = useState('')

  async function refresh() {
    const nextOrgs = await listOrganizations(token)
    setOrgs(nextOrgs)
    const selected = orgId ?? nextOrgs[0]?.id ?? null
    setOrgId(selected)
    const [nextInvites, nextUsers] = await Promise.all([
      listInvites(token),
      selected ? listOrganizationUsers(selected, token) : Promise.resolve([]),
    ])
    setInvites(nextInvites)
    setUsers(nextUsers)
  }

  useEffect(() => {
    refresh().catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load platform'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    if (orgId === null) return
    listOrganizationUsers(orgId, token)
      .then(setUsers)
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load users'))
  }, [orgId, token])

  async function addOrg(event: FormEvent) {
    event.preventDefault()
    if (!orgName.trim()) return
    setError('')
    try {
      const org = await createOrganization(orgName.trim(), token)
      setOrgName('')
      setOrgId(org.id)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create organization')
    }
  }

  async function addInvite(event: FormEvent) {
    event.preventDefault()
    if (orgId === null) return
    setError('')
    try {
      const invite = await createInvite(orgId, token, inviteEmail.trim() || undefined)
      setInviteEmail('')
      setInvites((current) => [invite, ...current])
      await navigator.clipboard.writeText(invite.invite_url)
      setCopied(invite.invite_url)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create invite')
    }
  }

  return (
    <aside className="admin-panel">
      <div className="history-head">
        <div>
          <p className="eyebrow dark">Platform</p>
          <h3>Super Admin</h3>
        </div>
        <button type="button" className="text-button" onClick={onClose}>Close</button>
      </div>
      <p className="muted">You provision organizations and invite users. Nobody can join without a link you create.</p>

      {error && <div className="form-error compact">{error}</div>}

      <form className="admin-form" onSubmit={addOrg}>
        <label>
          New organization
          <input value={orgName} onChange={(event) => setOrgName(event.target.value)} placeholder="Acme Logistics" />
        </label>
        <button type="submit" className="upload-button">Create org</button>
      </form>

      <label>
        Organization
        <select
          value={orgId ?? ''}
          onChange={(event) => setOrgId(Number(event.target.value))}
        >
          {orgs.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
        </select>
      </label>

      <form className="admin-form" onSubmit={addInvite}>
        <label>
          Invite email (optional)
          <input
            type="email"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
            placeholder="Leave empty so anyone with the link can join this org"
          />
        </label>
        <button type="submit" className="trip-button start">Create invite link</button>
      </form>
      {copied && <p className="muted">Copied: {copied}</p>}

      <div className="history-trips">
        <strong>Users in this org</strong>
        {users.length === 0 && <p className="muted">No users yet.</p>}
        {users.map((user) => (
          <div key={user.id} className="history-trip">
            <strong>{user.email}</strong>
            <small>{user.role}</small>
          </div>
        ))}
      </div>

      <div className="history-trips">
        <strong>Invite links</strong>
        {invites.length === 0 && <p className="muted">No invites yet.</p>}
        {invites.map((invite) => (
          <button
            type="button"
            key={invite.id}
            className="history-trip"
            onClick={() => {
              navigator.clipboard.writeText(invite.invite_url)
              setCopied(invite.invite_url)
            }}
          >
            <strong>{invite.org_name}</strong>
            <small>
              {invite.email ?? 'Open link'} · {invite.used_at ? 'used' : 'active'}
            </small>
          </button>
        ))}
      </div>
    </aside>
  )
}
