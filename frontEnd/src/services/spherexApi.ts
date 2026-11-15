/**
 * Camada única de acesso ao back-end SPHEREx (adapter com fallback automático).
 *
 * Cada função tenta a rota real primeiro. Se o container estiver fora do ar,
 * a rota não existir, demorar demais ou devolver um formato inesperado,
 * o erro é capturado e a função devolve dados mockados no mesmo formato.
 * O campo `source` diz ao chamador de onde o dado veio ('api' ou 'mock').
 */
import type { ApiResult, Coords, Epoch, SkyData, Target } from '../types'
import { formatDec, formatRa, parseCoords } from '../utils/coords'
import { mockEpochImage, mockSubtractedImage } from './mockImages'

const BASE_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:8080').replace(/\/$/, '')
const TIMEOUT_MS = 6000
/** O back-end espera o processador Python por até 30 s. */
const SKY_TIMEOUT_MS = 35000
export const DEFAULT_FOV = 0.5

async function request<T>(path: string, timeoutMs = TIMEOUT_MS): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${path}`)
  return (await res.json()) as T
}

function warnFallback(route: string, err: unknown) {
  console.warn(`[spherexApi] ${route} indisponível, usando dados mockados.`, err)
}

/* ---------- GET /api/targets ---------- */

interface TargetDto {
  name: string
  description: string
  ra: string
  dec: string
}

function toTarget(dto: TargetDto): Target | null {
  const coords = parseCoords(`${dto.ra} ${dto.dec}`)
  return coords ? { name: dto.name, description: dto.description.trim(), coords, raText: dto.ra, decText: dto.dec } : null
}

const MOCK_TARGETS: Target[] = (
  [
    { name: 'WISE 0855', description: 'Anã marrom de movimento rápido', ra: '08h55m10.831s', dec: '-7d14m42.53s' },
    { name: "Barnard's Star", description: 'Estrela com maior movimento próprio', ra: '17h57m48.50s', dec: '+04d41m36.1s' },
    { name: 'Epsilon Indi B', description: 'Par de anãs marrons em órbita', ra: '22h04m10.52s', dec: '-56d46m57.7s' },
    { name: 'RW Aurigae', description: 'Estrela variável jovem', ra: '05h07m49.54s', dec: '+30d24m05.1s' },
    { name: 'R Draconis', description: 'Estrela variável pulsante (Mira)', ra: '16h32m40.23s', dec: '+66d45m17.9s' },
    { name: 'Polo Norte da Eclíptica', description: 'Campo profundo do SPHEREx (NEP)', ra: '18h00m00.0s', dec: '+66d33m38.6s' },
    { name: 'Polo Sul da Eclíptica', description: 'Campo profundo do SPHEREx (SEP)', ra: '06h00m00.0s', dec: '-66d33m38.6s' },
  ] satisfies TargetDto[]
)
  .map(toTarget)
  .filter((t): t is Target => t !== null)

export async function getTargets(): Promise<ApiResult<Target[]>> {
  try {
    const dtos = await request<TargetDto[]>('/api/targets')
    const targets = dtos.map(toTarget).filter((t): t is Target => t !== null)
    if (targets.length === 0) throw new Error('Lista de alvos vazia ou em formato inesperado')
    return { data: targets, source: 'api' }
  } catch (err) {
    warnFallback('GET /api/targets', err)
    return { data: MOCK_TARGETS, source: 'mock' }
  }
}

/* ---------- GET /api/sky ---------- */

interface SkyDto {
  ra: string
  dec: string
  fov: number
  source?: string | null
  band?: string | null
  epochs: { date: string; imageUrl: string }[] | null
  subtractedImageUrl: string | null
  contaminationFlags: string[] | null
}


/** Datas fictícias, espaçadas ~6 meses como as varreduras de céu inteiro do SPHEREx. */
const MOCK_DATES = ['2025-05-12', '2025-11-09', '2026-05-10', '2026-11-07']

/** Épocas sintéticas geradas localmente (ver mockImages.ts): funcionam sem rede. */
function mockSky(coords: Coords, fov: number): SkyData {
  const epochs: Epoch[] = MOCK_DATES.map((date, i) => ({
    date,
    imageUrl: mockEpochImage(coords, i),
    band: 'Simulação (dados de demonstração)',
  }))
  return {
    coords,
    fov,
    epochs,
    subtractedImageUrl: mockSubtractedImage(coords, 0, MOCK_DATES.length - 1),
    contaminationFlags: ['NONE'],
  }
}

/** Mantém só o caminho (/images/x.png) e usa o endereço da API que o front conhece. */
function toImageUrl(url: string): string {
  try {
    return `${BASE_URL}${new URL(url, BASE_URL).pathname}`
  } catch {
    return url
  }
}

/**
 * `raw` é o texto de RA/Dec exatamente como o back-end o publicou (alvos de /api/targets):
 * ele usa esse texto como chave de cache, então reformatar faria perder o cache.
 */
export async function getSky(
  coords: Coords,
  fov = DEFAULT_FOV,
  raw?: { ra: string; dec: string },
): Promise<ApiResult<SkyData>> {
  try {
    const query = new URLSearchParams({
      ra: raw?.ra ?? formatRa(coords.raDeg),
      dec: raw?.dec ?? formatDec(coords.decDeg),
      fov: String(fov),
    })
    const dto = await request<SkyDto>(`/api/sky?${query}`, SKY_TIMEOUT_MS)
    const band = dto.band ?? undefined
    const epochs = (dto.epochs ?? [])
      .filter((e) => e.date && e.imageUrl)
      .map((e) => ({ date: e.date, imageUrl: toImageUrl(e.imageUrl), band }))
    if (epochs.length === 0) throw new Error('Resposta sem épocas')
    return {
      data: {
        coords,
        fov: dto.fov ?? fov,
        source: dto.source ?? undefined,
        band,
        epochs,
        subtractedImageUrl: dto.subtractedImageUrl ? toImageUrl(dto.subtractedImageUrl) : null,
        contaminationFlags: dto.contaminationFlags ?? ['NONE'],
      },
      source: 'api',
    }
  } catch (err) {
    warnFallback('GET /api/sky', err)
    return { data: mockSky(coords, fov), source: 'mock' }
  }
}

export const spherexApi = { getTargets, getSky }
