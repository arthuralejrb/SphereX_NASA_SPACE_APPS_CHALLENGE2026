/** Posição no céu em graus decimais (ICRS). */
export interface Coords {
  raDeg: number
  decDeg: number
}

/** Preparado para o Nível 3 (ainda não implementado). */
export type ViewMode = 'level1' | 'level2' | 'level3'

/** De onde veio o dado: back-end real ou fallback local. */
export type DataSource = 'api' | 'mock'

export interface ApiResult<T> {
  data: T
  source: DataSource
}

export interface Target {
  name: string
  description: string
  coords: Coords
  /** Texto original vindo do back-end; é a chave do cache dele. */
  raText?: string
  decText?: string
}

export interface Epoch {
  date: string
  imageUrl: string
  /** Banda/origem da imagem. O back-end ainda não envia; só o mock preenche. */
  band?: string
}

export interface SkyData {
  coords: Coords
  fov: number
  epochs: Epoch[]
  subtractedImageUrl: string | null
  contaminationFlags: string[]
}

export interface HistoryEntry {
  coords: Coords
  label?: string
  /** Timestamp (ms) da última busca. */
  at: number
}

export type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; coords: Coords; label?: string }
  | { status: 'done'; coords: Coords; label?: string; result: ApiResult<SkyData> }
