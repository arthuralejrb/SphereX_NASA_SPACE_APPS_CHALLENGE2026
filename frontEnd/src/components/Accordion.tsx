import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface Props {
  title: string
  /** Contador ou ações exibidos à direita do título. */
  aside?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}

/** Gaveta retrátil da barra lateral. */
export function Accordion({ title, aside, defaultOpen = true, children }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()

  return (
    <section className="accordion">
      <header className="accordion__header">
        <button
          type="button"
          className="accordion__toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          {title}
        </button>
        {aside !== undefined && <span className="accordion__aside">{aside}</span>}
      </header>
      {open && (
        <div id={panelId} className="accordion__panel">
          {children}
        </div>
      )}
    </section>
  )
}
