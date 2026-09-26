import { useCallback, useRef, useSyncExternalStore } from 'react'

/**
 * A minimal external store. State lives outside React so that frequent
 * updates (download progress, reading position, scan status) only re-render
 * the components that select the changed slice.
 */
export type Store<T> = {
  get: () => T
  set: (next: T | ((previous: T) => T)) => void
  update: (patch: Partial<T>) => void
  subscribe: (listener: () => void) => () => void
}

export const createStore = <T extends object>(initial: T): Store<T> => {
  let state = initial
  const listeners = new Set<() => void>()

  const set: Store<T>['set'] = (next) => {
    const value = typeof next === 'function' ? (next as (previous: T) => T)(state) : next

    if (Object.is(value, state)) {
      return
    }

    state = value
    listeners.forEach((listener) => listener())
  }

  return {
    get: () => state,
    set,
    update: (patch) => {
      const changed = Object.entries(patch).some(
        ([key, value]) => !Object.is(state[key as keyof T], value),
      )

      if (changed) {
        set({ ...state, ...patch })
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export const shallowEqual = <T,>(left: T, right: T) => {
  if (Object.is(left, right)) {
    return true
  }

  if (
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    left === null ||
    right === null
  ) {
    return false
  }

  if (Array.isArray(left) !== Array.isArray(right)) {
    return false
  }

  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) =>
      Object.is(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
    )
  )
}

type SelectionCache<T, S> = {
  state: T
  selector: (state: T) => S
  selected: S
}

/**
 * Subscribes to a slice of a store. The component re-renders only when the
 * selected value changes according to `isEqual`.
 */
export const useStore = <T, S>(
  store: Pick<Store<T>, 'get' | 'subscribe'>,
  selector: (state: T) => S,
  isEqual: (left: S, right: S) => boolean = Object.is,
): S => {
  const cacheRef = useRef<SelectionCache<T, S> | null>(null)

  const getSnapshot = useCallback(() => {
    const state = store.get()
    const cached = cacheRef.current

    if (cached && cached.state === state && cached.selector === selector) {
      return cached.selected
    }

    const selected = selector(state)

    if (cached && isEqual(cached.selected, selected)) {
      cacheRef.current = { state, selector, selected: cached.selected }
      return cached.selected
    }

    cacheRef.current = { state, selector, selected }
    return selected
  }, [isEqual, selector, store])

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}
