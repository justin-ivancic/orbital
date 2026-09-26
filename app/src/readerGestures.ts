import type { ReaderDirection } from './appTypes'

export type PagedSwipeAction = 'next' | 'previous'

export const resolvePagedSwipeAction = (
  deltaX: number,
  deltaY: number,
  direction: ReaderDirection,
): PagedSwipeAction | null => {
  if (Math.abs(deltaX) < 56 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.25) {
    return null
  }

  const swipedRight = deltaX > 0

  if (direction === 'rtl') {
    return swipedRight ? 'next' : 'previous'
  }

  return swipedRight ? 'previous' : 'next'
}

export type TapZone = 'back' | 'forward' | 'menu'
export type TapZoneLayout = 'sides' | 'forward'

/**
 * Maps a tap to an action. Both layouts keep a central area for the menu:
 * - `sides`: left 30 % back, right 30 % forward, the middle column menu.
 * - `forward`: left 30 % back, a centred box menu, everything else forward.
 * Right-to-left reading swaps back and forward.
 */
export const resolveTapZone = (
  x: number,
  y: number,
  width: number,
  height: number,
  layout: TapZoneLayout,
  direction: ReaderDirection,
): TapZone => {
  const relativeX = width > 0 ? x / width : 0.5
  const relativeY = height > 0 ? y / height : 0.5
  const mirroredX = direction === 'rtl' ? 1 - relativeX : relativeX

  if (mirroredX < 0.3) {
    return 'back'
  }

  if (layout === 'sides') {
    return mirroredX > 0.7 ? 'forward' : 'menu'
  }

  const inCentreBox = mirroredX <= 0.7 && relativeY >= 0.3 && relativeY <= 0.7
  return inCentreBox ? 'menu' : 'forward'
}
