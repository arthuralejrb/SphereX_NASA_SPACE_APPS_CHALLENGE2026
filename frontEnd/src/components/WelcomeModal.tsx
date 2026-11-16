import { useEffect } from 'react'
import { CalendarClock, GitCompareArrows, MapPin, Search, SlidersHorizontal, X } from 'lucide-react'

interface Props {
  onClose(): void
}

const STEPS = [
  {
    icon: Search,
    title: 'Escolha um lugar no céu',
    text: 'Digite o nome de um objeto (por exemplo "M42" ou "Vega") na busca, ou escolha um dos alvos em Acesso rápido.',
  },
  {
    icon: MapPin,
    title: 'Ou clique no mapa',
    text: 'Arraste para passear e role para aproximar. Clique num ponto para fixá-lo e depois em "Analisar".',
  },
  {
    icon: CalendarClock,
    title: 'Veja o mesmo lugar em datas diferentes',
    text: 'O OrbitaX busca as imagens que o telescópio fez daquele ponto e mostra uma por data, na linha do tempo.',
  },
  {
    icon: GitCompareArrows,
    title: 'Compare e descubra o que mudou',
    text: 'Use "Comparar" para pôr duas imagens lado a lado ou uma sobre a outra, e "Animação" para vê-las em sequência.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Vá mais fundo com as Ferramentas',
    text: 'Realce detalhes fracos, monte imagens em cores e veja o espectro do alvo: o brilho dele em cada cor do infravermelho.',
  },
]

/** Boas-vindas da primeira visita: o que é o site e como usá-lo. */
export function WelcomeModal({ onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal__header">
          <h2 id="welcome-title">Bem-vindo ao OrbitaX</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar">
            <X size={16} />
          </button>
        </header>
        <div className="modal__body welcome">
          <p className="welcome__lead">
            O OrbitaX mostra como um mesmo pedaço do céu muda com o tempo. Ele usa as imagens do <b>SPHEREx</b>, um telescópio espacial da NASA que
            fotografa o céu inteiro em luz infravermelha (invisível aos nossos olhos) e volta a cada ponto de tempos em tempos.
          </p>
          <p className="welcome__lead">
            Com isso dá para ver estrelas que mudam de brilho, objetos que se movem e a "impressão digital" de cores de cada astro.
          </p>
          <h3>Como usar</h3>
          <ol className="welcome__steps">
            {STEPS.map(({ icon: Icon, title, text }) => (
              <li key={title}>
                <Icon size={22} className="key-icon" aria-hidden="true" />
                <span>
                  <b>{title}</b>
                  <span>{text}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="welcome__note">
            A primeira busca de um lugar leva cerca de meio minuto, porque as imagens vêm direto dos servidores da NASA. Para rever esta explicação, use
            o botão de ajuda no rodapé da barra lateral.
          </p>
          <div className="welcome__footer">
            <button type="button" className="btn btn--primary welcome__start" onClick={onClose}>
              Começar a explorar
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
