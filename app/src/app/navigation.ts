import { useEffect } from 'react'
import type { CategoryId } from '../appTypes'
import { libraryRoute, type AppRoute, type LibraryRouteCategory } from '../routing'
import { getCategoryCounts, libraryStore, readerCategories } from './library'
import { routerStore } from './router'
import { useStore } from './store'
import { stringsFor } from '../i18n'
import { preferencesStore } from './preferences'

let lastBrowse: Extract<AppRoute, { name: 'library' }> | null = null

routerStore.subscribe(() => {
  const { route } = routerStore.get()

  if (route.name === 'library') {
    lastBrowse = route
  }
})

/** The categories that have titles, in display order. */
export const availableCategories = (counts: Record<CategoryId, number>) =>
  readerCategories.filter((category) => counts[category] > 0)

const firstCategory = (): LibraryRouteCategory => {
  const counts = getCategoryCounts(libraryStore.get().library)
  return availableCategories(counts)[0] ?? 'books'
}

/** Where "Browse" leads: the last browsed shelf, or the first non-empty one. */
export const browseTarget = (): AppRoute => lastBrowse ?? libraryRoute(firstCategory())

const selectCounts = (state: { library: Parameters<typeof getCategoryCounts>[0] }) => getCategoryCounts(state.library)

export const useCategoryCounts = () => useStore(libraryStore, selectCounts)

/** Keeps the document title in sync with the page. */
export const useDocumentTitle = (title: string | null) => {
  useEffect(() => {
    const appName = stringsFor(preferencesStore.get().language).common.appName
    document.title = title ? `${title} · ${appName}` : appName
  }, [title])
}
