import { ArrowUp, BookOpen, Check, ChevronRight, Folder, Images, Newspaper, ScrollText } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../../api'
import type { DirectoryListing, SourceRoot } from '../../appTypes'
import { libraryStore, type LibraryState } from '../../app/library'
import { notify } from '../../app/notices'
import { watchScanClosely } from '../../app/scan'
import { applyState } from '../../app/session'
import { useStore } from '../../app/store'
import { useT } from '../../i18n'
import type { LibraryRouteCategory } from '../../routing'
import { Sheet } from '../../ui/Sheet'

type Step = 'type' | 'folder' | 'confirm'

const selectAdminFolders = (state: LibraryState) => state.sourceFolders

const normalizePath = (value: string) =>
  value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '')

const leafName = (relativePath: string) => relativePath.split('/').filter(Boolean).pop() || '/'

/** Keeps the last few folders of a long path readable in a narrow bar. */
const shortPath = (value: string, keep = 3) => {
  const parts = value.split('/').filter(Boolean)
  return parts.length > keep ? `…/${parts.slice(-keep).join('/')}` : value
}

const joinDisplayPath = (base: string, relative: string) =>
  relative ? `${base.replace(/[\\/]+$/, '')}/${relative.replace(/^[\\/]+/, '')}` : base

/** Turns a pasted absolute path into a path relative to the storage root. */
const relativeToRoot = (value: string, root: SourceRoot) => {
  const input = normalizePath(value)
  const rootPath = normalizePath(root.path)

  if (!input) {
    return ''
  }

  if (input.toLowerCase() === rootPath.toLowerCase()) {
    return ''
  }

  if (rootPath && input.toLowerCase().startsWith(`${rootPath.toLowerCase()}/`)) {
    return input.slice(rootPath.length + 1)
  }

  if (/^[a-z]:\//i.test(input) || input.startsWith('/')) {
    return null
  }

  return input.replace(/^\/+/, '')
}

const typeIcons = { books: BookOpen, manga: Images, novels: ScrollText, magazines: Newspaper }

export function AddFolderSheet({ roots, onClose }: { roots: SourceRoot[]; onClose: () => void }) {
  const t = useT()
  const a = t.admin.addFolder
  const folders = useStore(libraryStore, selectAdminFolders)
  const sortedRoots = useMemo(() => [...roots].sort((left, right) => Number(right.managed) - Number(left.managed)), [roots])
  const [step, setStep] = useState<Step>('type')
  const [category, setCategory] = useState<LibraryRouteCategory>('books')
  const [rootId, setRootId] = useState(sortedRoots[0]?.id ?? '')
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [listingError, setListingError] = useState<string | null>(null)
  const [typedPath, setTypedPath] = useState('')
  const [busy, setBusy] = useState(false)
  const root = sortedRoots.find((item) => item.id === rootId) ?? null

  useEffect(() => {
    if (step !== 'folder' || !rootId) {
      return
    }

    let cancelled = false
    setListingError(null)
    api
      .listDirectories(rootId, path)
      .then((result) => {
        if (!cancelled) {
          setListing(result)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setListing({ currentPath: path, directories: [] })
          setListingError(error instanceof Error ? error.message : t.common.somethingWentWrong)
        }
      })

    return () => {
      cancelled = true
    }
  }, [path, rootId, step, t.common.somethingWentWrong])

  const displayPath = root ? joinDisplayPath(root.path, listing?.currentPath ?? path) : path
  const alreadyAdded = folders.some(
    (folder) => normalizePath(folder.path).toLowerCase() === normalizePath(displayPath).toLowerCase(),
  )
  const currentPath = listing?.currentPath ?? path

  const goToTypedPath = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!root) {
      return
    }

    const relative = relativeToRoot(typedPath, root)

    if (relative == null) {
      setListingError(a.outsideRoot)
      return
    }

    setPath(relative)
  }

  const add = async () => {
    if (!rootId || !currentPath) {
      return
    }

    setBusy(true)

    try {
      applyState(await api.createSource({ rootId, relativePath: currentPath, category }))
      notify(a.added(leafName(currentPath)))
      watchScanClosely()
      onClose()
    } catch (error) {
      notify(error instanceof Error ? error.message : t.common.somethingWentWrong, 'error')
    } finally {
      setBusy(false)
    }
  }

  const steps: Array<{ id: Step; label: string }> = [
    { id: 'type', label: a.stepType },
    { id: 'folder', label: a.stepFolder },
    { id: 'confirm', label: a.stepConfirm },
  ]
  const stepIndex = steps.findIndex((item) => item.id === step)

  return (
    <Sheet dismissible={false} onClose={onClose} title={a.title} wide>
      <ol className="steps">
        {steps.map((item, index) => (
          <li
            aria-current={item.id === step ? 'step' : undefined}
            className={`steps__item${index < stepIndex ? ' is-done' : ''}`}
            key={item.id}
          >
            <span className="steps__number">{index < stepIndex ? <Check aria-hidden="true" size={14} /> : index + 1}</span>
            {item.label}
          </li>
        ))}
      </ol>

      {step === 'type' && (
        <div className="stack">
          <div>
            <h3>{a.typeQuestion}</h3>
            <p className="text-muted text-small">{a.typeHelp}</p>
          </div>
          <div className="choice-grid" role="radiogroup">
            {(['books', 'manga', 'novels', 'magazines'] as const).map((value) => {
              const Icon = typeIcons[value]
              const help = { books: a.typeBooks, manga: a.typeManga, novels: a.typeNovels, magazines: a.typeMagazines }[value]

              return (
                <button
                  aria-checked={category === value}
                  className="choice"
                  key={value}
                  onClick={() => {
                    setCategory(value)
                    setStep('folder')
                  }}
                  role="radio"
                  type="button"
                >
                  <Icon aria-hidden="true" className="choice__icon" />
                  <span className="choice__title">{t.categories[value]}</span>
                  <span className="choice__body">{help}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {step === 'folder' && (
        <div className="stack">
          <h3>{a.folderQuestion}</h3>
          {sortedRoots.length > 1 && (
            <label className="field">
              <span className="field__label">{a.storage}</span>
              <select
                className="select"
                onChange={(event) => {
                  setRootId(event.target.value)
                  setPath('')
                }}
                value={rootId}
              >
                {sortedRoots.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.managed ? `${item.label} (${t.admin.roots.managed})` : item.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="folder-browser">
            <div className="folder-browser__bar">
              <button
                aria-label={a.up}
                className="icon-btn icon-btn--outlined"
                disabled={!currentPath}
                onClick={() => setPath(currentPath.split('/').slice(0, -1).join('/'))}
                type="button"
              >
                <ArrowUp aria-hidden="true" />
              </button>
              <span className="folder-browser__path" title={displayPath}>{shortPath(displayPath)}</span>
            </div>
            <ul className="folder-browser__list">
              {listing?.directories.length ? (
                listing.directories.map((directory) => (
                  <li key={directory.relativePath}>
                    <button
                      aria-label={a.openFolder(directory.name)}
                      className="list-row"
                      onClick={() => setPath(directory.relativePath)}
                      type="button"
                    >
                      <Folder aria-hidden="true" className="list-row__chevron" />
                      <span className="list-row__body">
                        <span className="list-row__title">{directory.name}</span>
                      </span>
                      <ChevronRight aria-hidden="true" className="list-row__chevron" />
                    </button>
                  </li>
                ))
              ) : (
                <li className="folder-browser__empty">{listing ? a.noSubfolders : t.common.loading}</li>
              )}
            </ul>
          </div>
          {listingError && <p className="form-error">{listingError}</p>}

          <form className="inline-form" onSubmit={goToTypedPath}>
            <label className="field" style={{ flex: 1 }}>
              <span className="field__label">{a.typePath}</span>
              <input
                autoCapitalize="none"
                autoCorrect="off"
                className="input"
                onChange={(event) => setTypedPath(event.target.value)}
                placeholder={root?.path ?? '/media/books'}
                spellCheck={false}
                value={typedPath}
              />
            </label>
            <button className="btn" disabled={!typedPath.trim()} type="submit">
              {a.go}
            </button>
          </form>

          <div className="sheet-actions">
            <button className="btn" onClick={() => setStep('type')} type="button">
              {t.common.back}
            </button>
            <button className="btn btn--primary" disabled={!currentPath} onClick={() => setStep('confirm')} type="button">
              {a.useThisFolder}
            </button>
          </div>
          {!currentPath && <p className="text-muted text-small">{a.chooseSubfolder}</p>}
        </div>
      )}

      {step === 'confirm' && (
        <div className="stack">
          <h3>{a.confirmTitle}</h3>
          <dl className="details-list">
            <dt>{t.admin.folders.type}</dt>
            <dd>{t.categories[category]}</dd>
            <dt>{a.stepFolder}</dt>
            <dd>
              <strong>{leafName(currentPath)}</strong>
              <br />
              <span className="text-muted">{displayPath}</span>
            </dd>
          </dl>
          {alreadyAdded && <p className="form-error">{a.alreadyAdded}</p>}
          <div className="sheet-actions">
            <button className="btn" onClick={() => setStep('folder')} type="button">
              {t.common.back}
            </button>
            <button className="btn btn--primary" disabled={busy || alreadyAdded} onClick={() => void add()} type="button">
              {busy ? a.adding : a.addAndScan}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  )
}
