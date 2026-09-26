import { createStore, useStore } from './store'

type ConfirmRequest = {
  kind: 'confirm'
  id: number
  title: string
  body?: string
  confirmLabel: string
  danger?: boolean
  resolve: (confirmed: boolean) => void
}

type PromptRequest = {
  kind: 'prompt'
  id: number
  title: string
  label: string
  hint?: string
  inputType: 'text' | 'password'
  confirmLabel: string
  minLength?: number
  initialValue?: string
  resolve: (value: string | null) => void
}

export type DialogRequest = ConfirmRequest | PromptRequest

type DialogState = {
  queue: DialogRequest[]
}

export const dialogStore = createStore<DialogState>({ queue: [] })

let nextDialogId = 1

const enqueue = (request: DialogRequest) => {
  dialogStore.set((previous) => ({ queue: [...previous.queue, request] }))
}

export const closeDialog = (id: number) => {
  dialogStore.set((previous) => ({ queue: previous.queue.filter((request) => request.id !== id) }))
}

/** Asks for confirmation in an in-app dialog (never the browser's `confirm`). */
export const confirmAction = (options: Omit<ConfirmRequest, 'kind' | 'id' | 'resolve'>) =>
  new Promise<boolean>((resolve) => {
    const id = nextDialogId
    nextDialogId += 1
    enqueue({ ...options, kind: 'confirm', id, resolve })
  })

/** Asks for a single value, for example a new password. */
export const promptValue = (options: Omit<PromptRequest, 'kind' | 'id' | 'resolve'>) =>
  new Promise<string | null>((resolve) => {
    const id = nextDialogId
    nextDialogId += 1
    enqueue({ ...options, kind: 'prompt', id, resolve })
  })

const selectCurrent = (state: DialogState) => state.queue[0] ?? null

export const useCurrentDialog = () => useStore(dialogStore, selectCurrent)
