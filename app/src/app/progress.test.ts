import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { ApiError, api } from '../api'
import { libraryStore } from './library'
import {
  discardPendingProgress,
  flushProgress,
  hasPendingProgress,
  loadPendingProgress,
  pendingOverlay,
  recordProgress,
} from './progress'

const input = (page: number) => ({
  seriesId: 'series-1',
  category: 'manga' as const,
  entryLabel: 'Chapter 04',
  entryTitle: 'Chapter 4',
  variantId: 'variant-4',
  entryIndex: 3,
  position: { page, totalPages: 20, locationType: 'page' as const },
})

const resetUser = () => {
  discardPendingProgress('user-1')
  loadPendingProgress(null)
  libraryStore.set((previous) => ({ ...previous, ownerId: 'user-1', bookmarks: [], readingPositions: {} }))
  loadPendingProgress('user-1')
}

test('recording progress updates the shelf immediately and queues one save per title', () => {
  mock.timers.enable({ apis: ['setTimeout'] })

  try {
    resetUser()
    recordProgress(input(5))
    recordProgress(input(6))

    const state = libraryStore.get()
    assert.equal(state.bookmarks.length, 1)
    assert.equal(state.bookmarks[0].entryId, 'variant-4')
    assert.equal(state.readingPositions['variant-4'].page, 6)
    assert.equal(pendingOverlay().bookmarks.length, 1)
    assert.equal(pendingOverlay().positions['variant-4'].page, 6)
  } finally {
    mock.timers.reset()
  }
})

test('the same position is not queued twice', () => {
  mock.timers.enable({ apis: ['setTimeout'] })

  try {
    resetUser()
    recordProgress(input(9))
    discardPendingProgress('user-1')
    loadPendingProgress(null)
    loadPendingProgress('user-1')
    recordProgress(input(9))

    assert.equal(hasPendingProgress(), false)
  } finally {
    mock.timers.reset()
  }
})

test('a successful sync empties the queue', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const original = api.saveProgress
  const sent: number[] = []
  api.saveProgress = async (payload) => {
    sent.push(payload.position.page)
    return { saved: true, bookmark: null, position: null }
  }

  try {
    resetUser()
    recordProgress(input(12))
    await flushProgress()

    assert.deepEqual(sent, [12])
    assert.equal(hasPendingProgress(), false)
  } finally {
    api.saveProgress = original
    mock.timers.reset()
  }
})

test('progress survives a failed sync and a newer device position wins', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const original = api.saveProgress

  try {
    resetUser()
    api.saveProgress = async () => {
      throw new ApiError('offline', null)
    }
    recordProgress(input(14))
    await flushProgress()
    assert.equal(hasPendingProgress(), true)

    api.saveProgress = async () => ({
      saved: false,
      bookmark: {
        seriesId: 'series-1',
        category: 'manga',
        entryId: 'variant-7',
        entryIndex: 6,
        entryLabel: 'Chapter 07',
        entryTitle: 'Chapter 7',
        progress: 'Page 2 of 18',
        cue: '',
        lastSeen: '2030-01-01T00:00:00.000Z',
      },
      position: { page: 2, totalPages: 18, locationType: 'page' },
    })
    await flushProgress()

    const state = libraryStore.get()
    assert.equal(hasPendingProgress(), false)
    assert.equal(state.bookmarks[0].entryId, 'variant-7')
    assert.equal(state.readingPositions['variant-7'].page, 2)
  } finally {
    api.saveProgress = original
    mock.timers.reset()
  }
})

test('titles that no longer exist are dropped instead of retried forever', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const original = api.saveProgress
  api.saveProgress = async () => {
    throw new ApiError('Bookmark target entry was not found.', 400)
  }

  try {
    resetUser()
    recordProgress(input(3))
    await flushProgress()
    assert.equal(hasPendingProgress(), false)
  } finally {
    api.saveProgress = original
    mock.timers.reset()
  }
})
