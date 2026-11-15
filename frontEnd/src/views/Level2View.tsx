import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Columns2, Download, GitCompareArrows, ImageOff, Info, LoaderCircle, Minus, Plus, RotateCcw, SquareSplitHorizontal, Undo2, X } from 'lucide-react'
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider'
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch'
import type { ApiResult, Epoch, SearchState, SkyData } from '../types'
import { formatDec, formatRa } from '../utils/coords'
import { downloadImage, downloadImagesAsZip, slug } from '../utils/download'
import type { DownloadItem } from '../utils/download'

interface Props {
  search: SearchState
  onBack(): void
}

const dateFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'UTC',
})

/**
 * "2025-03-15" -> "15 de mar. de 2025"; com hora ("2025-04-24T18:01:05") inclui "18:01:05".
 * O back-end manda a hora em UTC sem o "Z" no fim. Devolve o texto original se não for uma data.
 */
function formatDate(iso: string) {
  const hasTime = iso.includes('T')
  const hasZone = /(Z|[+-]\d\d:?\d\d)$/.test(iso)
  const time = Date.parse(hasTime && !hasZone ? `${iso}Z` : iso)
  if (Number.isNaN(time)) return iso
  return (hasTime ? dateTimeFormat : dateFormat).format(time)
}

export function Level2View({ search, onBack }: Props) {
  return (
    <div className="level2">
      <header className="level2__bar">
        <button type="button" className="icon-btn icon-btn--lg" onClick={onBack} aria-label="Voltar ao mapa" title="Voltar ao mapa (Esc)" autoFocus>
          <Undo2 size={19} />
        </button>
        <span className="level2__brand">órbita.</span>
        {search.status !== 'idle' && (
          <span className="level2__target">
            <b>{search.label ?? 'Coordenada pesquisada'}</b>
            <span>
              RA {formatRa(search.coords.raDeg)} · Dec {formatDec(search.coords.decDeg)}
            </span>
          </span>
        )}
        {search.status === 'done' && search.result.source === 'mock' && (
          <span className="badge level2__source" title="Back-end indisponível: imagens simuladas para demonstração">
            dados de demonstração
          </span>
        )}
      </header>

      {search.status === 'done' ? (
        // A chave reinicia seleção e comparador quando chega uma nova busca.
        <Analysis key={`${search.coords.raDeg},${search.coords.decDeg}`} result={search.result} label={search.label} onBack={onBack} />
      ) : (
        <div className="level2__loading">
          {search.status === 'loading' ? (
            <>
              <LoaderCircle size={20} className="spin" aria-hidden="true" />
              Buscando épocas…
            </>
          ) : (
            'Nenhuma coordenada selecionada. Volte ao mapa e escolha um ponto.'
          )}
        </div>
      )}
    </div>
  )
}

type Selection = number | 'subtracted'
type CompareLayout = 'slider' | 'side'

function Analysis({ result, label, onBack }: { result: ApiResult<SkyData>; label?: string; onBack(): void }) {
  const sky = result.data
  const [epochs] = useState<Epoch[]>(() => [...sky.epochs].sort((a, b) => a.date.localeCompare(b.date)))
  const [selected, setSelected] = useState<Selection>(0)
  const [comparing, setComparing] = useState(false)
  const [layout, setLayout] = useState<CompareLayout>('slider')
  /** Índices das duas épocas comparadas, na ordem em que foram escolhidas. */
  const [pair, setPair] = useState<[number, number]>([0, Math.min(1, epochs.length - 1)])
  const [showDetails, setShowDetails] = useState(false)
  /** Qual download está em andamento: índice da época, 'subtracted' ou 'all'. */
  const [downloading, setDownloading] = useState<Selection | 'all' | null>(null)
  const [downloadError, setDownloadError] = useState(false)

  // Nomes dos arquivos: alvo (ou coordenada) + data da captura.
  const fileBase = `orbita_${slug(label ?? `${formatRa(sky.coords.raDeg)}_${formatDec(sky.coords.decDeg)}`)}`
  const epochFile = (i: number): DownloadItem => ({
    url: epochs[i].imageUrl,
    name: `${fileBase}_epoca-${i + 1}_${slug(epochs[i].date.slice(0, 19).replace(/:/g, '-'))}`,
  })
  const subtractedFile: DownloadItem | null = sky.subtractedImageUrl
    ? { url: sky.subtractedImageUrl, name: `${fileBase}_subtracao` }
    : null

  async function runDownload(key: Selection | 'all', task: () => Promise<void>) {
    setDownloading(key)
    setDownloadError(false)
    try {
      await task()
    } catch (err) {
      console.warn('[download] não foi possível baixar a imagem.', err)
      setDownloadError(true)
    } finally {
      setDownloading(null)
    }
  }

  const downloadAll = () =>
    runDownload('all', () =>
      downloadImagesAsZip([...epochs.map((_, i) => epochFile(i)), ...(subtractedFile ? [subtractedFile] : [])], `${fileBase}_imagens`),
    )

  const canCompare = epochs.length >= 2
  const [before, after] = [...pair].sort((a, b) => a - b)

  // Esc sai do comparador; fora dele, volta ao mapa.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (comparing) setComparing(false)
      else onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [comparing, onBack])

  function startComparing() {
    // Parte da época em exibição e a compara com a vizinha.
    const base = typeof selected === 'number' ? selected : 0
    setPair([base, base + 1 < epochs.length ? base + 1 : base - 1])
    setComparing(true)
  }

  function pick(index: number) {
    if (!comparing) {
      setSelected(index)
      return
    }
    // No comparador, a nova escolha substitui a mais antiga das duas.
    setPair((prev) => (prev.includes(index) ? prev : [prev[1], index]))
  }

  const current = typeof selected === 'number' ? epochs[selected] : null
  const currentUrl = current?.imageUrl ?? sky.subtractedImageUrl ?? ''

  return (
    <div className="level2__body">
      <aside className="timeline" aria-label="Galeria temporal">
        <header className="timeline__header">
          <span>Linha do tempo</span>
          <span className="timeline__tools">
            <DownloadButton
              label={`Baixar todas as imagens (${epochs.length + (subtractedFile ? 1 : 0)}) em um arquivo .zip`}
              busy={downloading === 'all'}
              disabled={downloading !== null}
              onClick={downloadAll}
            />
            <span className="count">{epochs.length}</span>
          </span>
        </header>
        {comparing && <p className="timeline__hint">Escolha as duas datas a comparar.</p>}
        {downloadError && (
          <p className="timeline__hint timeline__hint--error" role="alert">
            Não foi possível baixar. Tente de novo.
          </p>
        )}
        <ol className="timeline__list">
          {epochs.map((epoch, i) => {
            const role = comparing ? (i === before ? 'A' : i === after ? 'B' : null) : null
            const active = comparing ? role !== null : selected === i
            return (
              <li key={`${epoch.date}-${i}`} className="thumb-wrap">
                <button
                  type="button"
                  className={`thumb${active ? ' thumb--active' : ''}`}
                  onClick={() => pick(i)}
                  aria-pressed={active}
                >
                  <Picture src={epoch.imageUrl} alt="" className="thumb__img" />
                  <span className="thumb__text">
                    <span className="thumb__date">{formatDate(epoch.date)}</span>
                    <span className="thumb__sub">{epoch.band ?? `Época ${i + 1}`}</span>
                  </span>
                  {role && <span className="thumb__role">{role}</span>}
                </button>
                <DownloadButton
                  label={`Baixar a imagem de ${formatDate(epoch.date)}`}
                  busy={downloading === i}
                  disabled={downloading !== null}
                  onClick={() => runDownload(i, () => downloadImage(epochFile(i)))}
                />
              </li>
            )
          })}
        </ol>
        {sky.subtractedImageUrl && subtractedFile && (
          <div className="timeline__extra">
            <header className="timeline__header">
              <span>Subtração</span>
            </header>
            <div className="thumb-wrap">
            <button
              type="button"
              className={`thumb${!comparing && selected === 'subtracted' ? ' thumb--active' : ''}`}
              onClick={() => setSelected('subtracted')}
              disabled={comparing}
              aria-pressed={!comparing && selected === 'subtracted'}
            >
              <Picture src={sky.subtractedImageUrl} alt="" className="thumb__img" />
              <span className="thumb__text">
                <span className="thumb__date">Imagem de diferença</span>
                <span className="thumb__sub">O que mudou entre as épocas</span>
              </span>
            </button>
            <DownloadButton
              label="Baixar a imagem de diferença"
              busy={downloading === 'subtracted'}
              disabled={downloading !== null}
              onClick={() => runDownload('subtracted', () => downloadImage(subtractedFile))}
            />
            </div>
          </div>
        )}
      </aside>

      <main className="viewer">
        <section className="meta-bar" aria-label="Metadados da captura">
          <div className="meta-bar__row">
            <Field label="Data">
              {comparing
                ? `${formatDate(epochs[before].date)}  →  ${formatDate(epochs[after].date)}`
                : current
                  ? formatDate(current.date)
                  : `${formatDate(epochs[0].date)} a ${formatDate(epochs[epochs.length - 1].date)}`}
            </Field>
            <Field label="RA">{formatRa(sky.coords.raDeg)}</Field>
            <Field label="Dec">{formatDec(sky.coords.decDeg)}</Field>
            <Field label="Banda">{(comparing ? epochs[before].band : current?.band) ?? 'Não informada'}</Field>
            <button
              type="button"
              className={`icon-btn meta-bar__info${showDetails ? ' meta-bar__info--on' : ''}`}
              onClick={() => setShowDetails((v) => !v)}
              aria-expanded={showDetails}
              aria-label="Mais detalhes da captura"
              title="Detalhes"
            >
              <Info size={16} />
            </button>
          </div>
          {showDetails && (
            <div className="meta-bar__row meta-bar__row--details">
              <Field label="Campo de visão">{sky.fov}°</Field>
              <Field label="Épocas">{epochs.length}</Field>
              <Field label="Flags de contaminação">{sky.contaminationFlags.join(', ')}</Field>
              <Field label="Origem">{result.source === 'api' ? 'Back-end' : 'Simulação local'}</Field>
            </div>
          )}
        </section>

        <div className="canvas">
          {!comparing && <ZoomableImage key={currentUrl} src={currentUrl} alt={current ? `Captura de ${formatDate(current.date)}` : 'Imagem de diferença'} />}

          {comparing && layout === 'slider' && (
            <div className="compare-slider">
              <ReactCompareSlider
                key={`${before}-${after}`}
                itemOne={<ReactCompareSliderImage src={epochs[before].imageUrl} alt={`Antes: ${formatDate(epochs[before].date)}`} style={{ objectFit: 'contain' }} />}
                itemTwo={<ReactCompareSliderImage src={epochs[after].imageUrl} alt={`Depois: ${formatDate(epochs[after].date)}`} style={{ objectFit: 'contain' }} />}
                style={{ width: '100%', height: '100%' }}
              />
              <span className="compare-tag compare-tag--left">A · {formatDate(epochs[before].date)}</span>
              <span className="compare-tag compare-tag--right">B · {formatDate(epochs[after].date)}</span>
            </div>
          )}

          {comparing && layout === 'side' && (
            <div className="compare-side">
              {[before, after].map((index, slot) => (
                <figure key={slot}>
                  <Picture src={epochs[index].imageUrl} alt={`Captura de ${formatDate(epochs[index].date)}`} />
                  <figcaption className={`compare-tag compare-tag--left`}>
                    {slot === 0 ? 'A' : 'B'} · {formatDate(epochs[index].date)}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>

        <footer className="viewer__footer">
          {comparing ? (
            <>
              <div className="segmented" role="group" aria-label="Modo de comparação">
                <button type="button" className={layout === 'slider' ? 'is-on' : ''} aria-pressed={layout === 'slider'} onClick={() => setLayout('slider')}>
                  <SquareSplitHorizontal size={14} aria-hidden="true" />
                  Sobreposição
                </button>
                <button type="button" className={layout === 'side' ? 'is-on' : ''} aria-pressed={layout === 'side'} onClick={() => setLayout('side')}>
                  <Columns2 size={14} aria-hidden="true" />
                  Lado a lado
                </button>
              </div>
              <button type="button" className="btn" onClick={() => setComparing(false)}>
                <X size={14} aria-hidden="true" />
                Sair da comparação
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--primary btn--compare"
              onClick={startComparing}
              disabled={!canCompare}
              title={canCompare ? undefined : 'É preciso ter pelo menos duas épocas para comparar'}
            >
              <GitCompareArrows size={15} aria-hidden="true" />
              Comparar
            </button>
          )}
        </footer>
      </main>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="field">
      <span className="field__label">{label}</span>
      <span className="field__value">{children}</span>
    </span>
  )
}

/** Quadradinho com o ícone de download; vira um indicador de carregamento enquanto baixa. */
function DownloadButton({ label, busy, disabled, onClick }: { label: string; busy: boolean; disabled: boolean; onClick(): void }) {
  return (
    <button type="button" className="dl-btn" onClick={onClick} disabled={disabled} aria-label={label} title={label}>
      {busy ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <Download size={12} aria-hidden="true" />}
    </button>
  )
}

/** <img> que troca por um aviso quando a imagem não carrega. */
function Picture({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (failedSrc === src) {
    return (
      <span className={`picture-error ${className ?? ''}`} role="img" aria-label="Imagem indisponível">
        <ImageOff size={18} aria-hidden="true" />
        {!className && <span>Não foi possível carregar a imagem</span>}
      </span>
    )
  }
  return <img src={src} alt={alt} className={className} draggable={false} onError={() => setFailedSrc(src)} />
}

function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  return (
    <TransformWrapper minScale={1} maxScale={12} centerOnInit doubleClick={{ mode: 'toggle', step: 2 }}>
      {({ zoomIn, zoomOut, resetTransform }) => (
        <>
          <TransformComponent wrapperClass="zoom__wrapper" contentClass="zoom__content">
            <Picture src={src} alt={alt} />
          </TransformComponent>
          <div className="zoom-controls" role="group" aria-label="Zoom da imagem">
            <button type="button" onClick={() => zoomIn()} aria-label="Aproximar" title="Aproximar">
              <Plus size={16} />
            </button>
            <button type="button" onClick={() => zoomOut()} aria-label="Afastar" title="Afastar">
              <Minus size={16} />
            </button>
            <button type="button" onClick={() => resetTransform()} aria-label="Restaurar zoom" title="Restaurar zoom">
              <RotateCcw size={14} />
            </button>
          </div>
        </>
      )}
    </TransformWrapper>
  )
}
