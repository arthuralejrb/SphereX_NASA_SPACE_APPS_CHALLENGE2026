import { RESOLVE_TIMEOUT_MS } from '../config'
import type { Coords, Target } from '../types'

/**
 * Busca por nome, em duas camadas:
 *  1. a nossa lista de alvos (acesso rápido): sem rede, e com a coordenada exata que o
 *     projeto usa. É o que faz "WISE 0855" funcionar, pois os catálogos só o conhecem
 *     como "WISE J085510.83-071442.5", e numa posição antiga (a estrela anda rápido);
 *  2. o Sesame do CDS, que conhece praticamente qualquer objeto catalogado (M 42, Vega...).
 */

/** Servidores do Sesame. São espelhos com os mesmos dados: se um cair, o outro responde. */
const SESAME_SERVERS = [
  'https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV?',
  'https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oI/SNV?',
]

/** "Barnard's Star" -> "barnardsstar": ignora maiúsculas, acentos, espaços e pontuação. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
}

/** Procura o texto na lista de alvos conhecidos: nome igual, ou o único que contém o texto. */
export function findKnownTarget(text: string, targets: Target[]): Target | null {
  const query = normalize(text)
  if (!query) return null
  const exact = targets.find((t) => normalize(t.name) === query)
  if (exact) return exact
  if (query.length < 4) return null // "m 4" não deve virar "M 42"
  const partial = targets.filter((t) => normalize(t.name).includes(query))
  return partial.length === 1 ? partial[0] : null
}

/**
 * Alvo conhecido que fica (a menos de 1") na coordenada digitada. Assim, digitar a posição
 * de um dos nossos alvos abre exatamente a mesma busca que digitar o nome dele.
 */
export function findTargetAt(coords: Coords, targets: Target[]): Target | null {
  const limitDeg = 1 / 3600
  const shrink = Math.cos((coords.decDeg * Math.PI) / 180) // 1° de RA encolhe perto dos polos
  return (
    targets.find((t) => {
      const dRa = Math.abs(t.coords.raDeg - coords.raDeg)
      return Math.hypot(Math.min(dRa, 360 - dRa) * shrink, t.coords.decDeg - coords.decDeg) < limitDeg
    }) ?? null
  )
}

class NotFoundError extends Error {}

async function askSesame(server: string, name: string): Promise<Coords> {
  const res = await fetch(server + encodeURIComponent(name), { signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  // Linha da posição: "%J 279.23473479 +38.78368896 = 18 36 56.336 +38 47 01.28"
  const match = /^%J\s+([\d.]+)\s+([+-]?[\d.]+)/m.exec(text)
  if (match) return { raDeg: Number(match[1]), decDeg: Number(match[2]) }
  if (/Nothing found/i.test(text)) throw new NotFoundError(name)
  throw new Error('resposta inesperada do Sesame')
}

/**
 * Converte um nome de objeto em coordenadas pelo Sesame. Pergunta a todos os espelhos
 * ao mesmo tempo e fica com o primeiro que responder.
 * Rejeita com 'not-found' (nome desconhecido) ou 'unavailable' (nenhum servidor respondeu).
 */
export async function resolveName(name: string): Promise<Coords> {
  try {
    return await Promise.any(SESAME_SERVERS.map((server) => askSesame(server, name)))
  } catch (err) {
    const errors = err instanceof AggregateError ? err.errors : [err]
    throw new Error(errors.some((e) => e instanceof NotFoundError) ? 'not-found' : 'unavailable')
  }
}
