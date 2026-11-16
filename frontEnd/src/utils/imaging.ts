/**
 * Motor das ferramentas de imagem da tela de análise.
 *
 * O processador grava, ao lado de cada PNG, os números brutos da imagem (uma "camada").
 * Com eles o navegador redesenha a imagem na hora, a cada movimento de um controle:
 *  - estiramento (Asinh, ponto preto, gama): realça o que é fraco sem estourar o que é forte;
 *  - composição RGB: três camadas (faixas de cor ou datas) viram vermelho, verde e azul.
 *
 * Buscas antigas ou de demonstração não têm os números brutos: nesse caso as mesmas
 * ferramentas trabalham sobre os pixels do PNG (funciona, com menos detalhe nos extremos).
 */
import type { Epoch } from '../types'

export interface Layer {
  id: string
  kind: 'epoch' | 'band'
  /** Detector do SPHEREx, ex.: "SPHEREx-D3". */
  band?: string
  date?: string
  /** Comprimento de onda (µm) em que esta exposição viu o alvo, e a largura da banda ali. */
  wavelength?: number
  bandwidth?: number
  /** Alinhamento fino feito pelo processador (ausente na época de referência e em buscas antigas). */
  shift?: Shift | null
  width: number
  height: number
  data: Float32Array
  /** Faixa de valores "úteis" (percentis 1 e 99,5), ponto de partida do estiramento. */
  lo: number
  hi: number
}

/**
 * Resultado do alinhamento subpixel de uma camada com a primeira época: quanto ela estava
 * deslocada (em pixels), quantas estrelas serviram de referência e quanto sobrou depois de corrigir.
 */
export interface Shift {
  dx: number | null
  dy: number | null
  stars: number
  residual: number | null
}

/**
 * Em que cores este ponto do céu já foi observado. O infravermelho do SPHEREx (0,75 a 5 µm)
 * é dividido em faixas; `counts` diz quantas exposições caíram em cada uma.
 */
export interface SpectralCoverage {
  /** Bordas das faixas (µm): uma a mais que o número de faixas. */
  edges: number[]
  centers: number[]
  counts: number[]
  /** Uma linha por exposição: [comprimento de onda, largura, detector, data em MJD]. */
  samples: [number, number, string, number][]
}

export interface LayerSet {
  /** Uma camada por época, na mesma ordem recebida. */
  epochs: Layer[]
  /** Outras faixas de cor da mesma região (pode estar vazio). */
  bands: Layer[]
  /** true: números brutos do processador; false: pixels lidos do PNG. */
  raw: boolean
  /** Faixas de cor com dados para este ponto; null em buscas antigas ou de demonstração. */
  spectral: SpectralCoverage | null
}

export interface StretchParams {
  /** 0 = quase linear … 1 = Asinh bem forte. */
  stretch: number
  /** Fração dos tons (já estirados) que vira preto: corta o fundo do céu. */
  black: number
  /** Acima de 1 clareia os tons médios; abaixo, escurece. */
  gamma: number
}

export const DEFAULT_STRETCH: StretchParams = { stretch: 0.33, black: 0, gamma: 1 }

/** Faixa de comprimento de onda (µm) de cada detector do SPHEREx. */
export const BAND_RANGES: Record<string, [number, number]> = {
  D1: [0.75, 1.1],
  D2: [1.1, 1.62],
  D3: [1.62, 2.42],
  D4: [2.42, 3.82],
  D5: [3.82, 4.42],
  D6: [4.42, 5.0],
}

const detector = (band?: string) => band?.split('-').pop() ?? ''

/** 2.0312 -> "2,03". */
export const micron = (value: number, digits = 2) => value.toFixed(digits).replace('.', ',')

/**
 * "SPHEREx-D3" -> "D3 · 1,62–2,42 µm". Quando se sabe em que comprimento de onda o alvo
 * foi visto, mostra esse valor exato: "D3 · 2,03 µm".
 */
export function bandLabel(band?: string, wavelength?: number): string {
  const range = BAND_RANGES[detector(band)]
  if (!range) return band ?? 'Banda não informada'
  if (wavelength) return `${detector(band)} · ${micron(wavelength)} µm`
  const text = (n: number) => String(n).replace('.', ',')
  return `${detector(band)} · ${text(range[0])}–${text(range[1])} µm`
}

/** Comprimento de onda (µm) da camada, para ordenar do azul ao vermelho. */
export function layerWavelength(layer: Layer): number {
  if (layer.wavelength) return layer.wavelength
  const range = BAND_RANGES[detector(layer.band)]
  return range ? (range[0] + range[1]) / 2 : 0
}

/* ---------- Leitura das camadas ---------- */

/** Tabela de conversão de float de 16 bits (formato dos arquivos .bin) para número comum. */
let halfTable: Float32Array | null = null
function halfFloats(): Float32Array {
  if (halfTable) return halfTable
  const table = new Float32Array(65536)
  for (let h = 0; h < 65536; h++) {
    const sign = h & 0x8000 ? -1 : 1
    const exp = (h >> 10) & 0x1f
    const frac = h & 0x3ff
    table[h] = exp === 0 ? sign * 2 ** -14 * (frac / 1024) : exp === 31 ? 0 : sign * 2 ** (exp - 15) * (1 + frac / 1024)
  }
  halfTable = table
  return table
}

/** Percentis 1 e 99,5 dos valores, ignorando zeros (áreas sem dado). */
function usefulRange(data: Float32Array): [number, number] {
  const step = Math.max(1, Math.floor(data.length / 60000))
  const sample: number[] = []
  for (let i = 0; i < data.length; i += step) if (data[i] !== 0 && Number.isFinite(data[i])) sample.push(data[i])
  if (sample.length < 2) return [0, 1]
  sample.sort((a, b) => a - b)
  const at = (q: number) => sample[Math.min(sample.length - 1, Math.floor(q * sample.length))]
  const lo = at(0.01)
  const hi = at(0.995)
  return hi > lo ? [lo, hi] : [lo, lo + 1]
}

export function makeLayer(base: Omit<Layer, 'lo' | 'hi'>): Layer {
  const [lo, hi] = usefulRange(base.data)
  return { ...base, lo, hi }
}

interface ManifestLayer {
  file: string
  kind: 'epoch' | 'band'
  band: string | null
  date: string | null
  wavelength?: number | null
  bandwidth?: number | null
  shift?: Shift | null
  width: number
  height: number
}

const fileName = (url: string) => decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))

async function loadRawLayers(epochs: Epoch[]): Promise<LayerSet> {
  const first = epochs[0].imageUrl
  if (!/_epoca_\d+\.png$/.test(first)) throw new Error('imagem sem camadas')
  const folder = first.slice(0, first.lastIndexOf('/') + 1)
  const manifestUrl = first.replace(/_epoca_\d+\.png$/, '_camadas.json')
  const res = await fetch(manifestUrl, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`camadas: HTTP ${res.status}`)
  const manifest = (await res.json()) as { layers: ManifestLayer[]; spectral?: SpectralCoverage | null }
  const table = halfFloats()

  async function read(entry: ManifestLayer): Promise<Layer> {
    const bin = await fetch(folder + encodeURIComponent(entry.file), { cache: 'no-cache' })
    if (!bin.ok) throw new Error(`${entry.file}: HTTP ${bin.status}`)
    const halves = new Uint16Array(await bin.arrayBuffer())
    if (halves.length !== entry.width * entry.height) throw new Error(`${entry.file}: tamanho inesperado`)
    const data = new Float32Array(halves.length)
    for (let i = 0; i < halves.length; i++) data[i] = table[halves[i]]
    return makeLayer({
      id: entry.file,
      kind: entry.kind,
      band: entry.band ?? undefined,
      date: entry.date ?? undefined,
      wavelength: entry.wavelength ?? undefined,
      bandwidth: entry.bandwidth ?? undefined,
      shift: entry.shift,
      width: entry.width,
      height: entry.height,
      data,
    })
  }

  const epochLayers = await Promise.all(
    epochs.map((epoch) => {
      const wanted = fileName(epoch.imageUrl).replace(/\.png$/, '.bin')
      const entry = manifest.layers.find((l) => l.kind === 'epoch' && l.file === wanted)
      if (!entry) throw new Error(`camada ausente: ${wanted}`)
      return read(entry)
    }),
  )
  // Uma banda que falhe não impede o uso das épocas.
  const bands = (await Promise.allSettled(manifest.layers.filter((l) => l.kind === 'band').map(read)))
    .flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    .filter((l) => l.width === epochLayers[0].width && l.height === epochLayers[0].height)
  const spectral = manifest.spectral && manifest.spectral.counts?.length > 0 ? manifest.spectral : null
  return { epochs: epochLayers, bands, raw: true, spectral }
}

/** Reserva: usa os pixels do PNG/JPG como dados (0 a 255). */
async function loadPixelLayers(epochs: Epoch[]): Promise<LayerSet> {
  const layers = await Promise.all(
    epochs.map(async (epoch, i) => {
      // 'no-store': mesma razão do download (a cópia em cache veio sem permissão de leitura).
      const blob = await (await fetch(epoch.imageUrl, { cache: 'no-store' })).blob()
      const bitmap = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas indisponível')
      ctx.drawImage(bitmap, 0, 0)
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      const data = new Float32Array(canvas.width * canvas.height)
      for (let p = 0; p < data.length; p++) data[p] = 0.299 * pixels[p * 4] + 0.587 * pixels[p * 4 + 1] + 0.114 * pixels[p * 4 + 2]
      return makeLayer({ id: `epoca-${i}`, kind: 'epoch', band: epoch.band, date: epoch.date, width: canvas.width, height: canvas.height, data })
    }),
  )
  return { epochs: layers, bands: [], raw: false, spectral: null }
}

export async function loadLayers(epochs: Epoch[]): Promise<LayerSet> {
  try {
    return await loadRawLayers(epochs)
  } catch (err) {
    console.info('[ferramentas] sem dados brutos para esta busca; usando os pixels da imagem.', err)
    return loadPixelLayers(epochs)
  }
}

/* ---------- Remoção de gradiente de fundo ---------- */

const GRADIENT_BOX = 48

/** Mediana dos valores, descartando os muito fora da curva (estrelas). */
function clippedMedian(values: number[]): number {
  let kept = values
  let median = 0
  for (let round = 0; round < 3; round++) {
    kept.sort((a, b) => a - b)
    median = kept[kept.length >> 1]
    const center = median
    const spread = 1.4826 * kept.map((v) => Math.abs(v - center)).sort((a, b) => a - b)[kept.length >> 1]
    if (spread === 0) break
    const next = kept.filter((v) => Math.abs(v - center) <= 3 * spread)
    if (next.length === kept.length || next.length < 8) break
    kept = next
  }
  return median
}

/**
 * Tira da imagem o brilho difuso que deixa um lado mais claro que o outro (resto de luz
 * zodiacal, luz espalhada). Divide a imagem em quadrados de ~48 px, toma o brilho típico do céu
 * em cada um (mediana sem as estrelas), suaviza esse mapa e o subtrai, interpolando entre os
 * quadrados. Pixels sem dado (zero) continuam zero.
 */
export function removeGradient(layer: Layer): Layer {
  const { width, height, data } = layer
  const nx = Math.max(1, Math.round(width / GRADIENT_BOX))
  const ny = Math.max(1, Math.round(height / GRADIENT_BOX))
  const bw = width / nx
  const bh = height / ny
  const mesh = new Float64Array(nx * ny).fill(NaN)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const values: number[] = []
      const x1 = Math.min(width, Math.round((i + 1) * bw))
      const y1 = Math.min(height, Math.round((j + 1) * bh))
      for (let y = Math.round(j * bh); y < y1; y++) {
        for (let x = Math.round(i * bw); x < x1; x++) {
          const v = data[y * width + x]
          if (v !== 0 && Number.isFinite(v)) values.push(v)
        }
      }
      if (values.length >= 0.2 * bw * bh) mesh[j * nx + i] = clippedMedian(values)
    }
  }
  // Filtro de mediana 3 x 3 no mapa (também preenche quadrados sem dado com os vizinhos).
  const smooth = new Float64Array(nx * ny)
  const all = [...mesh].filter(Number.isFinite).sort((a, b) => a - b)
  const overall = all.length ? all[all.length >> 1] : 0
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const near: number[] = []
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (i + di < 0 || i + di >= nx || j + dj < 0 || j + dj >= ny) continue
          const v = mesh[(j + dj) * nx + i + di]
          if (Number.isFinite(v)) near.push(v)
        }
      }
      near.sort((a, b) => a - b)
      smooth[j * nx + i] = near.length ? near[near.length >> 1] : overall
    }
  }
  const out = new Float32Array(data.length)
  for (let y = 0; y < height; y++) {
    const fy = Math.min(ny - 1, Math.max(0, (y + 0.5) / bh - 0.5))
    const j0 = Math.floor(fy)
    const j1 = Math.min(ny - 1, j0 + 1)
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x]
      if (v === 0) continue
      const fx = Math.min(nx - 1, Math.max(0, (x + 0.5) / bw - 0.5))
      const i0 = Math.floor(fx)
      const i1 = Math.min(nx - 1, i0 + 1)
      const top = smooth[j0 * nx + i0] + (fx - i0) * (smooth[j0 * nx + i1] - smooth[j0 * nx + i0])
      const bottom = smooth[j1 * nx + i0] + (fx - i0) * (smooth[j1 * nx + i1] - smooth[j1 * nx + i0])
      // "|| 1e-12": um pixel com dado nunca vira exatamente zero (zero quer dizer "sem dado")
      out[y * width + x] = v - (top + (fy - j0) * (bottom - top)) || 1e-12
    }
  }
  return makeLayer({ ...layer, data: out })
}

/* ---------- Espectro do ponto, cubo espectral e redshift ---------- */

export interface CubeInfo {
  file: string
  /** Lado da imagem de cada fatia, em pixels. */
  size: number
  pixelArcsec: number
  unit: string
  /** Fator aplicado ao erro por causa da reamostragem. */
  noiseFactor: number
  slices: { coverage: number; exposures: number; noise: number | null }[]
}

export interface RedshiftFit {
  template: string
  name: string
  z: number
  chi2: number
  curve: (number | null)[]
}

export interface SpectrumData {
  status: 'done'
  unit: string
  apertureRadiusPx: number
  exposures: number
  failed: number
  saturated: number
  /** Uma linha por exposição: [comprimento de onda, largura, brilho, erro, detector, data (MJD), avisos]. */
  points: [number, number, number, number, string, number, string[]][]
  /** Uma linha por faixa de cor: [centro, brilho, erro, nº de medidas, só havia medidas com aviso]. */
  bins: [number, number, number, number, boolean][]
  diagnostics: { id: string; title: string; text: string; ratio?: number }[]
  redshift: { zMin: number; zMax: number; steps: number; source: string; fits: RedshiftFit[] } | null
  cube: CubeInfo | null
}

export type SpectrumState =
  | { status: 'missing' }
  | { status: 'failed' }
  | { status: 'running'; done: number; total: number }
  | SpectrumData

const EPOCH_FILE = /_epoca_\d+\.png$/

/** Endereço do arquivo do espectro, ao lado das imagens da busca; null se a busca não tem um. */
export function spectrumUrl(epochs: Epoch[]): string | null {
  const first = epochs[0]?.imageUrl ?? ''
  return EPOCH_FILE.test(first) ? first.replace(EPOCH_FILE, '_espectro.json') : null
}

/** Lê o cubo espectral: uma imagem pequena por faixa de cor, todas num arquivo só. */
export async function loadCube(spectrumAddress: string, cube: CubeInfo): Promise<Float32Array> {
  const folder = spectrumAddress.slice(0, spectrumAddress.lastIndexOf('/') + 1)
  const res = await fetch(folder + encodeURIComponent(cube.file), { cache: 'no-cache' })
  if (!res.ok) throw new Error(`cubo: HTTP ${res.status}`)
  const halves = new Uint16Array(await res.arrayBuffer())
  if (halves.length !== cube.slices.length * cube.size * cube.size) throw new Error('cubo: tamanho inesperado')
  const table = halfFloats()
  const data = new Float32Array(halves.length)
  for (let i = 0; i < halves.length; i++) data[i] = table[halves[i]]
  return data
}

/** Uma fatia do cubo como camada, pronta para desenhar. */
export function cubeSlice(data: Float32Array, cube: CubeInfo, index: number): Layer {
  const area = cube.size * cube.size
  return makeLayer({ id: `cubo-${index}`, kind: 'band', width: cube.size, height: cube.size, data: data.subarray(index * area, (index + 1) * area) })
}

/* ---------- Desenho ---------- */

// 65536 níveis: com Asinh forte o começo da curva é muito íngreme, e uma tabela pequena
// (testada com 4096) criava degraus de até 5 tons nas partes escuras.
const LUT_SIZE = 65536

/**
 * Curva de transferência: para cada nível de entrada (0 a 1), o tom de saída (0 a 255).
 * Calculada uma vez por desenho; depois cada pixel é só uma consulta à tabela.
 */
function buildLut({ stretch, black, gamma }: StretchParams): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(LUT_SIZE)
  const a = 10 ** (-3 * stretch) // 1 (quase linear) … 0,001 (muito forte)
  const norm = Math.asinh(1 / a)
  for (let i = 0; i < LUT_SIZE; i++) {
    const stretched = Math.asinh(i / (LUT_SIZE - 1) / a) / norm
    // O ponto preto corta depois do estiramento: assim o controle age sobre os tons que se
    // veem na tela (antes dele, quase todo o céu cabe nos primeiros 2% e sumiria de uma vez).
    const cut = Math.max(0, (stretched - black) / (1 - black))
    lut[i] = 255 * cut ** (1 / gamma)
  }
  return lut
}

function fillChannel(out: Uint8ClampedArray, offset: number, layer: Layer, lut: Uint8ClampedArray) {
  const { data, lo, hi } = layer
  const scale = (LUT_SIZE - 1) / (hi - lo)
  for (let i = 0; i < data.length; i++) {
    const level = (data[i] - lo) * scale
    out[i * 4 + offset] = lut[level <= 0 ? 0 : level >= LUT_SIZE - 1 ? LUT_SIZE - 1 : level | 0]
  }
}

/** Imagem em tons de cinza de uma camada. */
export function renderGray(layer: Layer, params: StretchParams): ImageData {
  const image = new ImageData(layer.width, layer.height)
  const lut = buildLut(params)
  for (const channel of [0, 1, 2]) fillChannel(image.data, channel, layer, lut)
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255
  return image
}

/** Imagem colorida: cada camada ocupa um canal (vermelho, verde, azul). */
export function renderRgb(r: Layer, g: Layer, b: Layer, params: StretchParams): ImageData {
  const image = new ImageData(r.width, r.height)
  const lut = buildLut(params)
  ;[r, g, b].forEach((layer, channel) => fillChannel(image.data, channel, layer, lut))
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255
  return image
}

/** Transforma a imagem desenhada num endereço que um <img> consegue exibir. */
export function toObjectUrl(image: ImageData): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  canvas.getContext('2d')?.putImageData(image, 0, 0)
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error('falha ao gerar a imagem'))), 'image/png'),
  )
}
