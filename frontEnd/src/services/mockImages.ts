/**
 * Imagens de demonstração geradas no próprio navegador (sem rede).
 *
 * Cada coordenada produz sempre o mesmo campo de estrelas (semente derivada de RA/Dec).
 * Entre as épocas, uma fonte se desloca (movimento próprio) e outra varia de brilho,
 * para que o comparador temporal tenha algo real para mostrar enquanto o
 * processor ainda não entrega imagens do SPHEREx.
 */
import type { Coords } from '../types'

const SIZE = 640

/** PRNG determinístico (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seedFrom(coords: Coords) {
  return (Math.round(coords.raDeg * 1000) * 73856093) ^ (Math.round((coords.decDeg + 90) * 1000) * 19349663)
}

function blob(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, rgb: string, alpha: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius)
  g.addColorStop(0, `rgb(${rgb} / ${alpha})`)
  g.addColorStop(0.35, `rgb(${rgb} / ${alpha * 0.35})`)
  g.addColorStop(1, `rgb(${rgb} / 0)`)
  ctx.fillStyle = g
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2)
}

interface Field {
  stars: { x: number; y: number; r: number; a: number; rgb: string }[]
  mover: { x: number; y: number; dx: number; dy: number }
  variable: { x: number; y: number; phase: number }
}

function buildField(coords: Coords): Field {
  const rand = rng(seedFrom(coords))
  const tints = ['255 244 230', '255 226 196', '255 205 160', '230 238 255']
  const stars = Array.from({ length: 260 }, () => {
    const flux = Math.pow(rand(), 6) // muitas fracas, poucas brilhantes
    return {
      x: rand() * SIZE,
      y: rand() * SIZE,
      r: 2.5 + flux * 26,
      a: 0.35 + flux * 0.65,
      rgb: tints[Math.floor(rand() * tints.length)],
    }
  })
  const angle = rand() * Math.PI * 2
  return {
    stars,
    mover: { x: SIZE * (0.4 + rand() * 0.2), y: SIZE * (0.4 + rand() * 0.2), dx: Math.cos(angle) * 16, dy: Math.sin(angle) * 16 },
    variable: { x: SIZE * (0.2 + rand() * 0.6), y: SIZE * (0.15 + rand() * 0.2), phase: rand() * Math.PI * 2 },
  }
}

function moverAt(field: Field, epoch: number) {
  return { x: field.mover.x + field.mover.dx * epoch, y: field.mover.y + field.mover.dy * epoch }
}

function variableFlux(field: Field, epoch: number) {
  return 0.55 + 0.45 * Math.sin(field.variable.phase + epoch * 1.7)
}

function newCanvas() {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D indisponível')
  return { canvas, ctx }
}

function addNoise(ctx: CanvasRenderingContext2D, seed: number, rgb: string) {
  const rand = rng(seed)
  for (let i = 0; i < 5000; i++) {
    ctx.fillStyle = `rgb(${rgb} / ${rand() * 0.07})`
    ctx.fillRect(rand() * SIZE, rand() * SIZE, 2, 2)
  }
}

/** Imagem de uma época (índice 0, 1, 2…) como data URL. */
export function mockEpochImage(coords: Coords, epoch: number): string {
  const field = buildField(coords)
  const { canvas, ctx } = newCanvas()
  ctx.fillStyle = '#05060a'
  ctx.fillRect(0, 0, SIZE, SIZE)
  ctx.globalCompositeOperation = 'lighter'
  addNoise(ctx, seedFrom(coords) + 101 * (epoch + 1), '255 255 255')

  for (const s of field.stars) blob(ctx, s.x, s.y, s.r, s.rgb, s.a)

  const mover = moverAt(field, epoch)
  blob(ctx, mover.x, mover.y, 9, '255 190 140', 0.95)
  blob(ctx, field.variable.x, field.variable.y, 6 + 10 * variableFlux(field, epoch), '255 240 220', 0.4 + 0.6 * variableFlux(field, epoch))

  return canvas.toDataURL('image/jpeg', 0.88)
}

/** Imagem de subtração (última época − primeira): só o que mudou aparece. */
export function mockSubtractedImage(coords: Coords, firstEpoch: number, lastEpoch: number): string {
  const field = buildField(coords)
  const { canvas, ctx } = newCanvas()
  ctx.fillStyle = '#6e6e6e'
  ctx.fillRect(0, 0, SIZE, SIZE)
  addNoise(ctx, seedFrom(coords) + 7, '255 255 255')
  addNoise(ctx, seedFrom(coords) + 13, '0 0 0')

  const from = moverAt(field, firstEpoch)
  const to = moverAt(field, lastEpoch)
  blob(ctx, from.x, from.y, 9, '0 0 0', 0.9) // sumiu daqui
  blob(ctx, to.x, to.y, 9, '255 255 255', 0.95) // apareceu aqui

  const delta = variableFlux(field, lastEpoch) - variableFlux(field, firstEpoch)
  blob(ctx, field.variable.x, field.variable.y, 12, delta >= 0 ? '255 255 255' : '0 0 0', Math.min(1, Math.abs(delta) * 1.2))

  return canvas.toDataURL('image/jpeg', 0.88)
}
