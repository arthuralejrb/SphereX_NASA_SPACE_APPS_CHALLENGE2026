import { zipSync } from 'fflate'

/** Uma imagem a baixar: de onde vem e o nome do arquivo (sem extensão). */
export interface DownloadItem {
  url: string
  name: string
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** "Barnard's Star" -> "barnard-s-star": seguro para nome de arquivo em qualquer sistema. */
export function slug(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9+.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'imagem'
  )
}

/**
 * Busca a imagem como dados. É preciso porque o atributo `download` do link
 * não funciona para arquivos de outro endereço (o back-end fica em outra porta).
 */
async function fetchImage(item: DownloadItem): Promise<{ filename: string; blob: Blob }> {
  // 'no-store': a cópia que o navegador guardou ao exibir a imagem veio sem a permissão
  // de leitura entre endereços (CORS), e reaproveitá-la faria o download falhar.
  const res = await fetch(item.url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar ${item.name}`)
  const blob = await res.blob()
  return { filename: `${item.name}.${EXTENSIONS[blob.type] ?? 'png'}`, blob }
}

export function saveBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Dá tempo de o navegador iniciar o download antes de liberar a memória.
  setTimeout(() => URL.revokeObjectURL(href), 10_000)
}

/** Baixa uma imagem. */
export async function downloadImage(item: DownloadItem): Promise<void> {
  const { filename, blob } = await fetchImage(item)
  saveBlob(blob, filename)
}

/** Baixa várias imagens de uma vez, dentro de um único .zip. */
export async function downloadImagesAsZip(items: DownloadItem[], zipName: string): Promise<void> {
  const files = await Promise.all(items.map(fetchImage))
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {}
  for (const { filename, blob } of files) {
    // PNG e JPEG já são comprimidos: nível 0 só empacota, sem gastar tempo.
    entries[filename] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }]
  }
  const zipped = zipSync(entries)
  saveBlob(new Blob([zipped.slice().buffer], { type: 'application/zip' }), `${zipName}.zip`)
}
