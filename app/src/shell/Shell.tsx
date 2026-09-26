import { lazy, Suspense, useLayoutEffect, useRef, type RefObject } from 'react'
import { completeRoutePerformanceMeasurement } from '../performanceMetrics'
import { useOffline } from '../app/connection'
import { useRouterState } from '../app/router'
import { useT } from '../i18n'
import type { AppRoute } from '../routing'
import { DialogHost } from '../ui/DialogHost'
import { CreatorPage } from '../pages/CreatorPage'
import { BrowsePage } from '../pages/BrowsePage'
import { HomePage } from '../pages/HomePage'
import { ProblemPage } from '../pages/ProblemPage'
import { SearchPage } from '../pages/SearchPage'
import { SeriesPage } from '../pages/SeriesPage'
import { BottomNav, Sidebar } from './Navigation'
import { NoticeRegion, OfflineBanner } from './Notices'

const ReaderPage = lazy(() => import('../pages/ReaderPage').then((module) => ({ default: module.ReaderPage })))
const DownloadsPage = lazy(() => import('../pages/DownloadsPage').then((module) => ({ default: module.DownloadsPage })))
const SettingsPage = lazy(() => import('../pages/SettingsPage').then((module) => ({ default: module.SettingsPage })))
const AdminPage = lazy(() => import('../pages/AdminPage').then((module) => ({ default: module.AdminPage })))

function PageFallback() {
  const t = useT()

  return (
    <div className="page">
      <p className="spinner-text">{t.common.loading}</p>
    </div>
  )
}

function RouteView({ route }: { route: AppRoute }) {
  switch (route.name) {
    case 'home':
    case 'login':
    case 'signup':
      return <HomePage />
    case 'library':
      return <BrowsePage route={route} />
    case 'search':
      return <SearchPage route={route} />
    case 'series':
      return <SeriesPage key={route.seriesId} route={route} />
    case 'creator':
      return <CreatorPage creatorKey={route.creatorKey} />
    case 'downloads':
      return <DownloadsPage />
    case 'settings':
      return <SettingsPage />
    case 'admin':
      return <AdminPage route={route} />
    case 'reader':
    case 'offlineReader':
      return null
    case 'notFound':
      return <ProblemPage kind="notFound" />
  }
}

/** Restores or resets the scroll position after each navigation. */
function useRouteScroll(mainRef: RefObject<HTMLElement | null>) {
  const { transition, version } = useRouterState()

  useLayoutEffect(() => {
    if (transition.preserveScroll) {
      const frame = requestAnimationFrame(completeRoutePerformanceMeasurement)
      return () => cancelAnimationFrame(frame)
    }

    const [left, top] = transition.restoreScroll ?? [0, 0]
    let userMoved = false
    const markMoved = () => {
      userMoved = true
    }
    const apply = () => window.scrollTo({ left, top, behavior: 'auto' })

    apply()
    window.addEventListener('wheel', markMoved, { passive: true, once: true })
    window.addEventListener('touchstart', markMoved, { passive: true, once: true })
    window.addEventListener('keydown', markMoved, { once: true })

    // Content that renders a frame later (lists, images) can shift the page;
    // apply the position once more unless the user already scrolled.
    const frame = requestAnimationFrame(() => {
      if (!userMoved) {
        apply()
      }

      if (transition.focusMain) {
        mainRef.current?.focus({ preventScroll: true })
      }

      completeRoutePerformanceMeasurement()
    })

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('wheel', markMoved)
      window.removeEventListener('touchstart', markMoved)
      window.removeEventListener('keydown', markMoved)
    }
  }, [mainRef, transition, version])
}

export function Shell() {
  const t = useT()
  const { route } = useRouterState()
  const mainRef = useRef<HTMLElement | null>(null)
  const offline = useOffline()
  const reading = route.name === 'reader' || route.name === 'offlineReader'
  useRouteScroll(mainRef)

  if (reading) {
    return (
      <>
        <Suspense fallback={<PageFallback />}>
          <ReaderPage route={route} />
        </Suspense>
        <NoticeRegion />
        <DialogHost />
      </>
    )
  }

  return (
    <div className={`shell${offline ? ' shell--offline' : ''}`}>
      <a className="skip-link" href="#main">
        {t.common.skipToContent}
      </a>
      <Sidebar />
      <main className="shell__main" id="main" ref={mainRef} tabIndex={-1}>
        <Suspense fallback={<PageFallback />}>
          <RouteView route={route} />
        </Suspense>
      </main>
      <OfflineBanner />
      <BottomNav />
      <NoticeRegion />
      <DialogHost />
    </div>
  )
}
