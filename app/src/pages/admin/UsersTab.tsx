import { KeyRound, Trash2, UserPlus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../../api'
import type { Role, UserSummary } from '../../appTypes'
import { useNow } from '../../app/clock'
import { confirmAction, promptValue } from '../../app/dialogs'
import { libraryStore, type LibraryState } from '../../app/library'
import { notify } from '../../app/notices'
import { applyState, sessionStore, useUser } from '../../app/session'
import { useStore } from '../../app/store'
import { formatRelative, useT } from '../../i18n'
import { Segmented, SectionHead } from '../../ui/bits'
import { Sheet } from '../../ui/Sheet'

const selectUsers = (state: LibraryState) => state.users
const selectOpenSignup = (state: { openSignup: boolean }) => state.openSignup

function AddUserSheet({ onClose }: { onClose: () => void }) {
  const t = useT()
  const u = t.admin.users
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError(null)

    try {
      applyState(await api.createUser({ username: username.trim(), password, role }))
      notify(u.created(username.trim()))
      onClose()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t.common.somethingWentWrong)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet dismissible={false} onClose={onClose} title={u.add}>
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span className="field__label">{u.username}</span>
          <input
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            className="input"
            maxLength={64}
            minLength={2}
            onChange={(event) => setUsername(event.target.value)}
            required
            spellCheck={false}
            value={username}
          />
        </label>
        <label className="field">
          <span className="field__label">{u.password}</span>
          <input
            autoComplete="new-password"
            className="input"
            minLength={8}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          <span className="field__hint">{t.auth.passwordHint}</span>
        </label>
        <div className="field">
          <span className="field__label">{u.role}</span>
          <Segmented
            block
            label={u.role}
            onChange={setRole}
            options={[
              { value: 'member', label: u.roleMember },
              { value: 'admin', label: u.roleAdmin },
            ]}
            value={role}
          />
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="sheet-actions">
          <button className="btn" onClick={onClose} type="button">
            {t.common.cancel}
          </button>
          <button className="btn btn--primary" disabled={busy || username.trim().length < 2 || password.length < 8} type="submit">
            {u.add}
          </button>
        </div>
      </form>
    </Sheet>
  )
}

function UserRow({ user, isSelf }: { user: UserSummary; isSelf: boolean }) {
  const t = useT()
  const u = t.admin.users
  const now = useNow()
  const [busy, setBusy] = useState(false)
  const isAdmin = (user.roleId ?? (user.role.toLowerCase().includes('admin') ? 'admin' : 'member')) === 'admin'

  const reset = async () => {
    const password = await promptValue({
      title: u.resetPassword,
      label: u.newPasswordFor(user.name),
      hint: t.auth.passwordHint,
      inputType: 'password',
      minLength: 8,
      confirmLabel: u.resetPassword,
    })

    if (!password) {
      return
    }

    setBusy(true)

    try {
      applyState(await api.resetPassword(user.id, { password }))
      notify(u.passwordReset(user.name))
    } catch (error) {
      notify(error instanceof Error ? error.message : t.common.somethingWentWrong, 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const confirmed = await confirmAction({
      title: u.remove,
      body: u.removeConfirm(user.name),
      confirmLabel: u.remove,
      danger: true,
    })

    if (!confirmed) {
      return
    }

    setBusy(true)

    try {
      applyState(await api.deleteUser(user.id))
    } catch (error) {
      notify(error instanceof Error ? error.message : t.common.somethingWentWrong, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="user-row">
      <span aria-hidden="true" className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
      <div className="user-row__body">
        <span className="user-row__name">
          {user.name}
          {isSelf && <span className="chip chip--quiet">{u.you}</span>}
          {isAdmin && <span className="chip chip--solid">{u.roleAdmin}</span>}
        </span>
        <span className="user-row__meta">
          {[
            user.createdAt ? u.joined(formatRelative(user.createdAt, t, now)) : null,
            user.lastReadAt ? u.lastRead(formatRelative(user.lastReadAt, t, now)) : u.neverRead,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      <div className="user-row__actions">
        <button className="btn btn--small" disabled={busy} onClick={() => void reset()} type="button">
          <KeyRound aria-hidden="true" />
          {u.resetPassword}
        </button>
        {!isSelf && (
          <button
            aria-label={`${u.remove}: ${user.name}`}
            className="icon-btn icon-btn--outlined icon-btn--small"
            disabled={busy}
            onClick={() => void remove()}
            type="button"
          >
            <Trash2 aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  )
}

export function UsersTab() {
  const t = useT()
  const u = t.admin.users
  const users = useStore(libraryStore, selectUsers)
  const openSignup = useStore(sessionStore, selectOpenSignup)
  const me = useUser()
  const [adding, setAdding] = useState(false)

  return (
    <section className="section">
      <SectionHead
        action={
          <button className="btn btn--small btn--primary" onClick={() => setAdding(true)} type="button">
            <UserPlus aria-hidden="true" />
            {u.add}
          </button>
        }
        meta={users.length}
        title={u.title}
      />
      <p className="text-muted text-small">{openSignup ? u.signupOpen : u.signupClosed}</p>
      <ul className="user-list">
        {users.map((user) => (
          <UserRow isSelf={user.id === me?.id} key={user.id} user={user} />
        ))}
      </ul>
      {adding && <AddUserSheet onClose={() => setAdding(false)} />}
    </section>
  )
}
