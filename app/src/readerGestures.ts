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
