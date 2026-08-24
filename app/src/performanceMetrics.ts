export type RoutePerformanceSummary = {
  averageTransitionMs: number
  completedTransitions: number
  lastTransitionMs: number
}

let routeTransitionStartedAt: number | null = null
let completedRouteTransitions = 0
let totalRouteTransitionMs = 0
let lastRouteTransitionMs = 0

const now = () => typeof performance === 'undefined' ? Date.now() : performance.now()

export const startRoutePerformanceMeasurement = () => {
  routeTransitionStartedAt = now()
}

export const completeRoutePerformanceMeasurement = () => {
  if (routeTransitionStartedAt == null) {
    return
  }

  lastRouteTransitionMs = Math.max(0, now() - routeTransitionStartedAt)
  totalRouteTransitionMs += lastRouteTransitionMs
  completedRouteTransitions += 1
  routeTransitionStartedAt = null
}

export const getRoutePerformanceSummary = (): RoutePerformanceSummary => ({
  averageTransitionMs: completedRouteTransitions
    ? totalRouteTransitionMs / completedRouteTransitions
    : 0,
  completedTransitions: completedRouteTransitions,
  lastTransitionMs: lastRouteTransitionMs,
})
