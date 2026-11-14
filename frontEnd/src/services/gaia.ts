/**
 * Catálogo Gaia DR3 (ESA): estrelas da região visível do mapa.
 *
 * Caminho principal: consulta em cone ao arquivo oficial do Gaia (TAP/ADQL),
 * passando pelo proxy /gaia-tap do Vite (ver vite.config.ts).
 * Alternativa: o catálogo progressivo do CDS, que o Aladin lê sozinho
 * (GAIA_HIPS_CATALOG), usado quando o proxy não existe.
 */
import type { Coords } from '../types'

const TAP_SYNC_URL = '/gaia-tap/sync'
const TIMEOUT_MS = 25000

/** Máximo de estrelas por consulta. */
export const GAIA_MAX_STARS = 600
/** Acima deste campo de visão (graus) a camada não carrega: seriam estrelas demais. */
export const GAIA_MAX_FOV = 2.5
/** Catálogo progressivo do Gaia DR3 no CDS (VizieR I/355). */
export const GAIA_HIPS_CATALOG = 'https://hipscat.cds.unistra.fr/HiPSCatService/I/355/gaiadr3'

export interface GaiaStar {
  /** Identificador como texto: tem 19 dígitos e não cabe num number. */
  sourceId: string
  raDeg: number
  decDeg: number
  gMag: number | null
  parallaxMas: number | null
  pmRaMasYr: number | null
  pmDecMasYr: number | null
}

export interface GaiaQuery {
  radiusDeg: number
  /** Só estrelas mais brilhantes que este G; null = sem corte. */
  magLimit: number | null
}

/**
 * Define o cone e o corte de brilho a partir do campo de visão.
 * Quanto mais afastado o zoom, mais brilhantes precisam ser as estrelas,
 * para a consulta voltar rápido mesmo em regiões densas da Via Láctea.
 */
export function planGaiaQuery(fovDeg: number): GaiaQuery | null {
  if (fovDeg > GAIA_MAX_FOV) return null
  const radiusDeg = fovDeg * 0.6 // cobre até os cantos da tela
  const magLimit = radiusDeg > 0.6 ? 12.5 : radiusDeg > 0.25 ? 14.5 : radiusDeg > 0.08 ? 16.5 : null
  return { radiusDeg, magLimit }
}

const num = (text: string | undefined) => (text === undefined || text.trim() === '' ? null : Number(text))

export async function fetchGaiaStars(center: Coords, query: GaiaQuery, signal?: AbortSignal): Promise<GaiaStar[]> {
  const adql = [
    `SELECT TOP ${GAIA_MAX_STARS} source_id, ra, dec, phot_g_mean_mag, parallax, pmra, pmdec`,
    'FROM gaiadr3.gaia_source',
    `WHERE 1=CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${center.raDeg.toFixed(6)}, ${center.decDeg.toFixed(6)}, ${query.radiusDeg.toFixed(5)}))`,
    query.magLimit === null ? '' : `AND phot_g_mean_mag < ${query.magLimit}`,
  ].join(' ')

  const params = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: adql })
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const res = await fetch(`${TAP_SYNC_URL}?${params}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  if (!res.ok) throw new Error(`Gaia TAP respondeu HTTP ${res.status}`)

  const [header, ...lines] = (await res.text()).trim().split(/\r?\n/)
  // Sem o proxy, o servidor devolve o index.html do app em vez do CSV.
  if (!header?.startsWith('source_id')) throw new Error('Resposta do Gaia TAP em formato inesperado')

  const stars: GaiaStar[] = []
  for (const line of lines) {
    const [sourceId, ra, dec, g, parallax, pmra, pmdec] = line.split(',')
    const raDeg = Number(ra)
    const decDeg = Number(dec)
    if (!sourceId || !Number.isFinite(raDeg) || !Number.isFinite(decDeg)) continue
    stars.push({ sourceId, raDeg, decDeg, gMag: num(g), parallaxMas: num(parallax), pmRaMasYr: num(pmra), pmDecMasYr: num(pmdec) })
  }
  return stars
}

const fixed = (value: number | null, digits: number) => (value === null ? 'sem medida' : value.toFixed(digits))

/** Tabela mostrada no balão do Aladin ao clicar numa estrela. */
export function gaiaPopupData(star: GaiaStar): Record<string, string> {
  const total = star.pmRaMasYr !== null && star.pmDecMasYr !== null ? Math.hypot(star.pmRaMasYr, star.pmDecMasYr) : null
  return {
    'Gaia DR3': star.sourceId,
    'Magnitude G': fixed(star.gMag, 2),
    'Paralaxe (mas)': fixed(star.parallaxMas, 3),
    'Mov. próprio RA (mas/ano)': fixed(star.pmRaMasYr, 2),
    'Mov. próprio Dec (mas/ano)': fixed(star.pmDecMasYr, 2),
    'Mov. próprio total (mas/ano)': fixed(total, 2),
  }
}
