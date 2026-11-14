import { useCallback, useState } from 'react'
import type { Coords, HistoryEntry } from '../types'
import { sameCoords } from '../utils/coords'

const STORAGE_KEY = 'spherex.history.v1'
const MAX_ENTRIES = 30

function load(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is HistoryEntry =>
        typeof e?.coords?.raDeg === 'number' && typeof e?.coords?.decDeg === 'number' && typeof e?.at === 'number',
    )
  } catch {
    return []
  }
}

function save(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // localStorage bloqueado ou cheio: o histórico segue só em memória.
  }
}

/** Histórico de coordenadas buscadas, persistido em localStorage (mais recente primeiro). */
export function useSearchHistory() {
  const [history, setHistory] = useState<HistoryEntry[]>(load)

  const add = useCallback((coords: Coords, label?: string) => {
    setHistory((prev) => {
      const previous = prev.find((e) => sameCoords(e.coords, coords))
      const entry: HistoryEntry = { coords, label: label ?? previous?.label, at: Date.now() }
      const next = [entry, ...prev.filter((e) => e !== previous)].slice(0, MAX_ENTRIES)
      save(next)
      return next
    })
  }, [])

  const remove = useCallback((entry: HistoryEntry) => {
    setHistory((prev) => {
      const next = prev.filter((e) => e.at !== entry.at)
      save(next)
      return next
    })
  }, [])

  const clear = useCallback(() => {
    save([])
    setHistory([])
  }, [])

  return { history, add, remove, clear }
}
