import { useEffect, useMemo, useRef, useState } from 'react'
import type { Epoch } from '../types'
import { DEFAULT_STRETCH, layerWavelength, loadLayers, removeGradient, renderGray, renderRgb, toObjectUrl } from '../utils/imaging'
import type { Layer, LayerSet, StretchParams } from '../utils/imaging'

/** Camada escolhida para cada cor (id da camada). */
export interface RgbChoice {
  r: string
  g: string
  b: string
}

/**
 * Escolha inicial das cores. Com outras faixas de cor disponíveis: a de maior comprimento de
 * onda vai para o vermelho e a de menor para o azul (como o olho faria, se enxergasse
 * infravermelho). Sem elas: as datas viram cores, e o que mudou no tempo aparece colorido.
 */
function defaultChoice(set: LayerSet): RgbChoice {
  const byColor = new Map<string, Layer>()
  for (const layer of [set.epochs[0], ...set.bands]) if (layer.band && !byColor.has(layer.band)) byColor.set(layer.band, layer)
  const spectral = [...byColor.values()].sort((a, b) => layerWavelength(a) - layerWavelength(b))
  const list = set.bands.length > 0 && spectral.length >= 2 ? spectral : set.epochs
  const last = list.length - 1
  return { r: list[last].id, g: list[Math.floor(last / 2)].id, b: list[0].id }
}

/**
 * Estado e desenho das ferramentas de imagem. Devolve endereços de imagens já ajustadas,
 * que a tela usa no lugar dos PNGs originais (zoom e comparador continuam funcionando).
 */
/** Ajustes de um painel, para copiá-los para outro (ex.: ao abrir a comparação). */
export interface ToolsSnapshot {
  adjusting: boolean
  flat: boolean
  params: StretchParams
  choice: RgbChoice | null
}

// As camadas de uma busca são lidas uma vez só, mesmo com dois painéis (comparação) a usá-las.
const layerCache = new Map<string, Promise<LayerSet>>()
function sharedLayers(epochs: Epoch[]): Promise<LayerSet> {
  const key = epochs.map((e) => e.imageUrl).join('|')
  let pending = layerCache.get(key)
  if (!pending) {
    layerCache.clear() // só a busca atual fica guardada
    pending = loadLayers(epochs)
    layerCache.set(key, pending)
    pending.catch(() => layerCache.delete(key))
  }
  return pending
}

/** `enabled` falso: o painel não está na tela, então nada é desenhado. */
export function useImageTools(epochs: Epoch[], showRgb: boolean, enabled = true) {
  const [layers, setLayers] = useState<LayerSet | null>(null)
  const [failed, setFailed] = useState(false)
  /** Liga o estiramento nas imagens das épocas. */
  const [adjusting, setAdjusting] = useState(false)
  /** Tira o brilho difuso de fundo (gradiente) antes de desenhar. */
  const [flat, setFlat] = useState(false)
  const [params, setParams] = useState<StretchParams>(DEFAULT_STRETCH)
  const [choice, setChoice] = useState<RgbChoice | null>(null)
  const [epochUrls, setEpochUrls] = useState<string[] | null>(null)
  const [rgbUrl, setRgbUrl] = useState<string | null>(null)
  const stale = useRef<string[]>([])

  useEffect(() => {
    let cancelled = false
    sharedLayers(epochs)
      .then((set) => {
        if (cancelled) return
        setLayers(set)
        setChoice(defaultChoice(set))
      })
      .catch((err) => {
        console.warn('[ferramentas] não foi possível preparar as imagens.', err)
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [epochs])

  // Com a remoção de gradiente ligada, tudo é desenhado a partir das camadas já corrigidas.
  const used = useMemo(
    () => (layers && flat ? { ...layers, epochs: layers.epochs.map(removeGradient), bands: layers.bands.map(removeGradient) } : layers),
    [layers, flat],
  )
  const all = useMemo(() => (used ? [...used.epochs, ...used.bands] : []), [used])
  /** As épocas precisam ser redesenhadas aqui (em vez de usar o PNG pronto)? */
  const redraw = adjusting || flat

  // Redesenha quando um controle muda. Um desenho por quadro da tela, no máximo.
  useEffect(() => {
    if (!used || !enabled) return
    let cancelled = false
    const frame = requestAnimationFrame(async () => {
      const find = (id?: string) => all.find((l) => l.id === id)
      const [r, g, b] = [find(choice?.r), find(choice?.g), find(choice?.b)]
      const [nextEpochs, nextRgb] = await Promise.all([
        redraw ? Promise.all(used.epochs.map((l) => toObjectUrl(renderGray(l, adjusting ? params : DEFAULT_STRETCH)))) : null,
        // Com o estiramento desligado, a composição usa os valores padrão (não os dos controles).
        showRgb && r && g && b ? toObjectUrl(renderRgb(r, g, b, adjusting ? params : DEFAULT_STRETCH)) : null,
      ])
      const made = [...(nextEpochs ?? []), ...(nextRgb ? [nextRgb] : [])]
      if (cancelled) {
        made.forEach((url) => URL.revokeObjectURL(url))
        return
      }
      // Libera as imagens do desenho anterior, depois de a tela trocar para as novas.
      const old = stale.current
      stale.current = made
      setTimeout(() => old.forEach((url) => URL.revokeObjectURL(url)), 1500)
      setEpochUrls(nextEpochs)
      setRgbUrl(nextRgb)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [used, all, adjusting, redraw, params, choice, showRgb, enabled])

  useEffect(() => () => stale.current.forEach((url) => URL.revokeObjectURL(url)), [])

  return {
    layers,
    failed,
    adjusting,
    setAdjusting,
    flat,
    setFlat,
    params,
    /** Mexer num controle já liga o ajuste. */
    setParams(next: StretchParams) {
      setParams(next)
      setAdjusting(true)
    },
    reset() {
      setParams(DEFAULT_STRETCH)
      setAdjusting(false)
    },
    choice,
    setChoice,
    snapshot: (): ToolsSnapshot => ({ adjusting, flat, params, choice }),
    restore(from: ToolsSnapshot) {
      setAdjusting(from.adjusting)
      setFlat(from.flat)
      setParams(from.params)
      if (from.choice) setChoice(from.choice)
    },
    epochUrls: redraw ? epochUrls : null,
    rgbUrl: showRgb ? rgbUrl : null,
  }
}

export type ImageTools = ReturnType<typeof useImageTools>
