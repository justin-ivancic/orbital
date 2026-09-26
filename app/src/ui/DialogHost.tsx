import { useState, type FormEvent } from 'react'
import { closeDialog, useCurrentDialog, type DialogRequest } from '../app/dialogs'
import { useT } from '../i18n'
import { Sheet } from './Sheet'

function PromptDialog({ request }: { request: Extract<DialogRequest, { kind: 'prompt' }> }) {
  const t = useT()
  const [value, setValue] = useState(request.initialValue ?? '')
  const tooShort = request.minLength != null && value.length < request.minLength

  const finish = (result: string | null) => {
    closeDialog(request.id)
    request.resolve(result)
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!tooShort && value.trim()) {
      finish(value)
    }
  }

  return (
    <Sheet dismissible={false} onClose={() => finish(null)} title={request.title}>
      <form className="stack" id={`prompt-${request.id}`} onSubmit={submit}>
        <label className="field">
          <span className="field__label">{request.label}</span>
          <input
            autoCapitalize="none"
            autoComplete={request.inputType === 'password' ? 'new-password' : 'off'}
            autoCorrect="off"
            className="input"
            minLength={request.minLength}
            onChange={(event) => setValue(event.target.value)}
            spellCheck={false}
            type={request.inputType}
            value={value}
          />
          {request.hint && <span className="field__hint">{request.hint}</span>}
        </label>
        <div className="cluster" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={() => finish(null)} type="button">
            {t.common.cancel}
          </button>
          <button className="btn btn--primary" disabled={tooShort || !value.trim()} type="submit">
            {request.confirmLabel}
          </button>
        </div>
      </form>
    </Sheet>
  )
}

function ConfirmDialog({ request }: { request: Extract<DialogRequest, { kind: 'confirm' }> }) {
  const t = useT()

  const finish = (confirmed: boolean) => {
    closeDialog(request.id)
    request.resolve(confirmed)
  }

  return (
    <Sheet
      footer={(
        <>
          <button className="btn" onClick={() => finish(false)} type="button">
            {t.common.cancel}
          </button>
          <button
            className={`btn ${request.danger ? 'btn--danger' : 'btn--primary'}`}
            data-autofocus
            onClick={() => finish(true)}
            type="button"
          >
            {request.confirmLabel}
          </button>
        </>
      )}
      onClose={() => finish(false)}
      title={request.title}
    >
      {request.body && <p>{request.body}</p>}
    </Sheet>
  )
}

/** Renders the queued confirm and prompt dialogs one at a time. */
export function DialogHost() {
  const request = useCurrentDialog()

  if (!request) {
    return null
  }

  return request.kind === 'confirm'
    ? <ConfirmDialog key={request.id} request={request} />
    : <PromptDialog key={request.id} request={request} />
}
