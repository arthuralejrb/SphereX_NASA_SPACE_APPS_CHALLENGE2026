import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, ChevronLeft, ChevronRight, Clock, LoaderCircle, Menu, Search, Trash2, X } from 'lucide-react'
import type { ApiResult, HistoryEntry, SearchState, Target } from '../types'
import { formatDec, formatRa } from '../utils/coords'
import { Accordion } from './Accordion'

interface Props {
  collapsed: boolean
  onToggle(): void
  search: SearchState
  /** Devolve uma mensagem de erro, ou null se a busca foi aceita. */
  onSearch(text: string): Promise<string | null>
  onReopenSearch(): void
  history: HistoryEntry[]
  onHistoryOpen(entry: HistoryEntry): void
  onHistoryRemove(entry: HistoryEntry): void
  onHistoryClear(): void
  /** Atalhos fixos, sempre exibidos antes dos alvos vindos da API. */
  featured: Target[]
  targets: ApiResult<Target[]> | null
  onTargetInspect(target: Target): void
  onOpenOptions(): void
}

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
const coordsText = (e: HistoryEntry) => `${formatRa(e.coords.raDeg)} ${formatDec(e.coords.decDeg)}`

export function Sidebar(props: Props) {
  const { collapsed, onToggle, search, history, targets } = props
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const text = query.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    const message = await props.onSearch(text)
    setBusy(false)
    setError(message)
  }

  const quickAccess = [
    ...props.featured,
    ...(targets?.data ?? []).filter((t) => !props.featured.some((f) => f.name === t.name)),
  ]
  const resultCount = search.status === 'done' ? search.result.data.epochs.length : 0

  return (
    <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`} aria-label="Barra lateral">
      <button
        type="button"
        className="sidebar__handle"
        onClick={onToggle}
        aria-label={collapsed ? 'Expandir barra lateral' : 'Recolher barra lateral'}
        aria-expanded={!collapsed}
        title={collapsed ? 'Expandir' : 'Recolher'}
      >
        {collapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
      </button>

      {!collapsed && (
        <>
          <form className="search" onSubmit={submit} role="search">
            <div className={`search__field${error ? ' search__field--error' : ''}`}>
              <Search size={16} aria-hidden="true" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setError(null)
                }}
                placeholder="Nome ou coordenadas (RA, Dec)"
                aria-label="Buscar por nome ou coordenadas"
                aria-invalid={error !== null}
                aria-describedby="search-help"
                spellCheck={false}
                autoComplete="off"
              />
              <button type="submit" className="search__submit" aria-label="Buscar" disabled={busy}>
                {busy ? <LoaderCircle size={14} className="spin" /> : <ArrowRight size={14} />}
              </button>
            </div>
            <p id="search-help" className={`search__help${error ? ' search__help--error' : ''}`} role={error ? 'alert' : undefined}>
              {error ?? 'Busque um corpo celeste ou informe sua posição no céu.'}
            </p>
          </form>

          <div className="sidebar__drawers">
            <Accordion title="Pesquisa" aside={<span className="count">{resultCount}</span>}>
              <SearchPanel search={search} onReopen={props.onReopenSearch} />
            </Accordion>

            <Accordion
              title="Histórico"
              aside={
                <>
                  {history.length > 0 && (
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm"
                      onClick={props.onHistoryClear}
                      aria-label="Limpar histórico"
                      title="Limpar histórico"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                  <span className="count">{history.length}</span>
                </>
              }
            >
              {history.length === 0 ? (
                <div className="card empty-state empty-state--compact">
                  <Clock size={17} className="empty-state__plain-icon" aria-hidden="true" />
                  <p className="empty-state__title empty-state__title--sm">Nenhuma pesquisa recente</p>
                  <p className="empty-state__text">Os objetos pesquisados aparecerão aqui.</p>
                </div>
              ) : (
                <ul className="card rows">
                  {history.map((entry) => (
                    <li key={entry.at} className="row">
                      <button type="button" className="row__main" onClick={() => props.onHistoryOpen(entry)}>
                        <span className="row__text">
                          <span className="row__label">{entry.label ?? coordsText(entry)}</span>
                          <span className="row__sub">
                            {entry.label && `${coordsText(entry)} · `}
                            {dateTime.format(entry.at)}
                          </span>
                        </span>
                        <ChevronRight size={15} className="row__chevron" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn icon-btn--sm row__remove"
                        onClick={() => props.onHistoryRemove(entry)}
                        aria-label="Remover do histórico"
                      >
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Accordion>

            <Accordion
              title="Acesso rápido"
              aside={targets?.source === 'mock' ? <span className="badge" title="Back-end indisponível: alvos de demonstração">mock</span> : undefined}
            >
              <ul className="card rows">
                {quickAccess.map((target) => (
                  <li key={target.name} className="row">
                    <button
                      type="button"
                      className="row__main"
                      onClick={() => props.onTargetInspect(target)}
                      title={`Inspecionar ${target.name}`}
                    >
                      <span className="row__code">{target.name}</span>
                      <span className="row__label">{target.description}</span>
                      <ChevronRight size={15} className="row__chevron" aria-hidden="true" />
                    </button>
                  </li>
                ))}
                {targets === null && <li className="row row__loading">Carregando alvos…</li>}
              </ul>
            </Accordion>
          </div>

          <footer className="sidebar__footer">
            <span>Dados abertos · SPHEREx / IRSA</span>
            <button
              type="button"
              className="menu-btn"
              onClick={props.onOpenOptions}
              aria-label="Abrir opções e suporte"
              title="Opções e suporte"
            >
              <Menu size={15} />
            </button>
          </footer>
        </>
      )}
    </aside>
  )
}

function SearchPanel({ search, onReopen }: { search: SearchState; onReopen(): void }) {
  if (search.status === 'idle') {
    return (
      <div className="card empty-state">
        <span className="empty-state__icon" aria-hidden="true">
          <Search size={15} />
        </span>
        <p className="empty-state__title">O que vamos explorar?</p>
        <p className="empty-state__text">
          Pesquise um objeto para localizar sua posição no Aladin e explorar os dados SPHEREx disponibilizados pelo IRSA.
        </p>
      </div>
    )
  }

  const { coords, label } = search
  const sky = search.status === 'done' ? search.result.data : null
  const dates = sky?.epochs.map((e) => e.date).sort() ?? []

  return (
    <div className="card meta">
      <p className="meta__label">{label ?? 'Coordenada pesquisada'}</p>
      <dl>
        <dt>RA</dt>
        <dd>{formatRa(coords.raDeg)}</dd>
        <dt>Dec</dt>
        <dd>{formatDec(coords.decDeg)}</dd>
        {search.status === 'loading' && (
          <>
            <dt>Status</dt>
            <dd>Buscando épocas…</dd>
          </>
        )}
        {sky && search.status === 'done' && (
          <>
            <dt>Campo</dt>
            <dd>{sky.fov}°</dd>
            <dt>Épocas</dt>
            <dd>
              {sky.epochs.length}
              {dates.length > 1 && ` · ${dates[0]} a ${dates[dates.length - 1]}`}
            </dd>
            <dt>Flags</dt>
            <dd>{sky.contaminationFlags.join(', ')}</dd>
            <dt>Origem</dt>
            <dd>
              {search.result.source === 'api' ? (
                'Back-end'
              ) : (
                <span className="badge" title="Back-end indisponível: dados de demonstração">
                  mock
                </span>
              )}
            </dd>
          </>
        )}
      </dl>
      <button type="button" className="btn btn--primary" onClick={onReopen}>
        Abrir análise
        <ArrowRight size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
