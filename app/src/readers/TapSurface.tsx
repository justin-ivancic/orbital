import { useEffect, useRef, type MouseEvent, type ReactNode, type RefObject, type TouchEvent } from 'react'
import type { ReaderDirection } from '../appTypes'
import type { TapLayout } from '../app/preferences'
import { resolvePagedSwipeAction, resolveTapZone } from '../readerGestures'

type TapSurfaceProps = {
  direction: ReaderDirection
  layout: TapLayout
  mode: 'paged' | 'scroll'
  onForward: () => void
  onBack: () => void
  onMenu: () => void
  /** Horizontal swipes turn pages (off while zoomed so the page can be panned). */
  swipe?: boolean
  /** The element that scrolls in scroll mode; taps on the sides move it by a screen. */
  scrollRef?: RefObject<HTMLElement | null>
  className?: string
  children: ReactNode
}

const interactiveSelector = 'a, button, input, select, textarea, summary, [role="button"], [data-no-tap]'

const scrollByScreen = (element: HTMLElement | null | undefined, direction: 1 | -1) => {
  if (!element) {
    return false
  }

  const maximum = element.scrollHeight - element.clientHeight

  if ((direction > 0 && element.scrollTop >= maximum - 2) || (direction < 0 && element.scrollTop <= 0)) {
    return false
  }

  element.scrollTop = Math.min(maximum, Math.max(0, element.scrollTop + direction * element.clientHeight * 0.88))
  return true
}

/**
 * Turns taps and swipes into page turns. The edges turn pages, the middle
 * opens the menu, and the keyboard works too. In scroll mode the edges move
 * the page by one screen, which is gentler on e-ink than dragging.
 */
export function TapSurface({
  direction,
  layout,
  mode,
  onForward,
  onBack,
  onMenu,
  swipe = true,
  scrollRef,
  className = '',
  children,
}: TapSurfaceProps) {
  const touchRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const suppressClickRef = useRef(0)
  const handlersRef = useRef({ onForward, onBack, onMenu })

  useEffect(() => {
    handlersRef.current = { onForward, onBack, onMenu }
  }, [onBack, onForward, onMenu])

  const forward = () => {
    if (mode === 'scroll' && scrollByScreen(scrollRef?.current, 1)) {
      return
    }

    handlersRef.current.onForward()
  }

  const back = () => {
    if (mode === 'scroll' && scrollByScreen(scrollRef?.current, -1)) {
      return
    }

    handlersRef.current.onBack()
  }

  const forwardRef = useRef(forward)
  const backRef = useRef(back)

  useEffect(() => {
    forwardRef.current = forward
    backRef.current = back
  })

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target

      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select')))
      ) {
        return
      }

      const nextKeys = direction === 'rtl' ? ['ArrowLeft'] : ['ArrowRight']
      const previousKeys = direction === 'rtl' ? ['ArrowRight'] : ['ArrowLeft']

      if (nextKeys.includes(event.key) || event.key === 'PageDown' || (event.key === ' ' && !event.shiftKey)) {
        event.preventDefault()
        forwardRef.current()
      } else if (previousKeys.includes(event.key) || event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) {
        event.preventDefault()
        backRef.current()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [direction])

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (Date.now() - suppressClickRef.current < 500) {
      return
    }

    if (event.target instanceof Element && event.target.closest(interactiveSelector)) {
      return
    }

    const bounds = event.currentTarget.getBoundingClientRect()
    const zone = resolveTapZone(
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      bounds.width,
      bounds.height,
      layout,
      direction,
    )

    if (zone === 'forward') {
      forward()
    } else if (zone === 'back') {
      back()
    } else {
      handlersRef.current.onMenu()
    }
  }

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]
    touchRef.current = touch && event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY, time: Date.now() } : null
  }

  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const start = touchRef.current
    const touch = event.changedTouches[0]
    touchRef.current = null

    if (!start || !touch || !swipe || mode !== 'paged') {
      return
    }

    const action = resolvePagedSwipeAction(touch.clientX - start.x, touch.clientY - start.y, direction)

    if (action) {
      suppressClickRef.current = Date.now()

      if (action === 'next') {
        forward()
      } else {
        back()
      }
    }
  }

  return (
    <div
      className={`tap-surface ${className}`}
      onClick={handleClick}
      onTouchEnd={handleTouchEnd}
      onTouchStart={handleTouchStart}
    >
      {children}
    </div>
  )
}
