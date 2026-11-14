import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ExternalLink, HelpCircle, LifeBuoy, MessagesSquare, X } from 'lucide-react'
import { LINKS } from '../config'

interface Props {
  onClose(): void
}

const TUTORIAL_STEPS = [
  'Arraste o mapa para navegar e use a roda do mouse para dar zoom.',
  'Mova o cursor para ver RA/Dec em tempo real; clique para fixar um ponto.',
  'Use a lupa do ponto selecionado para abrir a análise temporal (Nível 2).',
  'Ou digite coordenadas ou o nome de um objeto na busca da barra lateral.',
  'Buscas anteriores ficam em HISTÓRICO; alvos de destaque, em ACESSO RÁPIDO.',
]

export function OptionsModal({ onClose }: Props) {
  const [showTutorial, setShowTutorial] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="options-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <h2 id="options-title">Opções</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar" autoFocus>
            <X size={16} />
          </button>
        </header>

        <div className="modal__body">
          <button
            type="button"
            className="modal__item"
            aria-expanded={showTutorial}
            onClick={() => setShowTutorial((v) => !v)}
          >
            <HelpCircle size={18} aria-hidden="true" />
            <span>
              <b>Ajuda / Tutorial</b>
              <small>Como navegar no mapa e comparar épocas</small>
            </span>
          </button>
          {showTutorial && (
            <ol className="modal__tutorial">
              {TUTORIAL_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}

          <LinkItem
            href={LINKS.forum}
            icon={<MessagesSquare size={18} aria-hidden="true" />}
            title="Fórum da Comunidade"
            subtitle="Discuta descobertas com outros exploradores"
          />
          <LinkItem
            href={LINKS.support}
            icon={<LifeBuoy size={18} aria-hidden="true" />}
            title="Contato com o Suporte"
            subtitle="Fale diretamente com a equipe"
          />
        </div>
      </div>
    </div>
  )
}

interface LinkItemProps {
  href: string
  icon: ReactNode
  title: string
  subtitle: string
}

function LinkItem({ href, icon, title, subtitle }: LinkItemProps) {
  const content = (
    <>
      {icon}
      <span>
        <b>{title}</b>
        <small>{href ? subtitle : 'Link ainda não configurado'}</small>
      </span>
      {href && <ExternalLink size={14} className="modal__external" aria-hidden="true" />}
    </>
  )

  return href ? (
    <a className="modal__item" href={href} target="_blank" rel="noreferrer">
      {content}
    </a>
  ) : (
    <button type="button" className="modal__item" disabled>
      {content}
    </button>
  )
}
