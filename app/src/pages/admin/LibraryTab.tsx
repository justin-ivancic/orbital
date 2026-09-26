import { FolderPlus, HardDrive, RefreshCw, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../../api'
import type { CategoryId, SourceFolder } from '../../appTypes'
import { useNow } from '../../app/clock'
import { confirmAction } from '../../app/dialogs'
import { libraryStore, type LibraryState } from '../../app/library'
import { notify } from '../../app/notices'
import { watchScanClosely } from '../../app/scan'
import { applyState } from '../../app/session'
import { shallowEqual, useStore } from '../../app/store'
import { formatDateTime, formatRelative, useT } from '../../i18n'
import { EmptyState, Meter, SectionHead } from '../../ui/bits'
import { AddFolderSheet } from './AddFolderSheet'

const selectLibraryAdmin = (state: LibraryState) => ({
  scanStatus: state.scanStatus,
  scanSummary: state.scanSummary,
  sourceFolders: state.sourceFolders,
  sourceRoots: state.sourceRoots,
})

const folderName = (folder: SourceFolder) => folder.relativePath.split('/').filter(Boolean).pop() || folder.path

const folderCategories: CategoryId[] = ['books', 'manga', 'novels', 'magazines']

const runAdminAction = async (action: () => Promise<Parameters<typeof applyState>[0]>, fallback: string) => {
  try {
    applyState(await action())
    return true
  } catch (error) {
    notify(error instanceof Error ? error.message : fallback, 'error')
    return false
  }
}

function ScanCard() {
  const t = useT()
  const s = t.admin.scan
  const now = useNow()
  const { scanStatus, scanSummary } = useStore(libraryStore, selectLibraryAdmin, shallowEqual)
  const [starting, setStarting] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const active = scanStatus.active
  const seriesRatio =
    scanStatus.currentSourceSeriesTotal && scanStatus.currentSourceSeriesTotal > 0
      ? scanStatus.currentSourceSeriesCompleted / scanStatus.currentSourceSeriesTotal
      : 0
  const overall =
    scanStatus.totalSources > 0
      ? Math.min(1, (scanStatus.completedSources + seriesRatio) / scanStatus.totalSources)
      : 0
  const lastScanAt = scanStatus.finishedAt ?? scanSummary.lastScanAt

  const scan = async () => {
    setStarting(true)
    watchScanClosely()
    await runAdminAction(() => api.runScan(), t.common.somethingWentWrong)
    setStarting(false)
  }

  return (
    <section className={`panel scan-card${active ? ' scan-card--active' : ''}`}>
      <div className="scan-card__head">
        <div className="scan-card__title">
          <span className="kicker">{s.title}</span>
          <h2>{active ? s.running : s.idle}</h2>
          <p className="text-muted text-small">
            {lastScanAt ? s.lastScan(formatRelative(lastScanAt, t, now)) : s.never}
          </p>
        </div>
        <button className="btn btn--primary" disabled={active || starting} onClick={() => void scan()} type="button">
          <RefreshCw aria-hidden="true" />
          {starting ? s.starting : s.scanNow}
        </button>
      </div>

      {active && (
        <div className="scan-card__progress">
          <Meter label={s.running} value={overall} />
          <dl className="details-list">
            {scanStatus.totalSources > 0 && (
              <>
                <dt>{s.labelFolder}</dt>
                <dd>
                  {s.folderProgress(scanStatus.completedSources, scanStatus.totalSources)}
                  {scanStatus.currentSource ? ` · ${scanStatus.currentSource}` : ''}
                </dd>
              </>
            )}
            {scanStatus.currentSourceFilesDiscovered != null && (
              <>
                <dt>{s.labelFiles}</dt>
                <dd>{s.filesFound(scanStatus.currentSourceFilesDiscovered)}</dd>
              </>
            )}
            {scanStatus.currentSourceSeriesTotal ? (
              <>
                <dt>{s.labelTitles}</dt>
                <dd>{s.titlesProgress(scanStatus.currentSourceSeriesCompleted, scanStatus.currentSourceSeriesTotal)}</dd>
              </>
            ) : null}
            {scanStatus.currentSeries && (
              <>
                <dt>{s.current}</dt>
                <dd>{scanStatus.currentSeries}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      {!active && scanStatus.summary && (
        <p className="scan-card__summary">
          <strong>{s.summary}:</strong> {scanStatus.summary}
        </p>
      )}

      <button className="link-btn" onClick={() => setLogOpen((value) => !value)} type="button">
        {logOpen ? s.hideLog : s.showLog}
      </button>
      {logOpen && (
        <ol className="scan-log">
          {scanStatus.events.length === 0 ? (
            <li className="text-muted">{s.logEmpty}</li>
          ) : (
            [...scanStatus.events].reverse().map((event) => (
              <li className={`scan-log__item scan-log__item--${event.level}`} key={event.id}>
                <span className="scan-log__time">{formatDateTime(event.createdAt, t)}</span>
                <span>{event.message}</span>
              </li>
            ))
          )}
        </ol>
      )}
    </section>
  )
}

function FolderRow({ folder, busy, onBusy }: { folder: SourceFolder; busy: boolean; onBusy: (busy: boolean) => void }) {
  const t = useT()
  const f = t.admin.folders
  const now = useNow()
  const name = folderName(folder)

  const rescan = async () => {
    onBusy(true)
    watchScanClosely()
    await runAdminAction(() => api.runScan(folder.id), t.common.somethingWentWrong)
    onBusy(false)
  }

  const changeType = async (category: CategoryId) => {
    if (category === folder.category) {
      return
    }

    const confirmed = await confirmAction({
      title: f.changeType,
      body: f.changeTypeConfirm(name, t.categories[category]),
      confirmLabel: f.changeType,
    })

    if (confirmed) {
      onBusy(true)
      watchScanClosely()
      await runAdminAction(() => api.updateSource(folder.id, { category }), t.common.somethingWentWrong)
      onBusy(false)
    }
  }

  const remove = async () => {
    const confirmed = await confirmAction({
      title: f.remove,
      body: f.removeConfirm(name),
      confirmLabel: f.remove,
      danger: true,
    })

    if (confirmed) {
      onBusy(true)
      await runAdminAction(() => api.deleteSource(folder.id), t.common.somethingWentWrong)
      onBusy(false)
    }
  }

  return (
    <li className="folder-row">
      <div className="folder-row__main">
        <span className="folder-row__name">{name}</span>
        <span className="folder-row__path" title={folder.path}>{folder.path}</span>
        <span className="folder-row__meta">
          {[folder.items, folder.status, folder.lastScanAt ? f.lastScan(formatRelative(folder.lastScanAt, t, now)) : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      <div className="folder-row__actions">
        <label className="folder-row__type">
          <span className="visually-hidden">{f.changeType}</span>
          <select
            className="select"
            disabled={busy}
            onChange={(event) => void changeType(event.target.value as CategoryId)}
            value={folder.category}
          >
            {[...new Set([folder.category, ...folderCategories])].map((category) => (
              <option key={category} value={category}>
                {t.categories[category]}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn--small" disabled={busy} onClick={() => void rescan()} type="button">
          <RefreshCw aria-hidden="true" />
          {f.rescan}
        </button>
        <button
          aria-label={`${f.remove}: ${name}`}
          className="icon-btn icon-btn--outlined icon-btn--small"
          disabled={busy}
          onClick={() => void remove()}
          type="button"
        >
          <Trash2 aria-hidden="true" />
        </button>
      </div>
    </li>
  )
}

function RootsSection() {
  const t = useT()
  const r = t.admin.roots
  const { sourceRoots } = useStore(libraryStore, selectLibraryAdmin, shallowEqual)
  const [label, setLabel] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)

    if (await runAdminAction(() => api.createRoot({ label: label.trim() || path.trim(), path: path.trim() }), t.common.somethingWentWrong)) {
      setLabel('')
      setPath('')
    }

    setBusy(false)
  }

  const remove = async (rootId: string, name: string) => {
    const confirmed = await confirmAction({ title: r.remove, body: r.removeConfirm(name), confirmLabel: r.remove, danger: true })

    if (confirmed) {
      await runAdminAction(() => api.deleteRoot(rootId), t.common.somethingWentWrong)
    }
  }

  return (
    <details className="panel roots">
      <summary className="roots__summary">
        <HardDrive aria-hidden="true" />
        {r.title}
        <span className="badge-count">{sourceRoots.length}</span>
      </summary>
      <p className="text-muted text-small">{r.intro}</p>
      <ul className="list">
        {sourceRoots.map((root) => (
          <li className="list-row" key={root.id}>
            <span className="list-row__body">
              <span className="list-row__title">{root.label}</span>
              <span className="list-row__meta">{root.path}{root.managed ? ` · ${r.managed}` : ''}</span>
            </span>
            {!root.managed && (
              <button
                aria-label={`${r.remove}: ${root.label}`}
                className="icon-btn icon-btn--small"
                onClick={() => void remove(root.id, root.label)}
                type="button"
              >
                <Trash2 aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <form className="inline-form" onSubmit={(event) => void add(event)}>
        <label className="field">
          <span className="field__label">{r.label}</span>
          <input className="input" onChange={(event) => setLabel(event.target.value)} value={label} />
        </label>
        <label className="field" style={{ flex: 2 }}>
          <span className="field__label">{r.path}</span>
          <input
            autoCapitalize="none"
            autoCorrect="off"
            className="input"
            onChange={(event) => setPath(event.target.value)}
            placeholder="/media/library"
            required
            spellCheck={false}
            value={path}
          />
        </label>
        <button className="btn" disabled={busy || !path.trim()} type="submit">
          {r.add}
        </button>
      </form>
    </details>
  )
}

export function LibraryTab() {
  const t = useT()
  const f = t.admin.folders
  const { sourceFolders, sourceRoots, scanStatus } = useStore(libraryStore, selectLibraryAdmin, shallowEqual)
  const [adding, setAdding] = useState(false)
  const [busyFolder, setBusyFolder] = useState<string | null>(null)

  return (
    <div className="stack admin-library" style={{ gap: 'var(--space-8)' }}>
      <ScanCard />

      <section className="section">
        <SectionHead
          action={
            <button className="btn btn--small btn--primary" disabled={sourceRoots.length === 0} onClick={() => setAdding(true)} type="button">
              <FolderPlus aria-hidden="true" />
              {f.add}
            </button>
          }
          title={f.title}
        />
        <p className="text-muted text-small">{f.intro}</p>
        {sourceFolders.length === 0 ? (
          <EmptyState
            action={
              <button className="btn btn--primary" disabled={sourceRoots.length === 0} onClick={() => setAdding(true)} type="button">
                <FolderPlus aria-hidden="true" />
                {f.add}
              </button>
            }
            icon={FolderPlus}
            title={f.empty}
          />
        ) : (
          <ul className="folder-list">
            {sourceFolders.map((folder) => (
              <FolderRow
                busy={scanStatus.active || busyFolder === folder.id}
                folder={folder}
                key={folder.id}
                onBusy={(busy) => setBusyFolder(busy ? folder.id : null)}
              />
            ))}
          </ul>
        )}
      </section>

      <RootsSection />

      {adding && <AddFolderSheet onClose={() => setAdding(false)} roots={sourceRoots} />}
    </div>
  )
}
