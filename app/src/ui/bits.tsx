import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '../i18n'

export function Meter({ value, label, thin = false }: { value: number; label?: string; thin?: boolean }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100)

  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percent}
      className={`meter${thin ? ' meter--thin' : ''}`}
      role="progressbar"
    >
      <span className="meter__fill" style={{ width: `${percent}%` }} />
    </div>
  )
}

type EmptyStateProps = {
  icon: LucideIcon
  title: string
  body?: ReactNode
  action?: ReactNode
}

export function EmptyState({ icon: Icon, title, body, action }: EmptyStateProps) {
  return (
    <div className="empty">
      <span aria-hidden="true" className="empty__icon">
        <Icon strokeWidth={1.8} />
      </span>
      <h2>{title}</h2>
      {body && <p>{body}</p>}
      {action}
    </div>
  )
}

type PagerProps = {
  page: number
  pageCount: number
  onChange: (page: number) => void
}

export function Pager({ page, pageCount, onChange }: PagerProps) {
  const t = useT()

  if (pageCount <= 1) {
    return null
  }

  return (
    <nav aria-label={t.common.pageOf(page, pageCount)} className="pager">
      <button className="btn" disabled={page <= 1} onClick={() => onChange(page - 1)} type="button">
        <ChevronLeft aria-hidden="true" />
        {t.common.previous}
      </button>
      <span className="pager__status">{t.common.pageOf(page, pageCount)}</span>
      <button className="btn" disabled={page >= pageCount} onClick={() => onChange(page + 1)} type="button">
        {t.common.next}
        <ChevronRight aria-hidden="true" />
      </button>
    </nav>
  )
}

type SegmentedOption<T extends string> = {
  value: T
  label: ReactNode
  icon?: LucideIcon
  ariaLabel?: string
}

type SegmentedProps<T extends string> = {
  label: string
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  block?: boolean
}

export function Segmented<T extends string>({ label, value, options, onChange, block = false }: SegmentedProps<T>) {
  return (
    <div aria-label={label} className={`segmented${block ? ' segmented--block' : ''}`} role="radiogroup">
      {options.map((option) => {
        const Icon = option.icon

        return (
          <button
            aria-checked={option.value === value}
            aria-label={option.ariaLabel}
            className="segmented__option"
            key={option.value}
            onClick={() => onChange(option.value)}
            role="radio"
            type="button"
          >
            {Icon && <Icon aria-hidden="true" />}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    />
  )
}

export function SectionHead({ title, meta, action }: { title: string; meta?: ReactNode; action?: ReactNode }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {meta && <span className="section-head__meta">{meta}</span>}
      {action && <span className="spacer" />}
      {action}
    </div>
  )
}
