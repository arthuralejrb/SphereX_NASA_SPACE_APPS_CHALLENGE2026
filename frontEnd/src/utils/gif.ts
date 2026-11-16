/**
 * Monta um GIF animado (em tons de cinza) a partir de imagens, direto no navegador.
 *
 * Um GIF é: um cabeçalho, uma paleta de até 256 cores e, para cada quadro, os pixels como
 * índices dessa paleta, comprimidos com LZW (um dicionário de sequências que vai sendo montado
 * enquanto se lê a imagem). Aqui a paleta são os 256 tons de cinza, e o índice é o próprio tom.
 */

export interface GifFrame {
  /** Endereço da imagem do quadro. */
  url: string
  /** Texto escrito no canto do quadro (a data da captura). */
  label: string
}

/** Compressão LZW do GIF: devolve os bytes já em códigos de tamanho variável. */
function lzw(indices: Uint8Array): Uint8Array {
  const MIN = 8
  const CLEAR = 1 << MIN
  const END = CLEAR + 1
  const out: number[] = []
  let buffer = 0
  let bits = 0
  let size = MIN + 1
  let next = END + 1
  const table = new Map<number, number>()
  const emit = (code: number) => {
    buffer |= code << bits
    bits += size
    while (bits >= 8) {
      out.push(buffer & 0xff)
      buffer >>>= 8
      bits -= 8
    }
  }
  emit(CLEAR)
  let prefix = indices[0]
  for (let i = 1; i < indices.length; i++) {
    const value = indices[i]
    const key = (prefix << 8) | value
    const known = table.get(key)
    if (known !== undefined) {
      prefix = known
      continue
    }
    emit(prefix)
    if (next === 4096) {
      // dicionário cheio: avisa o leitor e recomeça
      emit(CLEAR)
      table.clear()
      next = END + 1
      size = MIN + 1
    } else {
      if (next >= 1 << size) size++
      table.set(key, next++)
    }
    prefix = value
  }
  emit(prefix)
  emit(END)
  if (bits > 0) out.push(buffer & 0xff)
  return Uint8Array.from(out)
}

/** Carrega a imagem, desenha-a no tamanho pedido com a legenda e devolve os tons de cinza. */
async function grayFrame(frame: GifFrame, width: number, height: number): Promise<Uint8Array> {
  // 'no-store': mesma razão do download (a cópia em cache veio sem permissão de leitura).
  const blob = await (await fetch(frame.url, { cache: 'no-store' })).blob()
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('canvas indisponível')
  ctx.drawImage(bitmap, 0, 0, width, height)
  const font = Math.max(11, Math.round(width / 26))
  ctx.font = `600 ${font}px system-ui, sans-serif`
  const textWidth = ctx.measureText(frame.label).width
  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)'
  ctx.fillRect(6, height - font - 16, textWidth + 14, font + 10)
  ctx.fillStyle = '#fff'
  ctx.fillText(frame.label, 13, height - 13)
  const pixels = ctx.getImageData(0, 0, width, height).data
  const gray = new Uint8Array(width * height)
  for (let p = 0; p < gray.length; p++) gray[p] = Math.round(0.299 * pixels[p * 4] + 0.587 * pixels[p * 4 + 1] + 0.114 * pixels[p * 4 + 2])
  return gray
}

/** GIF que repete para sempre, com `delayMs` entre os quadros. O tamanho é o da primeira imagem. */
export async function buildGif(frames: GifFrame[], delayMs: number): Promise<Blob> {
  const first = await createImageBitmap(await (await fetch(frames[0].url, { cache: 'no-store' })).blob())
  const width = first.width
  const height = first.height
  const word = (n: number) => [n & 0xff, (n >> 8) & 0xff]
  const parts: Uint8Array[] = []
  const push = (...bytes: number[]) => parts.push(Uint8Array.from(bytes))

  push(...[...'GIF89a'].map((c) => c.charCodeAt(0)), ...word(width), ...word(height), 0xf7, 0, 0)
  const palette = new Uint8Array(768)
  for (let i = 0; i < 256; i++) palette.fill(i, i * 3, i * 3 + 3)
  parts.push(palette)
  // repetir para sempre
  push(0x21, 0xff, 0x0b, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0)

  for (const frame of frames) {
    const data = lzw(await grayFrame(frame, width, height))
    push(0x21, 0xf9, 4, 0, ...word(Math.round(delayMs / 10)), 0, 0) // tempo do quadro (centésimos de segundo)
    push(0x2c, 0, 0, 0, 0, ...word(width), ...word(height), 0, 8)
    for (let i = 0; i < data.length; i += 255) {
      const block = data.subarray(i, i + 255)
      push(block.length)
      parts.push(block)
    }
    push(0)
  }
  push(0x3b)
  return new Blob(parts as BlobPart[], { type: 'image/gif' })
}
