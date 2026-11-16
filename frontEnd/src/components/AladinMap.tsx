import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, Ref } from 'react'
import A from 'aladin-lite'
import type { AladinInstance } from 'aladin-lite'
import { Check, Copy, Maximize, Minimize, Minus, Plus, Search } from 'lucide-react'
import type { Coords } from '../types'
import { BASE_SURVEYS, FOCUS_FOV, RESOLVE_TIMEOUT_MS } from '../config'
import { GAIA_HIPS_CATALOG, GAIA_MAX_STARS, fetchGaiaStars, gaiaPopupData, planGaiaQuery } from '../services/gaia'
import { formatDec, formatRa } from '../utils/coords'

export interface AladinMapHandle {
  /** Navegação programática (gotoRaDec + zoom). */
  goTo(coords: Coords, fov?: number): void
  /** Resolve um nome de objeto (ex.: "M31") e centraliza o mapa nele. */
  resolve(name: string): Promise<Coords>
}

interface Props {
  ref?: Ref<AladinMapHandle>
  selected: Coords | null
  onSelect(coords: Coords): void
  onInspect(coords: Coords): void
}

type GaiaStatus =
  | { state: 'zoom' | 'loading' | 'error' | 'hips' }
  | { state: 'ok'; count: number }

const GAIA_STYLE = { name: 'Gaia DR3', color: '#5eead4', sourceSize: 9, shape: 'circle', onClick: 'showPopup' } as const

function gaiaLabel(gaia: GaiaStatus) {
  switch (gaia.state) {
    case 'zoom':
      return 'Gaia DR3 · aproxime para ver'
    case 'loading':
      return 'Gaia DR3 · carregando…'
    case 'error':
      return 'Gaia DR3 · indisponível'
    case 'hips':
      return 'Gaia DR3 · catálogo CDS'
    case 'ok':
      return `Gaia DR3 · ${gaia.count >= GAIA_MAX_STARS ? `${GAIA_MAX_STARS}+` : gaia.count} estrelas`
  }
}

const CLICK_TOLERANCE_PX = 5
const ZOOM_STEP = 1.6
const isCanvas = (target: EventTarget) => target instanceof HTMLCanvasElement

/** Testa os servidores em paralelo e devolve o primeiro da lista que respondeu. */
async function pickSurvey() {
  const checks = await Promise.all(
    BASE_SURVEYS.map(async (survey) => {
      try {
        const res = await fetch(`${survey.url}/properties`, { signal: AbortSignal.timeout(4000) })
        return res.ok && (await res.text()).includes('hips_')
      } catch {
        return false
      }
    }),
  )
  const index = checks.indexOf(true)
  return { ...BASE_SURVEYS[Math.max(index, 0)], reachable: index >= 0 }
}

export function AladinMap({ ref, selected, onSelect, onInspect }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const markerRef = useRef<HTMLDivElement>(null)
  const aladinRef = useRef<AladinInstance | null>(null)
  const pressRef = useRef<{ x: number; y: number } | null>(null)
  const frameRef = useRef(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [hover, setHover] = useState<Coords | null>(null)
  const [copied, setCopied] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  /** Nome do fundo em uso; null se nenhum servidor de imagens respondeu. */
  const [surveyName, setSurveyName] = useState<string | null>(null)
  const [gaia, setGaia] = useState<GaiaStatus>({ state: 'zoom' })

  // Cria a instância uma única vez; ela sobrevive às trocas de tela.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false

    Promise.all([pickSurvey(), A.init])
      .then(([survey]) => {
        if (cancelled) return
        setSurveyName(survey.reachable ? survey.name : null)
        aladinRef.current = A.aladin(host, {
          survey: survey.url,
          target: '266.41683 -29.00781',
          fov: 60,
          cooFrame: 'ICRS',
          projection: 'SIN',
          mode: 'dark',
          log: false,
          backgroundColor: 'rgb(8, 7, 22)',
          // A interface do esboço substitui os controles nativos.
          showLayersControl: false,
          showZoomControl: false,
          showFullscreenControl: false,
          showCooLocation: false,
          showFov: false,
          showFrame: false,
          showProjectionControl: false,
          showStatusBar: false,
          showContextMenu: false,
          showReticle: false,
        })
        setStatus('ready')
      })
      .catch((err: unknown) => {
        console.error('[AladinMap] Falha ao iniciar o Aladin Lite.', err)
        if (!cancelled) setStatus('error')
      })

    return () => {
      cancelled = true
      aladinRef.current = null
      host.replaceChildren()
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      goTo(coords, fov = FOCUS_FOV) {
        const aladin = aladinRef.current
        if (!aladin) return
        aladin.gotoRaDec(coords.raDeg, coords.decDeg)
        aladin.setFoV(fov)
      },
      resolve(name) {
        return new Promise<Coords>((resolve, reject) => {
          const aladin = aladinRef.current
          if (!aladin) {
            reject(new Error('Mapa ainda não carregado'))
            return
          }
          // O serviço de nomes é externo (CDS Sesame): sem limite de tempo a busca ficaria presa.
          const timer = setTimeout(() => reject(new Error('timeout')), RESOLVE_TIMEOUT_MS)
          aladin.gotoObject(name, {
            success: ([raDeg, decDeg]) => {
              clearTimeout(timer)
              resolve({ raDeg, decDeg })
            },
            error: () => {
              clearTimeout(timer)
              reject(new Error('not-found'))
            },
          })
        })
      },
    }),
    [],
  )

  // Mantém o marcador da seleção preso à posição do céu enquanto o mapa se move.
  useEffect(() => {
    const marker = markerRef.current
    if (!marker || !selected || status !== 'ready') return
    let frame = 0
    const tick = () => {
      const px = aladinRef.current?.world2pix(selected.raDeg, selected.decDeg)
      if (px && Number.isFinite(px[0]) && Number.isFinite(px[1])) {
        marker.style.transform = `translate(${px[0]}px, ${px[1]}px)`
        marker.style.visibility = 'visible'
      } else {
        marker.style.visibility = 'hidden'
      }
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [selected, status])

  // Camada Gaia DR3: recarrega as estrelas quando a vista para de se mover.
  useEffect(() => {
    const aladin = aladinRef.current
    if (status !== 'ready' || !aladin) return

    const catalog = A.catalog(GAIA_STYLE)
    aladin.addCatalog(catalog)

    let controller: AbortController | null = null
    let previous = ''
    let loaded: { center: Coords; fov: number } | null = null
    let triedHips = false
    let stopped = false

    /** Sem o proxy do Vite (ex.: build estático), tenta o catálogo progressivo do CDS. */
    async function fallBackToHips() {
      triedHips = true
      try {
        const res = await fetch(`${GAIA_HIPS_CATALOG}/properties`, { signal: AbortSignal.timeout(4000) })
        if (!res.ok || stopped) return false
        aladin?.addCatalog(A.catalogHiPS(GAIA_HIPS_CATALOG, GAIA_STYLE))
        return true
      } catch {
        return false
      }
    }

    async function load(center: Coords, fov: number) {
      controller?.abort()
      const plan = planGaiaQuery(fov)
      if (!plan) {
        catalog.removeAll()
        setGaia({ state: 'zoom' })
        return
      }
      controller = new AbortController()
      const { signal } = controller
      setGaia({ state: 'loading' })
      try {
        const stars = await fetchGaiaStars(center, plan, signal)
        if (signal.aborted) return
        catalog.removeAll()
        catalog.addSources(stars.map((s) => A.source(s.raDeg, s.decDeg, gaiaPopupData(s))))
        setGaia({ state: 'ok', count: stars.length })
      } catch (err) {
        if (signal.aborted) return
        console.warn('[Gaia DR3] Consulta ao arquivo da ESA falhou.', err)
        if (!triedHips && (await fallBackToHips())) {
          clearInterval(timer)
          setGaia({ state: 'hips' })
          return
        }
        loaded = null // tenta de novo na próxima mudança de vista
        setGaia({ state: 'error' })
      }
    }

    const timer = setInterval(() => {
      const [raDeg, decDeg] = aladin.getRaDec()
      const fov = aladin.getFov()[0]
      const view = `${raDeg.toFixed(4)},${decDeg.toFixed(4)},${fov.toFixed(4)}`
      const moving = view !== previous
      previous = view
      if (moving) return

      // Só refaz a consulta se a vista saiu de perto da última carregada.
      if (loaded) {
        const drift = Math.hypot((raDeg - loaded.center.raDeg) * Math.cos((decDeg * Math.PI) / 180), decDeg - loaded.center.decDeg)
        const sameZoom = Math.abs(fov - loaded.fov) < loaded.fov * 0.2
        if (sameZoom && drift < fov * 0.15) return
      }
      loaded = { center: { raDeg, decDeg }, fov }
      void load({ raDeg, decDeg }, fov)
    }, 500)

    return () => {
      stopped = true
      clearInterval(timer)
      controller?.abort()
    }
  }, [status])

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === wrapperRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      cancelAnimationFrame(frameRef.current)
    }
  }, [])

  function toSky(clientX: number, clientY: number): Coords | null {
    const aladin = aladinRef.current
    const wrapper = wrapperRef.current
    if (!aladin || !wrapper) return null
    const rect = wrapper.getBoundingClientRect()
    try {
      const sky = aladin.pix2world(clientX - rect.left, clientY - rect.top, 'icrs')
      if (!sky || !Number.isFinite(sky[0]) || !Number.isFinite(sky[1])) return null
      return { raDeg: sky[0], decDeg: sky[1] }
    } catch {
      return null // cursor fora da esfera projetada
    }
  }

  function handleMove(e: ReactPointerEvent) {
    const { clientX, clientY, target } = e
    cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => {
      setHover(isCanvas(target) ? toSky(clientX, clientY) : null)
    })
  }

  function handleDown(e: ReactPointerEvent) {
    pressRef.current = isCanvas(e.target) && e.button === 0 ? { x: e.clientX, y: e.clientY } : null
  }

  // Um clique só conta como seleção se o ponteiro não arrastou o mapa.
  function handleUp(e: ReactPointerEvent) {
    const press = pressRef.current
    pressRef.current = null
    if (!press || !isCanvas(e.target)) return
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_TOLERANCE_PX) return
    const hit = toSky(e.clientX, e.clientY)
    if (hit) onSelect(hit)
  }

  function zoom(factor: number) {
    const aladin = aladinRef.current
    if (aladin) aladin.setFoV(aladin.getFov()[0] * factor)
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void wrapperRef.current?.requestFullscreen()
  }

  /** O card mostra o cursor; sem cursor sobre o mapa, mostra o ponto fixado. */
  const shown = hover ?? selected
  const showingSelection = !hover && selected !== null

  async function copyCoords() {
    if (!shown) return
    try {
      await navigator.clipboard.writeText(`${formatRa(shown.raDeg)} ${formatDec(shown.decDeg)}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Área de transferência indisponível (ex.: página sem foco): ignora.
    }
  }

  return (
    <div
      ref={wrapperRef}
      className="map"
      onPointerMoveCapture={handleMove}
      onPointerDownCapture={handleDown}
      onPointerUpCapture={handleUp}
      onPointerLeave={() => {
        cancelAnimationFrame(frameRef.current)
        setHover(null)
      }}
    >
      <div ref={hostRef} className="map__aladin" />

      {selected && <div ref={markerRef} className="map__marker" aria-hidden="true" />}

      <div className="brand" aria-label="OrbitaX. Explorador celeste">
        <span className="brand__name">OrbitaX</span>
        <span className="brand__tag">
          <span className="brand__title">Explorador celeste</span>
          <span className="brand__sub">SPHEREx / IRSA · NASA</span>
        </span>
      </div>

      <section className="coords-card" aria-label="Coordenadas" aria-live="polite">
        <header className="coords-card__header">
          <span>Coordenadas</span>
          <span className="coords-card__actions">
            {selected && (
              <button
                type="button"
                className="coords-card__inspect"
                onClick={() => onInspect(selected)}
                title="Abrir a análise deste ponto: imagens em várias datas"
              >
                <Search size={15} aria-hidden="true" />
                Analisar
              </button>
            )}
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              onClick={copyCoords}
              disabled={!shown}
              aria-label="Copiar coordenadas"
              title={copied ? 'Copiado' : 'Copiar coordenadas'}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </span>
        </header>
        <div className="coords-card__values">
          <span>
            <b>RA</b>
            <span className={shown ? 'coords-card__value' : 'coords-card__dash'}>{shown ? formatRa(shown.raDeg) : '—'}</span>
          </span>
          <span>
            <b>Dec</b>
            <span className={shown ? 'coords-card__value' : 'coords-card__dash'}>{shown ? formatDec(shown.decDeg) : '—'}</span>
          </span>
        </div>
        <footer className="coords-card__footer">ICRS · Equatorial{showingSelection && ' · ponto fixado'}</footer>
      </section>

      <div className="viewer-card">
        <span className="viewer-card__sub">Arraste para explorar · Role para aproximar</span>
        {status === 'ready' && (
          <span className="viewer-card__survey">
            <span className={surveyName ? undefined : 'viewer-card__warn'}>{surveyName ?? 'Imagens do céu indisponíveis'}</span>
            <span className={gaia.state === 'error' ? 'viewer-card__warn' : 'viewer-card__gaia'}>{gaiaLabel(gaia)}</span>
          </span>
        )}
      </div>

      <div className="zoom-controls" role="group" aria-label="Controles do mapa">
        <button type="button" onClick={() => zoom(1 / ZOOM_STEP)} aria-label="Aproximar" title="Aproximar">
          <Plus size={16} />
        </button>
        <button type="button" onClick={() => zoom(ZOOM_STEP)} aria-label="Afastar" title="Afastar">
          <Minus size={16} />
        </button>
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
          title={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
        >
          {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
        </button>
      </div>

      {status !== 'ready' && (
        <div className="map__status">
          {status === 'loading'
            ? 'Carregando mapa estelar…'
            : 'Não foi possível iniciar o mapa. Este navegador precisa de suporte a WebGL2.'}
        </div>
      )}
    </div>
  )
}
