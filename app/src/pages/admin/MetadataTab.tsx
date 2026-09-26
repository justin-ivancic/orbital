import { ChevronRight, Search } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api, type AdminSettings } from '../../api'
import type { SeriesSummary } from '../../appTypes'
import { confirmAction } from '../../app/dialogs'
import { getSeriesIndex, libraryStore, type LibraryState } from '../../app/library'
import { notify } from '../../app/notices'
import { navigate } from '../../app/router'
import { applyState } from '../../app/session'
import { seriesCreator, seriesTitle } from '../../app/seriesText'
import { useStore } from '../../app/store'
import { useT } from '../../i18n'
import { seriesRoute } from '../../routing'
import { SectionHead, Switch } from '../../ui/bits'
import { Cover } from '../../ui/Cover'
import { Sheet } from '../../ui/Sheet'

const selectLibrary = (state: LibraryState) => state.library
const selectQueue = (state: LibraryState) => state.metadataQueue

function MetadataEditor({ series, onClose }: { series: SeriesSummary; onClose: () => void }) {
  const t = useT()
  const m = t.admin.metadata
  const [title, setTitle] = useState(series.title)
  const [year, setYear] = useState(series.year != null ? String(series.year) : '')
  const [creator, setCreator] = useState(series.sourceName ?? '')
  const [role, setRole] = useState(series.sourceRole ?? '')
  const [description, setDescription] = useState(series.description)
  const [url, setUrl] = useState(series.externalUrl ?? '')
  const [coverUrl, setCoverUrl] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (action: () => ReturnType<typeof api.saveMetadataOverride>, message?: string) => {
    setBusy(true)

    try {
      applyState(await action())

      if (message) {
        notify(message)
      }

      onClose()
    } catch (error) {
      notify(error instanceof Error ? error.message : t.common.somethingWentWrong, 'error')
    } finally {
      setBusy(false)
    }
  }

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void run(
      () =>
        api.saveMetadataOverride(series.id, {
          title,
          year: year.trim() ? Number(year) : null,
          description,
          sourceName: creator,
          sourceRole: role,
          externalUrl: url,
          coverImageUrl: coverUrl.trim() || null,
        }),
      m.saved,
    )
  }

  const restore = async () => {
    const confirmed = await confirmAction({ title: m.restore, confirmLabel: m.restore, danger: true })

    if (confirmed) {
      await run(() => api.clearMetadataOverride(series.id))
    }
  }

  return (
    <Sheet dismissible={false} onClose={onClose} title={m.edit} wide>
      <div className="metadata-editor__head">
        <div className="metadata-editor__cover">
          <Cover series={series} />
        </div>
        <div>
          <strong>{seriesTitle(series)}</strong>
          <p className="text-muted text-small">
            {m.current}: {series.metadataSource} · {series.coverSource}
          </p>
        </div>
      </div>
      <form className="stack" id="metadata-form" onSubmit={save}>
        <div className="form-grid">
          <label className="field form-grid__wide">
            <span className="field__label">{m.fieldTitle}</span>
            <input className="input" onChange={(event) => setTitle(event.target.value)} value={title} />
          </label>
          <label className="field">
            <span className="field__label">{m.fieldAuthor}</span>
            <input className="input" onChange={(event) => setCreator(event.target.value)} value={creator} />
          </label>
          <label className="field">
            <span className="field__label">{m.fieldRole}</span>
            <input className="input" onChange={(event) => setRole(event.target.value)} value={role} />
          </label>
          <label className="field">
            <span className="field__label">{m.fieldYear}</span>
            <input className="input" inputMode="numeric" onChange={(event) => setYear(event.target.value)} value={year} />
          </label>
          <label className="field">
            <span className="field__label">{m.fieldUrl}</span>
            <input className="input" onChange={(event) => setUrl(event.target.value)} type="url" value={url} />
          </label>
          <label className="field form-grid__wide">
            <span className="field__label">{m.fieldCover}</span>
            <input
              className="input"
              onChange={(event) => setCoverUrl(event.target.value)}
              placeholder="https://"
              type="url"
              value={coverUrl}
            />
          </label>
          <label className="field form-grid__wide">
            <span className="field__label">{m.fieldDescription}</span>
            <textarea className="textarea" onChange={(event) => setDescription(event.target.value)} rows={6} value={description} />
          </label>
        </div>
        <div className="sheet-actions">
          <button className="btn btn--small" disabled={busy} onClick={() => void restore()} type="button">
            {m.restore}
          </button>
          <button
            className="btn btn--small"
            disabled={busy}
            onClick={() => void run(() => api.refreshSeriesMetadata(series.id))}
            type="button"
          >
            {m.lookUp}
          </button>
          <button
            className="btn btn--small"
            onClick={() => {
              onClose()
              navigate(seriesRoute(series.category, series.id))
            }}
            type="button"
          >
            {m.openTitle}
          </button>
          <span className="spacer" />
          <button className="btn btn--primary" disabled={busy} type="submit">
            {busy ? t.common.saving : m.save}
          </button>
        </div>
      </form>
    </Sheet>
  )
}

export function MetadataTab() {
  const t = useT()
  const m = t.admin.metadata
  const library = useStore(libraryStore, selectLibrary)
  const queue = useStore(libraryStore, selectQueue)
  const [settings, setSettings] = useState<AdminSettings | null>(null)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.getAdminSettings().then((value) => {
      if (!cancelled) {
        setSettings(value)
      }
    }).catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [])

  const toggleOnline = async (enabled: boolean) => {
    try {
      setSettings(await api.updateAdminSettings({ remoteMetadataEnabled: enabled }))
    } catch (error) {
      notify(error instanceof Error ? error.message : t.common.somethingWentWrong, 'error')
    }
  }

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()

    if (needle.length < 2) {
      return []
    }

    return library
      .filter((series) =>
        `${series.title} ${seriesCreator(series) ?? ''}`.toLowerCase().includes(needle),
      )
      .slice(0, 12)
  }, [library, query])

  const editingSeries = editing ? getSeriesIndex(library).get(editing) ?? null : null

  return (
    <div className="stack" style={{ gap: 'var(--space-8)' }}>
      <section className="panel setting-card">
        <div className="setting-card__text">
          <strong>{m.online}</strong>
          <p className="text-muted text-small">{m.onlineHelp}</p>
          {settings?.remoteMetadata.lockedByEnvironment && <p className="text-small">{m.lockedByServer}</p>}
        </div>
        <Switch
          checked={settings?.remoteMetadata.enabled ?? false}
          disabled={!settings || settings.remoteMetadata.lockedByEnvironment}
          label={m.online}
          onChange={(enabled) => void toggleOnline(enabled)}
        />
      </section>

      <section className="section">
        <SectionHead title={m.find} />
        <label className="search-input">
          <Search aria-hidden="true" />
          <span className="visually-hidden">{m.find}</span>
          <input
            className="input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={m.findPlaceholder}
            type="search"
            value={query}
          />
        </label>
        {matches.length > 0 && (
          <ul className="list">
            {matches.map((series) => (
              <li key={series.id}>
                <button className="list-row" onClick={() => setEditing(series.id)} type="button">
                  <span className="list-row__body">
                    <span className="list-row__title">{seriesTitle(series)}</span>
                    <span className="list-row__meta">
                      {[t.categories[series.category], seriesCreator(series), series.year].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <ChevronRight aria-hidden="true" className="list-row__chevron" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        <SectionHead meta={queue.length} title={m.review} />
        {queue.length === 0 ? (
          <p className="text-muted">{m.reviewEmpty}</p>
        ) : (
          <ul className="list">
            {queue.slice(0, 100).map((item) => (
              <li key={item.id}>
                <button className="list-row review-row" onClick={() => setEditing(item.id)} type="button">
                  <span className="review-row__cover">
                    {getSeriesIndex(library).get(item.id) ? (
                      <Cover compact series={getSeriesIndex(library).get(item.id)!} />
                    ) : null}
                  </span>
                  <span className="list-row__body">
                    <span className="list-row__title">{item.title}</span>
                    <span className="list-row__meta">{t.categories[item.category]} · {item.reason}</span>
                  </span>
                  <ChevronRight aria-hidden="true" className="list-row__chevron" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editingSeries && <MetadataEditor onClose={() => setEditing(null)} series={editingSeries} />}
    </div>
  )
}
