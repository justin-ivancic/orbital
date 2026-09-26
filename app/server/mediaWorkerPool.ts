import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { MediaWorkerJob, MediaWorkerResult } from './mediaWorker'

const jobTimeoutMs = 60_000
const idleShutdownMs = 30_000
const maxJobsPerWorker = 250

type PendingJob = {
  job: MediaWorkerJob
  resolve: (result: MediaWorkerResult) => void
  reject: (error: Error) => void
}

let worker: ChildProcess | null = null
let workerJobs = 0
let nextJobId = 1
let activeJob: PendingJob | null = null
let activeTimer: NodeJS.Timeout | null = null
let idleTimer: NodeJS.Timeout | null = null
const queue: PendingJob[] = []

const workerPath = fileURLToPath(new URL('./mediaWorker.ts', import.meta.url))

const stopWorker = () => {
  if (!worker) {
    return
  }

  const current = worker
  worker = null
  workerJobs = 0
  current.removeAllListeners()
  if (current.connected) {
    current.disconnect()
  }
  current.kill('SIGKILL')
}

const settleActive = (result: MediaWorkerResult | Error) => {
  const job = activeJob
  activeJob = null

  if (activeTimer) {
    clearTimeout(activeTimer)
    activeTimer = null
  }

  if (!job) {
    return
  }

  if (result instanceof Error) {
    job.reject(result)
  } else {
    job.resolve(result)
  }
}

const startWorker = () => {
  // Keep the loader flags (tsx) so the worker can run TypeScript, but never
  // inherit test or eval flags.
  const execArgv = process.execArgv.filter(
    (argument) => argument !== '--test' && argument !== '--eval' && argument !== '-e',
  )
  const child = fork(workerPath, [], {
    execArgv: ['--max-old-space-size=256', ...execArgv],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000)
  })
  child.on('message', (message: MediaWorkerResult) => {
    if (activeJob && message.id === activeJob.job.id) {
      settleActive(message)
      pump()
    }
  })
  child.once('exit', (code, signal) => {
    if (worker === child) {
      worker = null
      workerJobs = 0
    }
    if (activeJob) {
      const detail = stderr.trim().split('\n').pop() || `exit ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`
      settleActive(new Error(`PDF worker stopped unexpectedly: ${detail}`))
      pump()
    }
  })
  child.once('error', (error) => {
    if (worker === child) {
      stopWorker()
    }
    if (activeJob) {
      settleActive(error)
      pump()
    }
  })

  worker = child
  return child
}

const scheduleIdleShutdown = () => {
  if (idleTimer) {
    clearTimeout(idleTimer)
  }

  idleTimer = setTimeout(() => {
    idleTimer = null
    if (!activeJob && queue.length === 0) {
      stopWorker()
    }
  }, idleShutdownMs)
  idleTimer.unref?.()
}

const pump = () => {
  if (activeJob) {
    return
  }

  const next = queue.shift()
  if (!next) {
    scheduleIdleShutdown()
    return
  }

  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }

  if (worker && workerJobs >= maxJobsPerWorker) {
    stopWorker()
  }

  const child = worker ?? startWorker()
  activeJob = next
  workerJobs += 1
  activeTimer = setTimeout(() => {
    stopWorker()
    settleActive(new Error('PDF processing exceeded 60 seconds and was stopped.'))
    pump()
  }, jobTimeoutMs)

  child.send(next.job)
}

export const runPdfJob = (job: Omit<MediaWorkerJob, 'id' | 'kind'>) =>
  new Promise<Extract<MediaWorkerResult, { ok: true }>>((resolve, reject) => {
    queue.push({
      job: { ...job, id: nextJobId++, kind: 'pdf' },
      resolve: (result) => {
        if (result.ok) {
          resolve(result)
        } else {
          reject(new Error(result.error))
        }
      },
      reject,
    })
    pump()
  })

export const shutdownMediaWorker = () => {
  queue.splice(0).forEach((pending) => pending.reject(new Error('The server is shutting down.')))
  stopWorker()
}
