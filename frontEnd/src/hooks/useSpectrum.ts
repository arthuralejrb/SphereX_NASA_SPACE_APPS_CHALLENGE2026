import { useEffect, useState } from 'react'
import type { Epoch } from '../types'
import { spectrumUrl } from '../utils/imaging'
import type { SpectrumState } from '../utils/imaging'

const POLL_MS = 2500
/** Sem avanço por este tempo, considera que a medição parou (ex.: o processador reiniciou). */
const STALL_MS = 120_000

/**
 * Espectro do ponto pesquisado. O processador o mede em segundo plano, depois de entregar as
 * imagens, e vai gravando o andamento num arquivo ao lado delas; aqui esse arquivo é consultado
 * de tempos em tempos até a medição terminar.
 */
export function useSpectrum(epochs: Epoch[]): { state: SpectrumState; url: string | null } {
  const url = spectrumUrl(epochs)
  const [state, setState] = useState<SpectrumState>(url ? { status: 'running', done: 0, total: 0 } : { status: 'missing' })

  useEffect(() => {
    if (!url) return
    let cancelled = false
    let timer = 0
    let lastDone = -1
    let lastChange = Date.now()

    async function check() {
      try {
        const res = await fetch(url as string, { cache: 'no-store' })
        if (cancelled) return
        if (res.status === 404) return setState({ status: 'missing' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const next = (await res.json()) as SpectrumState
        if (cancelled) return
        if (next.status === 'running') {
          if (next.done !== lastDone) {
            lastDone = next.done
            lastChange = Date.now()
          }
          if (Date.now() - lastChange > STALL_MS) return setState({ status: 'failed' })
          timer = window.setTimeout(check, POLL_MS)
        }
        setState(next)
      } catch (err) {
        console.warn('[espectro] não foi possível ler o espectro.', err)
        if (!cancelled) setState({ status: 'failed' })
      }
    }
    check()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [url])

  return { state, url }
}
