import { createStore, useStore } from './store'

export type NoticeTone = 'info' | 'error'

export type Notice = {
  id: number
  text: string
  tone: NoticeTone
}

type NoticeState = {
  notices: Notice[]
}

export const noticeStore = createStore<NoticeState>({ notices: [] })

let nextNoticeId = 1
const timers = new Map<number, ReturnType<typeof setTimeout>>()

export const dismissNotice = (id: number) => {
  const timer = timers.get(id)

  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }

  noticeStore.set((previous) => ({
    notices: previous.notices.filter((notice) => notice.id !== id),
  }))
}

/** Shows a short message. Errors stay a little longer than confirmations. */
export const notify = (text: string, tone: NoticeTone = 'info') => {
  const existing = noticeStore.get().notices.find((notice) => notice.text === text)

  if (existing) {
    return existing.id
  }

  const id = nextNoticeId
  nextNoticeId += 1

  noticeStore.set((previous) => ({
    notices: [...previous.notices.slice(-2), { id, text, tone }],
  }))
  timers.set(id, setTimeout(() => dismissNotice(id), tone === 'error' ? 8_000 : 4_000))

  return id
}

const selectNotices = (state: NoticeState) => state.notices

export const useNotices = () => useStore(noticeStore, selectNotices)
