import { useCallback, useEffect, useRef, useState } from 'react'
import { AladinMap } from './components/AladinMap'
import type { AladinMapHandle } from './components/AladinMap'
import { OptionsModal } from './components/OptionsModal'
import { Sidebar } from './components/Sidebar'
import { FEATURED_TARGETS } from './config'
import { useSearchHistory } from './hooks/useSearchHistory'
import { spherexApi } from './services/spherexApi'
import type { ApiResult, Coords, SearchState, Target, ViewMode } from './types'
import { parseCoords } from './utils/coords'
import { Level2View } from './views/Level2View'

const SIDEBAR_KEY = 'spherex.sidebarCollapsed'

function readCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

export default function App() {
  const mapRef = useRef<AladinMapHandle>(null)
  const requestRef = useRef(0)
  const [viewMode, setViewMode] = useState<ViewMode>('level1')
  const [selected, setSelected] = useState<Coords | null>(null)
  const [search, setSearch] = useState<SearchState>({ status: 'idle' })
  const [targets, setTargets] = useState<ApiResult<Target[]> | null>(null)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const { history, add, remove, clear } = useSearchHistory()

  useEffect(() => {
    let cancelled = false
    spherexApi.getTargets().then((result) => {
      if (!cancelled) setTargets(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const focusOnMap = useCallback((coords: Coords) => {
    mapRef.current?.goTo(coords)
    setSelected(coords)
  }, [])

  /** Core loop: fixa a coordenada, abre o Nível 2 e busca as épocas em paralelo. */
  const inspect = useCallback(
    async (coords: Coords, label?: string, raw?: { ra: string; dec: string }) => {
      const requestId = ++requestRef.current
      add(coords, label)
      focusOnMap(coords)
      setSearch({ status: 'loading', coords, label })
      setViewMode('level2')
      const result = await spherexApi.getSky(coords, undefined, raw)
      // Ignora respostas de buscas antigas se o usuário já pediu outra.
      if (requestRef.current === requestId) setSearch({ status: 'done', coords, label, result })
    },
    [add, focusOnMap],
  )

  const handleSearch = useCallback(
    async (text: string): Promise<string | null> => {
      const coords = parseCoords(text)
      if (coords) {
        void inspect(coords)
        return null
      }
      if (!/[a-z]/i.test(text)) {
        return 'Coordenada inválida. RA vai de 0 a 360° (ou 0 a 24h) e Dec de -90° a +90°.'
      }
      try {
        const resolved = await mapRef.current?.resolve(text)
        if (!resolved) return 'O mapa ainda está carregando. Tente novamente em instantes.'
        void inspect(resolved, text)
        return null
      } catch (err) {
        return err instanceof Error && err.message === 'timeout'
          ? 'O serviço de nomes de objetos não respondeu. Tente de novo ou use coordenadas.'
          : `Não consegui localizar "${text}": nome desconhecido ou serviço de nomes fora do ar. Tente coordenadas.`
      }
    },
    [inspect],
  )

  function toggleSidebar() {
    setCollapsed((prev) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, prev ? '0' : '1')
      } catch {
        // preferência apenas em memória
      }
      return !prev
    })
  }

  const closeOptions = useCallback(() => setOptionsOpen(false), [])
  const inLevel1 = viewMode === 'level1'

  return (
    <div className="app">
      {/* O Nível 1 nunca é desmontado: o contexto WebGL do Aladin sobrevive à troca de tela. */}
      <div className="level1" inert={!inLevel1} aria-hidden={!inLevel1}>
        <main className="level1__main">
          <AladinMap
            ref={mapRef}
            selected={selected}
            onSelect={setSelected}
            onInspect={(coords) => void inspect(coords)}
          />
        </main>
        <Sidebar
          collapsed={collapsed}
          onToggle={toggleSidebar}
          search={search}
          onSearch={handleSearch}
          onReopenSearch={() => setViewMode('level2')}
          history={history}
          onHistoryOpen={(entry) => void inspect(entry.coords, entry.label)}
          onHistoryRemove={remove}
          onHistoryClear={clear}
          featured={FEATURED_TARGETS}
          targets={targets}
          onTargetInspect={(target) =>
            void inspect(
              target.coords,
              target.name,
              target.raText && target.decText ? { ra: target.raText, dec: target.decText } : undefined,
            )
          }
          onOpenOptions={() => setOptionsOpen(true)}
        />
      </div>

      {viewMode === 'level2' && <Level2View search={search} onBack={() => setViewMode('level1')} />}
      {/* viewMode === 'level3': reservado para expansão futura. */}

      {optionsOpen && <OptionsModal onClose={closeOptions} />}
    </div>
  )
}
