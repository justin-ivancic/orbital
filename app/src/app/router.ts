import { startTransition } from 'react'
import { startRoutePerformanceMeasurement } from '../performanceMetrics'
import {
  appRoutePath,
  isReaderRoute,
  parseAppRoute,
  routeForLocation,
  safeInternalDestination,
  shouldReplaceReaderNavigation,
  type AppRoute,
} from '../routing'
import { createStore, useStore } from './store'

type OrbitalHistoryState = {
  orbitalIndex?: number
  orbitalReaderReturnIndex?: number
  orbitalReaderReturnPath?: string
  orbitalScroll?: [number, number]
}

export type NavigateOptions = {
  /** Replace the current history entry instead of adding one. */
  replace?: boolean
  /** Keep the scroll position (for in-page state such as filters and tabs). */
  preserveScroll?: boolean
  /** Move keyboard focus to the main landmark (defaults to !preserveScroll). */
  focusMain?: boolean
}

export type RouteTransition = {
  focusMain: boolean
  kind: 'initial' | 'push' | 'replace' | 'pop'
  preserveScroll: boolean
  restoreScroll: [number, number] | null
}

type RouterState = {
  route: AppRoute
  path: string
  transition: RouteTransition
  /** Increments on every navigation so layout effects can react to it. */
  version: number
}

const canUseWindow = typeof window !== 'undefined'
const currentPath = () => (canUseWindow ? `${window.location.pathname}${window.location.search}` : '/')

export const routerStore = createStore<RouterState>({
  route: canUseWindow ? routeForLocation() : { name: 'home' },
  path: currentPath(),
  transition: { focusMain: false, kind: 'initial', preserveScroll: false, restoreScroll: null },
  version: 0,
})

let historyIndex = 0
const scrollPositions = new Map<number, [number, number]>()

const readHistoryState = (): OrbitalHistoryState => {
  const state = canUseWindow ? window.history.state : null
  return state && typeof state === 'object' ? (state as OrbitalHistoryState) : {}
}

const scrollPosition = (): [number, number] => [window.scrollX, window.scrollY]

const commitRoute = (route: AppRoute, transition: RouteTransition) => {
  startRoutePerformanceMeasurement()
  startTransition(() => {
    routerStore.set((previous) => ({
      route,
      path: appRoutePath(route),
      transition,
      version: previous.version + 1,
    }))
  })
}

export const navigate = (nextRoute: AppRoute, options: NavigateOptions = {}) => {
  const nextPath = appRoutePath(nextRoute)
  const path = currentPath()
  const previousRoute = routerStore.get().route

  if (nextPath === path) {
    if (appRoutePath(previousRoute) !== nextPath) {
      commitRoute(nextRoute, {
        focusMain: false,
        kind: 'replace',
        preserveScroll: true,
        restoreScroll: null,
      })
    }
    return
  }

  const currentState = readHistoryState()
  const currentScroll = scrollPosition()
  scrollPositions.set(historyIndex, currentScroll)
  window.history.replaceState(
    { ...currentState, orbitalIndex: historyIndex, orbitalScroll: currentScroll } satisfies OrbitalHistoryState,
    '',
    path,
  )

  const replace = Boolean(options.replace) || shouldReplaceReaderNavigation(previousRoute, nextRoute)
  const nextIndex = replace ? historyIndex : historyIndex + 1
  const nextScroll: [number, number] = options.preserveScroll ? currentScroll : [0, 0]
  const nextState: OrbitalHistoryState = {
    ...currentState,
    orbitalIndex: nextIndex,
    orbitalScroll: nextScroll,
  }

  if (isReaderRoute(nextRoute)) {
    if (!isReaderRoute(previousRoute)) {
      nextState.orbitalReaderReturnIndex = historyIndex
      nextState.orbitalReaderReturnPath = path
    }
  } else {
    delete nextState.orbitalReaderReturnIndex
    delete nextState.orbitalReaderReturnPath
  }

  if (replace) {
    window.history.replaceState(nextState, '', nextPath)
  } else {
    window.history.pushState(nextState, '', nextPath)
  }

  historyIndex = nextIndex
  scrollPositions.set(nextIndex, nextScroll)
  commitRoute(nextRoute, {
    focusMain: options.focusMain ?? !options.preserveScroll,
    kind: replace ? 'replace' : 'push',
    preserveScroll: Boolean(options.preserveScroll),
    restoreScroll: null,
  })
}

/** Updates in-page state (filters, tabs, reader position) without a new history entry. */
export const replaceRoute = (route: AppRoute) =>
  navigate(route, { replace: true, preserveScroll: true, focusMain: false })

export const canGoBack = () => historyIndex > 0

/** Goes back when there is somewhere to go back to, otherwise opens the fallback. */
export const goBack = (fallback: AppRoute) => {
  if (historyIndex > 0) {
    window.history.back()
    return
  }

  navigate(fallback, { replace: true })
}

/** Leaves the reader to wherever it was opened from. */
export const exitReader = (fallback: AppRoute) => {
  const state = readHistoryState()
  const returnPath = safeInternalDestination(state.orbitalReaderReturnPath)

  if (returnPath) {
    const returnRoute = parseAppRoute(new URL(returnPath, 'https://orbital.invalid'))

    if (!isReaderRoute(returnRoute)) {
      const returnIndex = state.orbitalReaderReturnIndex

      if (
        returnIndex != null &&
        Number.isSafeInteger(returnIndex) &&
        returnIndex >= 0 &&
        returnIndex < historyIndex
      ) {
        window.history.go(returnIndex - historyIndex)
        return
      }

      navigate(returnRoute, { replace: true })
      return
    }
  }

  navigate(fallback, { replace: true })
}

let initialized = false

export const initRouter = () => {
  if (initialized || !canUseWindow) {
    return
  }

  initialized = true
  const initialState = readHistoryState()
  const initialRoute = routerStore.get().route
  // Legacy addresses (/bookmarks, /profile) are rewritten to their canonical form.
  const canonicalPath = initialRoute.name === 'notFound'
    ? window.location.href
    : `${appRoutePath(initialRoute)}${window.location.hash}`
  historyIndex = initialState.orbitalIndex ?? 0
  const initialScroll = initialState.orbitalScroll ?? scrollPosition()
  scrollPositions.set(historyIndex, initialScroll)
  window.history.replaceState(
    { ...initialState, orbitalIndex: historyIndex, orbitalScroll: initialScroll } satisfies OrbitalHistoryState,
    '',
    canonicalPath,
  )
  routerStore.update({ path: currentPath() })
  window.history.scrollRestoration = 'manual'

  window.addEventListener('popstate', (event) => {
    scrollPositions.set(historyIndex, scrollPosition())
    const nextState =
      event.state && typeof event.state === 'object' ? (event.state as OrbitalHistoryState) : {}
    const nextIndex = nextState.orbitalIndex ?? 0

    historyIndex = nextIndex
    commitRoute(routeForLocation(), {
      focusMain: true,
      kind: 'pop',
      preserveScroll: false,
      restoreScroll: scrollPositions.get(nextIndex) ?? nextState.orbitalScroll ?? [0, 0],
    })
  })

  window.addEventListener('pagehide', () => {
    const position = scrollPosition()
    scrollPositions.set(historyIndex, position)
    window.history.replaceState(
      { ...readHistoryState(), orbitalIndex: historyIndex, orbitalScroll: position } satisfies OrbitalHistoryState,
      '',
      window.location.href,
    )
  })
}

const selectRoute = (state: RouterState) => state.route
const selectRouterState = (state: RouterState) => state

export const useRoute = () => useStore(routerStore, selectRoute)
export const useRouterState = () => useStore(routerStore, selectRouterState)

export const currentRoute = () => routerStore.get().route
