import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { CalendarClock, Columns2, Diff, Download, GitCompareArrows, ImageOff, Info, Layers, LoaderCircle, Minus, Pause, Play, Plus, RotateCcw, SlidersHorizontal, Undo2, X } from 'lucide-react'
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch'
import { ImageTools } from '../components/ImageTools'
import { useImageTools } from '../hooks/useImageTools'
import { useSpectrum } from '../hooks/useSpectrum'
import type { ApiResult, Epoch, SearchState, SkyData } from '../types'
import { formatDec, formatRa } from '../utils/coords'
import { downloadImage, downloadImagesAsZip, saveBlob, slug } from '../utils/download'
import type { DownloadItem } from '../utils/download'
import { buildGif } from '../utils/gif'
import { bandLabel, micron } from '../utils/imaging'
import type { Layer } from '../utils/imaging'

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
        <span className="level2__brand">OrbitaX</span>
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
        {search.status === 'done' && search.result.source === 'api' && search.result.data.source === 'LOCAL_REAL_FITS' && (
          <span className="badge level2__source" title="API da NASA sem recorte público para esta coordenada: usando FITS reais locais">
            FITS locais (fallback)
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

type Selection = number | 'subtracted' | 'rgb'
type CompareLayout = 'side' | 'overlay'
type PaneId = 'A' | 'B'

/** Tempo de cada imagem na animação e no GIF. */
const FRAME_MS = 900

function Analysis({ result, label, onBack }: { result: ApiResult<SkyData>; label?: string; onBack(): void }) {
  const sky = result.data
  const [epochs] = useState<Epoch[]>(() => [...sky.epochs].sort((a, b) => a.date.localeCompare(b.date)))
  /**
   * O que cada painel mostra. Fora da comparação só existe o painel A. Na comparação, cada
   * painel tem a sua imagem e os seus próprios ajustes de ferramentas.
   */
  const [shown, setShown] = useState<Record<PaneId, Selection>>({ A: 0, B: Math.min(1, epochs.length - 1) })
  const [comparing, setComparing] = useState(false)
  const [layout, setLayout] = useState<CompareLayout>('side')
  /** Painel que a linha do tempo e as ferramentas controlam durante a comparação. */
  const [activePane, setActivePane] = useState<PaneId>('A')
  /** Na sobreposição: quanto do painel B aparece por cima do A (0 a 1). */
  const [opacity, setOpacity] = useState(0.5)
  /** Animação: as épocas passam em sequência, como num GIF. */
  const [playing, setPlaying] = useState(false)
  const [frame, setFrame] = useState(0)
  const [showDetails, setShowDetails] = useState(false)
  /** Qual download está em andamento: índice da época, 'subtracted', 'all' ou 'gif'. */
  const [downloading, setDownloading] = useState<Selection | 'all' | 'gif' | null>(null)
  const [downloadError, setDownloadError] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  /** O que cada painel exibia antes de abrir a composição RGB, para poder voltar. */
  const [beforeRgb, setBeforeRgb] = useState<Record<PaneId, Selection>>({ A: 0, B: 0 })

  const toolsA = useImageTools(epochs, shown.A === 'rgb')
  const toolsB = useImageTools(epochs, comparing && shown.B === 'rgb', comparing)
  const spectrum = useSpectrum(epochs)

  const pane: PaneId = comparing ? activePane : 'A'
  const tools = pane === 'A' ? toolsA : toolsB
  const selected = shown[pane]
  const showingRgb = selected === 'rgb'
  const select = (target: PaneId, value: Selection) => setShown((prev) => ({ ...prev, [target]: value }))

  /** Endereço da imagem de um painel: a ajustada pelas ferramentas, se houver; senão a original. */
  const paneUrl = (id: PaneId): string => {
    const t = id === 'A' ? toolsA : toolsB
    const what = shown[id]
    if (what === 'rgb') return t.rgbUrl ?? ''
    if (what === 'subtracted') return sky.subtractedImageUrl ?? ''
    return t.epochUrls?.[what] ?? epochs[what].imageUrl
  }
  /** Descrição curta do que um painel mostra. */
  const paneText = (id: PaneId): string => {
    const what = shown[id]
    return what === 'rgb' ? 'Composição em cores' : what === 'subtracted' ? 'Imagem de diferença' : formatDate(epochs[what].date)
  }

  function toggleRgb() {
    if (showingRgb) {
      select(pane, beforeRgb[pane])
    } else {
      setBeforeRgb((prev) => ({ ...prev, [pane]: selected }))
      select(pane, 'rgb')
    }
  }

  /** Texto de uma camada nos seletores de cor: a data (épocas) ou a faixa de cor (bandas). */
  const layerLabel = (layer: Layer) => {
    if (layer.kind === 'band') return bandLabel(layer.band, layer.wavelength)
    const day = formatDate((layer.date ?? '').slice(0, 10))
    const detector = /D\d$/.exec(layer.band ?? '')?.[0] // só detectores do SPHEREx ("D3")
    return detector ? `${day} · ${bandLabel(layer.band, layer.wavelength)}` : day
  }

  // Nomes dos arquivos: alvo (ou coordenada) + data da captura.
  const fileBase = `orbitax_${slug(label ?? `${formatRa(sky.coords.raDeg)}_${formatDec(sky.coords.decDeg)}`)}`
  const epochFile = (i: number): DownloadItem => ({
    url: epochs[i].imageUrl,
    name: `${fileBase}_epoca-${i + 1}_${slug(epochs[i].date.slice(0, 19).replace(/:/g, '-'))}`,
  })
  const subtractedFile: DownloadItem | null = sky.subtractedImageUrl
    ? { url: sky.subtractedImageUrl, name: `${fileBase}_subtracao` }
    : null

  async function runDownload(key: Selection | 'all' | 'gif', task: () => Promise<void>) {
    setDownloading(key)
    setDownloadError(false)
    try {
      await task()
    } catch (err) {
      console.warn('[download] não foi possível baixar.', err)
      setDownloadError(true)
    } finally {
      setDownloading(null)
    }
  }

  const downloadAll = () =>
    runDownload('all', () =>
      downloadImagesAsZip([...epochs.map((_, i) => epochFile(i)), ...(subtractedFile ? [subtractedFile] : [])], `${fileBase}_imagens`),
    )

  /** GIF com as épocas em ordem, do jeito que estão na tela (com os ajustes das ferramentas). */
  const downloadGif = () =>
    runDownload('gif', async () => {
      const frames = epochs.map((epoch, i) => ({ url: toolsA.epochUrls?.[i] ?? epoch.imageUrl, label: formatDate(epoch.date) }))
      saveBlob(await buildGif(frames, FRAME_MS), `${fileBase}_animacao.gif`)
    })

  const canCompare = epochs.length >= 2

  // Esc: para a animação; sai do comparador; fora deles, volta ao mapa.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (playing) setPlaying(false)
      else if (comparing) setComparing(false)
      else onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [playing, comparing, onBack])

  // Animação: troca de época a cada FRAME_MS.
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => setFrame((f) => (f + 1) % epochs.length), FRAME_MS)
    return () => window.clearInterval(timer)
  }, [playing, epochs.length])

  function togglePlaying() {
    if (!playing) setFrame(typeof shown.A === 'number' ? shown.A : 0)
    setPlaying((v) => !v)
  }

  function startComparing() {
    setPlaying(false)
    // O painel B abre com os mesmos ajustes do A. Se o A mostra uma época, o B mostra a vizinha;
    // se mostra a composição ou a diferença, o B começa igual e o usuário muda o que quiser.
    toolsB.restore(toolsA.snapshot())
    const base = shown.A
    select('B', typeof base === 'number' ? (base + 1 < epochs.length ? base + 1 : base - 1) : base)
    setBeforeRgb((prev) => ({ ...prev, B: prev.A }))
    setActivePane('B')
    setComparing(true)
  }

  function pick(value: Selection) {
    setPlaying(false)
    select(pane, value)
  }

  const current = typeof selected === 'number' ? epochs[selected] : null
  const currentUrl = paneUrl(pane)
  // Comprimento de onda em que o alvo foi visto na época em exibição (vem das camadas).
  const shownWavelength = typeof selected === 'number' ? tools.layers?.epochs[selected]?.wavelength : undefined
  // Só as imagens redesenhadas pelas ferramentas (endereço "blob:") têm download próprio aqui.
  const toolDownload = currentUrl.startsWith('blob:')
    ? { href: currentUrl, name: `${fileBase}_${showingRgb ? 'composicao-rgb' : `epoca-${Number(selected) + 1}_ajustada`}.png` }
    : null
  /** Letra do painel que mostra esta seleção (para marcar na linha do tempo), se houver. */
  const roleOf = (value: Selection) => (!comparing ? null : shown.A === value && shown.B === value ? 'A·B' : shown.A === value ? 'A' : shown.B === value ? 'B' : null)

  return (
    <div className="level2__body">
      <aside className="timeline" aria-label="Galeria temporal">
        <header className="timeline__header">
          <span className="with-icon">
            <CalendarClock size={15} aria-hidden="true" />
            Linha do tempo
          </span>
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
        {comparing && <p className="timeline__hint">Escolha o que o painel {pane} mostra.</p>}
        {downloadError && (
          <p className="timeline__hint timeline__hint--error" role="alert">
            Não foi possível baixar. Tente de novo.
          </p>
        )}
        <ol className="timeline__list">
          {epochs.map((epoch, i) => {
            const role = roleOf(i)
            const active = playing ? frame === i : comparing ? role !== null : selected === i
            return (
              <li key={`${epoch.date}-${i}`} className="thumb-wrap">
                <button type="button" className={`thumb${active ? ' thumb--active' : ''}`} onClick={() => pick(i)} aria-pressed={active}>
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
              <span className="with-icon">
                <Diff size={15} aria-hidden="true" />
                Subtração
              </span>
            </header>
            <div className="thumb-wrap">
              <button
                type="button"
                className={`thumb${!playing && (comparing ? roleOf('subtracted') !== null : selected === 'subtracted') ? ' thumb--active' : ''}`}
                onClick={() => pick('subtracted')}
                aria-pressed={!playing && selected === 'subtracted'}
              >
                <Picture src={sky.subtractedImageUrl} alt="" className="thumb__img" />
                <span className="thumb__text">
                  <span className="thumb__date">Imagem de diferença</span>
                  <span className="thumb__sub">O que mudou entre as épocas</span>
                </span>
                {roleOf('subtracted') && <span className="thumb__role">{roleOf('subtracted')}</span>}
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
            <Field label={comparing ? 'Painel A  →  Painel B' : 'Data'}>
              {playing
                ? formatDate(epochs[frame].date)
                : comparing
                  ? `${paneText('A')}  →  ${paneText('B')}`
                  : current
                    ? formatDate(current.date)
                    : showingRgb
                      ? 'Composição em cores'
                      : `${formatDate(epochs[0].date)} a ${formatDate(epochs[epochs.length - 1].date)}`}
            </Field>
            <Field label="RA">{formatRa(sky.coords.raDeg)}</Field>
            <Field label="Dec">{formatDec(sky.coords.decDeg)}</Field>
            <Field label="Banda">{showingRgb ? 'RGB (ver ferramentas)' : ((current ?? epochs[0]).band ?? sky.band ?? 'Não informada')}</Field>
            {!showingRgb && !playing && shownWavelength && <Field label="Comprimento de onda">{micron(shownWavelength, 3)} µm</Field>}
            {sky.contaminationFlags.some((f) => f && f !== 'NONE') && (
              <Field label="Alertas">{sky.contaminationFlags.filter((f) => f !== 'NONE').join(', ')}</Field>
            )}
            <button
              type="button"
              className={`icon-btn meta-bar__info${showDetails ? ' meta-bar__info--on' : ''}`}
              onClick={() => setShowDetails((v) => !v)}
              aria-expanded={showDetails}
              aria-label="Mais detalhes da captura"
              title="Detalhes"
            >
              <Info size={19} />
            </button>
          </div>
          {showDetails && (
            <div className="meta-bar__row meta-bar__row--details">
              <Field label="Campo de visão">{sky.fov}°</Field>
              <Field label="Épocas">{epochs.length}</Field>
              <Field label="Flags de contaminação">{sky.contaminationFlags.join(', ')}</Field>
              <Field label="Origem">
                {result.source !== 'api'
                  ? 'Simulação local'
                  : sky.source === 'NASA_API_LIVE'
                    ? 'NASA IRSA (ao vivo)'
                    : sky.source === 'LOCAL_REAL_FITS'
                      ? 'Back-end (FITS reais locais)'
                      : 'Back-end'}
              </Field>
            </div>
          )}
        </section>

        <div className="canvas">
          {playing && (
            <div className="animation">
              <Picture src={toolsA.epochUrls?.[frame] ?? epochs[frame].imageUrl} alt={`Captura de ${formatDate(epochs[frame].date)}`} />
              <span className="compare-tag compare-tag--right">
                {frame + 1} de {epochs.length} · {formatDate(epochs[frame].date)}
              </span>
            </div>
          )}

          {!playing && !comparing && currentUrl && (
            // A chave é a seleção (não o endereço): mexer nos controles não desfaz o zoom.
            <ZoomableImage
              key={String(selected)}
              src={currentUrl}
              alt={current ? `Captura de ${formatDate(current.date)}` : showingRgb ? 'Composição em cores' : 'Imagem de diferença'}
            />
          )}
          {!playing && !comparing && !currentUrl && <Composing />}

          {comparing && layout === 'side' && (
            <div className="compare-side">
              {(['A', 'B'] as const).map((id) => (
                <figure key={id} className={id === pane ? 'is-active' : ''} onClick={() => setActivePane(id)}>
                  {paneUrl(id) ? <Picture src={paneUrl(id)} alt={`Painel ${id}: ${paneText(id)}`} /> : <Composing />}
                  <figcaption className="compare-tag compare-tag--right">
                    {id} · {paneText(id)}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}

          {comparing && layout === 'overlay' && (
            <div className="compare-overlay">
              {paneUrl('A') ? <Picture src={paneUrl('A')} alt={`Painel A: ${paneText('A')}`} /> : <Composing />}
              <div className="compare-overlay__top" style={{ opacity }}>
                {paneUrl('B') && <Picture src={paneUrl('B')} alt={`Painel B: ${paneText('B')}`} />}
              </div>
              <label className="compare-overlay__slider">
                <span>A · {paneText('A')}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={opacity}
                  onChange={(e) => setOpacity(Number(e.target.value))}
                  aria-label="Opacidade do painel B sobre o painel A"
                />
                <span>B · {paneText('B')}</span>
                <output>{Math.round(opacity * 100)}% de B</output>
              </label>
            </div>
          )}

          {toolsOpen && (
            <ImageTools
              tools={tools}
              layerLabel={layerLabel}
              rgbActive={showingRgb}
              pane={comparing ? pane : undefined}
              onToggleRgb={toggleRgb}
              download={toolDownload}
              spectrum={spectrum.state}
              spectrumAddress={spectrum.url}
              fileBase={fileBase}
              onClose={() => setToolsOpen(false)}
            />
          )}
        </div>

        <footer className="viewer__footer">
          <button
            type="button"
            className={`btn${toolsOpen ? ' is-on' : ''}`}
            onClick={() => setToolsOpen((open) => !open)}
            aria-pressed={toolsOpen}
            title="Ajustes de imagem, espectro do alvo e ferramentas científicas"
          >
            <SlidersHorizontal size={16} aria-hidden="true" />
            Ferramentas
          </button>
          {comparing ? (
            <>
              <div className="segmented" role="group" aria-label="Painel que a linha do tempo e as ferramentas controlam">
                {(['A', 'B'] as const).map((id) => (
                  <button key={id} type="button" className={pane === id ? 'is-on' : ''} aria-pressed={pane === id} onClick={() => setActivePane(id)}>
                    Painel {id}
                  </button>
                ))}
              </div>
              <div className="segmented" role="group" aria-label="Modo de comparação">
                <button type="button" className={layout === 'side' ? 'is-on' : ''} aria-pressed={layout === 'side'} onClick={() => setLayout('side')}>
                  <Columns2 size={14} aria-hidden="true" />
                  Lado a lado
                </button>
                <button type="button" className={layout === 'overlay' ? 'is-on' : ''} aria-pressed={layout === 'overlay'} onClick={() => setLayout('overlay')}>
                  <Layers size={14} aria-hidden="true" />
                  Sobreposição
                </button>
              </div>
              <button type="button" className="btn" onClick={() => setComparing(false)}>
                <X size={14} aria-hidden="true" />
                Sair da comparação
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`btn${playing ? ' is-on' : ''}`}
                onClick={togglePlaying}
                disabled={!canCompare}
                aria-pressed={playing}
                title={canCompare ? 'Mostra as imagens em sequência, da mais antiga à mais recente' : 'É preciso ter pelo menos duas épocas'}
              >
                {playing ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
                {playing ? 'Parar animação' : 'Animação'}
              </button>
              {playing && (
                <button type="button" className="btn" onClick={downloadGif} disabled={downloading !== null}>
                  {downloading === 'gif' ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
                  Baixar GIF
                </button>
              )}
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
            </>
          )}
        </footer>
      </main>
    </div>
  )
}

/** Aviso enquanto a composição em cores é desenhada. */
function Composing() {
  return (
    <div className="level2__loading">
      <LoaderCircle size={20} className="spin" aria-hidden="true" />
      Montando a composição…
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
