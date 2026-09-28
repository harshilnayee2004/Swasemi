import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import {
  createInvite,
  createOrganization,
  createUser,
  deleteInvite,
  deleteOrganization,
  deleteUser,
  getPlatformStats,
  listAllUsers,
  listInvites,
  listOrganizations,
  resetUserPassword,
} from './api'
import type { Invite, Organization, PlatformStats, UserWithOrg } from './types'

interface SuperAdminProps {
  token: string
  onClose: () => void
}

export function SuperAdmin({ token, onClose }: SuperAdminProps) {
  const [stats, setStats] = useState<PlatformStats | null>(null)
  const [orgs, setOrgs] = useState<Organization[]>([])
  const [users, setUsers] = useState<UserWithOrg[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [isMaximized, setIsMaximized] = useState(false)
  
  // UI Selection & Filters
  const [selectedOrgId, setSelectedOrgId] = useState<number | null>(null)
  const [userSearch, setUserSearch] = useState('')
  const [orgName, setOrgName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [copied, setCopied] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyAction, setBusyAction] = useState('')

  // Create user form state
  const [newUserEmail, setNewUserEmail] = useState('')
  const [newUserPassword, setNewUserPassword] = useState('')
  const [newUserRole, setNewUserRole] = useState<'user' | 'super_admin'>('user')
  const [deletingUserId, setDeletingUserId] = useState<number | null>(null)
  const [deletingOrgId, setDeletingOrgId] = useState<number | null>(null)
  const [deletingInviteId, setDeletingInviteId] = useState<number | null>(null)

  async function loadData() {
    setLoading(true)
    try {
      const [nextStats, nextOrgs, nextUsers, nextInvites] = await Promise.all([
        getPlatformStats(token),
        listOrganizations(token),
        listAllUsers(token),
        listInvites(token),
      ])
      setStats(nextStats)
      setOrgs(nextOrgs)
      setUsers(nextUsers)
      setInvites(nextInvites)
      if (nextOrgs.length > 0 && selectedOrgId === null) {
        setSelectedOrgId(nextOrgs[0].id)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load platform metrics')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function handleAddOrg(event: FormEvent) {
    event.preventDefault()
    if (!orgName.trim()) return
    setError('')
    setBusyAction('organization')
    try {
      const newOrg = await createOrganization(orgName.trim(), token)
      setOrgName('')
      setSelectedOrgId(newOrg.id)
      await loadData()
      setSuccess('Organization created')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create organization')
    } finally {
      setBusyAction('')
    }
  }

  async function handleDeleteOrg(orgId: number, name: string) {
    if (!window.confirm(`Are you sure you want to delete organization "${name}"? This will also remove its associated users, vehicles, and trips.`)) {
      return
    }
    setError('')
    setDeletingOrgId(orgId)
    try {
      await deleteOrganization(orgId, token)
      await loadData()
      setSuccess('Organization deleted')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not delete organization')
    } finally {
      setDeletingOrgId(null)
    }
  }

  async function handleAddUser(event: FormEvent) {
    event.preventDefault()
    if (!newUserEmail.trim() || !newUserPassword.trim()) return
    if (newUserRole === 'user' && selectedOrgId === null) {
      setError('Please select an organization for standard users.')
      return
    }
    setError('')
    setBusyAction('user')
    try {
      await createUser(
        newUserEmail.trim(),
        newUserPassword.trim(),
        newUserRole === 'super_admin' ? (null as unknown as number) : selectedOrgId!,
        token,
      )
      setNewUserEmail('')
      setNewUserPassword('')
      await loadData()
      setSuccess('User account created')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create user')
    } finally {
      setBusyAction('')
    }
  }

  async function handleRemoveUser(userId: number, email: string) {
    if (!window.confirm(`Delete user "${email}"? They will lose access immediately.`)) return
    setError('')
    setDeletingUserId(userId)
    try {
      await deleteUser(userId, token)
      setUsers((current) => current.filter((u) => u.id !== userId))
      await loadData()
      setSuccess('User deleted')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not delete user')
    } finally {
      setDeletingUserId(null)
    }
  }

  async function handleResetPassword(userId: number, email: string) {
    const newPass = window.prompt(`Enter new password for ${email}:`)
    if (!newPass || !newPass.trim()) return
    setError('')
    setBusyAction(`reset-${userId}`)
    try {
      await resetUserPassword(userId, newPass.trim(), token)
      await loadData()
      setSuccess(`Password reset for ${email}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not reset password')
    } finally {
      setBusyAction('')
    }
  }

  async function handleAddInvite(event: FormEvent) {
    event.preventDefault()
    if (selectedOrgId === null) return
    setError('')
    setBusyAction('invite')
    try {
      const invite = await createInvite(selectedOrgId, token, inviteEmail.trim() || undefined)
      setInviteEmail('')
      setInvites((current) => [invite, ...current])
      await navigator.clipboard.writeText(invite.invite_url)
      setCopied(invite.invite_url)
      setSuccess('Invite link copied')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create invite')
    } finally {
      setBusyAction('')
    }
  }

  async function handleRemoveInvite(inviteId: number) {
    setError('')
    setDeletingInviteId(inviteId)
    try {
      await deleteInvite(inviteId, token)
      setInvites((current) => current.filter((inv) => inv.id !== inviteId))
      setSuccess('Invite revoked')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not delete invite')
    } finally {
      setDeletingInviteId(null)
    }
  }

  // Filter users based on search query
  const filteredUsers = users.filter((u) => {
    const q = userSearch.toLowerCase()
    return u.email.toLowerCase().includes(q) || (u.org_name && u.org_name.toLowerCase().includes(q)) || u.role.toLowerCase().includes(q)
  })

  useEffect(() => {
    if (!success && !copied) return
    const timer = window.setTimeout(() => {
      setSuccess('')
      setCopied('')
    }, 2600)
    return () => window.clearTimeout(timer)
  }, [copied, success])

  return (
    <aside className={`admin-panel ${isMaximized ? 'maximized' : ''}`}>
      <div className="history-head admin-toolbar">
        <div>
          <p className="eyebrow dark">Control Center</p>
          <h3>Super Admin Console</h3>
        </div>
        <div className="admin-toolbar-actions">
          <button type="button" className="nav-button" onClick={onClose}>
            Dashboard
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => setIsMaximized((prev) => !prev)}
          >
            {isMaximized ? 'Restore' : 'Widen'}
          </button>
          <button type="button" className="card-close" onClick={onClose} aria-label="Close admin console" title="Close">
            ×
          </button>
        </div>
      </div>

      {error && (
        <div className="form-error compact dismissible-error" style={{ marginBottom: '12px' }} role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')}>Dismiss</button>
        </div>
      )}
      {success && <div className="admin-success" role="status">{success}</div>}
      {loading && <div className="panel-loading"><span className="loader" /> Loading platform data…</div>}

      {/* ── KPI Platform Stats Bar ── */}
      {stats && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: isMaximized ? 'repeat(5, 1fr)' : 'repeat(2, 1fr)',
          gap: '10px',
          marginBottom: '16px',
        }}>
          <div style={{ background: '#f7fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '8px 12px' }}>
            <span style={{ fontSize: '11px', color: '#718096', textTransform: 'uppercase', fontWeight: 600 }}>Total Users</span>
            <div style={{ fontSize: '20px', fontWeight: 800, color: '#2b6cb0' }}>{stats.total_users}</div>
          </div>
          <div style={{ background: '#f7fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '8px 12px' }}>
            <span style={{ fontSize: '11px', color: '#718096', textTransform: 'uppercase', fontWeight: 600 }}>Organizations</span>
            <div style={{ fontSize: '20px', fontWeight: 800, color: '#2b6cb0' }}>{stats.total_organizations}</div>
          </div>
          <div style={{ background: '#f7fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '8px 12px' }}>
            <span style={{ fontSize: '11px', color: '#718096', textTransform: 'uppercase', fontWeight: 600 }}>Total Vehicles</span>
            <div style={{ fontSize: '20px', fontWeight: 800, color: '#2b6cb0' }}>{stats.total_vehicles}</div>
          </div>
          <div style={{ background: '#f7fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '8px 12px' }}>
            <span style={{ fontSize: '11px', color: '#718096', textTransform: 'uppercase', fontWeight: 600 }}>Active Trips</span>
            <div style={{ fontSize: '20px', fontWeight: 800, color: '#38a169' }}>{stats.total_active_trips}</div>
          </div>
          <div style={{ background: '#f7fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '8px 12px' }}>
            <span style={{ fontSize: '11px', color: '#718096', textTransform: 'uppercase', fontWeight: 600 }}>Total Readings</span>
            <div style={{ fontSize: '20px', fontWeight: 800, color: '#805ad5' }}>{stats.total_readings}</div>
          </div>
        </div>
      )}

      {/* Grid Layout for Maximized vs Normal Mode */}
      <div style={{
        display: isMaximized ? 'grid' : 'block',
        gridTemplateColumns: isMaximized ? '1fr 1fr' : '1fr',
        gap: '20px',
      }}>
        <div>
          {/* ── Section 1: User Management ── */}
          <div style={{ borderTop: '1px solid #edf2f7', paddingTop: '12px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <strong>User Management ({filteredUsers.length} Users)</strong>
            </div>

            {/* User Search Input */}
            <input
              type="text"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="Filter by email or organization..."
              style={{ width: '100%', marginBottom: '8px', padding: '6px 10px', fontSize: '13px', borderRadius: '6px', border: '1px solid #cbd5e0' }}
            />

            <div className="history-trips" style={{ maxHeight: isMaximized ? '320px' : '200px', overflowY: 'auto' }}>
              {filteredUsers.length === 0 && <p className="muted">No users found.</p>}
              {filteredUsers.map((user) => (
                <div
                  key={user.id}
                  className="history-trip"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '8px 10px' }}
                >
                  <div style={{ overflow: 'hidden' }}>
                    <div style={{ fontWeight: 600, fontSize: '13px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                      {user.email}
                    </div>
                    <div style={{ fontSize: '11px', color: '#718096', marginTop: '2px' }}>
                      <span style={{
                        display: 'inline-block',
                        padding: '1px 6px',
                        borderRadius: '4px',
                        background: user.role === 'super_admin' ? '#ebf8ff' : '#f7fafc',
                        color: user.role === 'super_admin' ? '#2b6cb0' : '#4a5568',
                        fontWeight: 600,
                        marginRight: '6px',
                      }}>
                        {user.role}
                      </span>
                      {user.org_name ? user.org_name : 'Global Admin'}
                      {user.password_hint && (
                        <span style={{ marginLeft: '8px', color: '#2b6cb0', fontWeight: 600, background: '#ebf8ff', padding: '1px 6px', borderRadius: '4px' }}>
                          🔑 {user.password_hint}
                        </span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <button
                      type="button"
                      onClick={() => handleResetPassword(user.id, user.email)}
                      disabled={busyAction === `reset-${user.id}`}
                      style={{
                        background: '#ebf8ff',
                        border: '1px solid #bee3f8',
                        color: '#2b6cb0',
                        borderRadius: '6px',
                        padding: '3px 8px',
                        cursor: 'pointer',
                        fontSize: '11px',
                        fontWeight: 600,
                        flexShrink: 0,
                      }}
                    >
                      {busyAction === `reset-${user.id}` ? 'Resetting…' : 'Reset Pass'}
                    </button>

                    {user.role !== 'super_admin' ? (
                      <button
                        type="button"
                        onClick={() => handleRemoveUser(user.id, user.email)}
                        disabled={deletingUserId === user.id}
                        style={{
                          background: '#fff5f5',
                          border: '1px solid #feb2b2',
                          color: '#c53030',
                          borderRadius: '6px',
                          padding: '3px 10px',
                          cursor: 'pointer',
                          fontSize: '11px',
                          fontWeight: 600,
                          flexShrink: 0,
                        }}
                      >
                        {deletingUserId === user.id ? '...' : 'Delete'}
                      </button>
                    ) : (
                      <span
                        style={{
                          fontSize: '11px',
                          color: '#a0aec0',
                          fontWeight: 600,
                          padding: '3px 8px',
                          background: '#edf2f7',
                          borderRadius: '6px',
                          flexShrink: 0,
                        }}
                      >
                        Protected
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Section 2: Create User Form ── */}
          <div style={{ borderTop: '1px solid #edf2f7', paddingTop: '12px', marginBottom: '16px' }}>
            <strong>Create New User</strong>
            <form className="admin-form" onSubmit={handleAddUser} style={{ marginTop: '8px' }}>
              <label>
                Email
                <input
                  type="email"
                  value={newUserEmail}
                  onChange={(e) => setNewUserEmail(e.target.value)}
                  placeholder="user@example.com"
                  required
                />
              </label>

              <label>
                Password
                <input
                  type="password"
                  value={newUserPassword}
                  onChange={(e) => setNewUserPassword(e.target.value)}
                  placeholder="Set account password"
                  required
                />
              </label>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <label>
                  Role
                  <select value={newUserRole} onChange={(e) => setNewUserRole(e.target.value as 'user' | 'super_admin')}>
                    <option value="user">Org User</option>
                    <option value="super_admin">Super Admin</option>
                  </select>
                </label>

                {newUserRole === 'user' && (
                  <label>
                    Assign Org
                    <select value={selectedOrgId ?? ''} onChange={(e) => setSelectedOrgId(Number(e.target.value))}>
                      {orgs.map((org) => (
                        <option key={org.id} value={org.id}>{org.name}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <button type="submit" className="upload-button" style={{ marginTop: '6px' }} disabled={busyAction === 'user'}>
                {busyAction === 'user' ? 'Creating…' : 'Create Account'}
              </button>
            </form>
          </div>
        </div>

        <div>
          {/* ── Section 3: Organizations ── */}
          <div style={{ borderTop: '1px solid #edf2f7', paddingTop: '12px', marginBottom: '16px' }}>
            <strong>Organizations ({orgs.length})</strong>
            
            <form className="admin-form" onSubmit={handleAddOrg} style={{ marginTop: '8px', marginBottom: '8px' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="New organization name..."
                  style={{ flex: 1 }}
                />
                <button type="submit" className="upload-button" style={{ padding: '6px 12px' }} disabled={busyAction === 'organization'}>
                  {busyAction === 'organization' ? 'Adding…' : 'Add'}
                </button>
              </div>
            </form>

            <div className="history-trips" style={{ maxHeight: isMaximized ? '260px' : '160px', overflowY: 'auto' }}>
              {orgs.map((org) => (
                <div
                  key={org.id}
                  className="history-trip"
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px' }}
                >
                  <div>
                    <strong style={{ fontSize: '13px' }}>{org.name}</strong>
                    <div style={{ fontSize: '11px', color: '#718096' }}>ID: #{org.id}</div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleDeleteOrg(org.id, org.name)}
                    disabled={deletingOrgId === org.id}
                    style={{
                      background: '#fff5f5',
                      border: '1px solid #feb2b2',
                      color: '#c53030',
                      borderRadius: '6px',
                      padding: '3px 10px',
                      cursor: 'pointer',
                      fontSize: '11px',
                      fontWeight: 600,
                    }}
                  >
                    {deletingOrgId === org.id ? 'Deleting...' : 'Delete Org'}
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* ── Section 4: Invites Management ── */}
          <div style={{ borderTop: '1px solid #edf2f7', paddingTop: '12px' }}>
            <strong>Invite Links ({invites.length})</strong>
            
            <form className="admin-form" onSubmit={handleAddInvite} style={{ marginTop: '8px', marginBottom: '8px' }}>
              <label>
                Target Org
                <select value={selectedOrgId ?? ''} onChange={(e) => setSelectedOrgId(Number(e.target.value))}>
                  {orgs.map((org) => (
                    <option key={org.id} value={org.id}>{org.name}</option>
                  ))}
                </select>
              </label>
              
              <label>
                Restrict to Email (Optional)
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="Leave blank for open invite link"
                />
              </label>

              <button type="submit" className="trip-button start" disabled={busyAction === 'invite'}>
                {busyAction === 'invite' ? 'Generating…' : 'Generate Invite Link'}
              </button>
            </form>

            {copied && <p className="muted" style={{ color: '#38a169', fontWeight: 600 }}>Copied to clipboard!</p>}

            <div className="history-trips" style={{ maxHeight: isMaximized ? '220px' : '150px', overflowY: 'auto' }}>
              {invites.map((invite) => (
                <div
                  key={invite.id}
                  className="history-trip"
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px' }}
                >
                  <div>
                    <strong style={{ fontSize: '12px' }}>{invite.org_name}</strong>
                    <div style={{ fontSize: '11px', color: '#718096' }}>
                      {invite.email ? invite.email : 'Open Link'} · {invite.used_at ? 'Used' : 'Active'}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(invite.invite_url)
                        setCopied(invite.invite_url)
                      }}
                      style={{ background: '#edf2f7', border: 'none', borderRadius: '4px', padding: '2px 6px', fontSize: '11px', cursor: 'pointer' }}
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveInvite(invite.id)}
                      disabled={deletingInviteId === invite.id}
                      style={{ background: '#fff5f5', border: '1px solid #feb2b2', color: '#c53030', borderRadius: '4px', padding: '2px 6px', fontSize: '11px', cursor: 'pointer' }}
                    >
                      Revoke
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </aside>
  )
}
