import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { navigate, type NavigateOptions } from '../app/router'
import { appRoutePath, type AppRoute } from '../routing'

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  to: AppRoute
  options?: NavigateOptions
  children: ReactNode
}

/** An in-app link: a real anchor for accessibility, handled without a reload. */
export function Link({ to, options, children, onClick, ...rest }: LinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)

    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return
    }

    event.preventDefault()
    navigate(to, options)
  }

  return (
    <a {...rest} href={appRoutePath(to)} onClick={handleClick}>
      {children}
    </a>
  )
}
