import type { Coords } from '../types'

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

function isValid(raDeg: number, decDeg: number) {
  return (
    Number.isFinite(raDeg) &&
    Number.isFinite(decDeg) &&
    raDeg >= 0 &&
    raDeg < 360 &&
    decDeg >= -90 &&
    decDeg <= 90
  )
}

/** Quebra um valor em (unidade, minutos, segundos) sem deixar os segundos arredondarem para 60. */
function sexagesimal(value: number, secDecimals: number) {
  const scale = 10 ** secDecimals
  let total = Math.round(Math.abs(value) * 3600 * scale)
  const secScaled = total % (60 * scale)
  total = (total - secScaled) / (60 * scale)
  const min = total % 60
  const unit = (total - min) / 60
  const sec = (secScaled / scale).toFixed(secDecimals).padStart(secDecimals + 3, '0')
  return { unit, min, sec }
}

/** 133.795 -> "08h55m10.80s" (formato aceito pelo back-end / astropy). */
export function formatRa(raDeg: number): string {
  const { unit, min, sec } = sexagesimal((((raDeg % 360) + 360) % 360) / 15, 2)
  return `${pad(unit % 24)}h${pad(min)}m${sec}s`
}

/** -7.245 -> "-07d14m42.0s" (formato aceito pelo back-end / astropy). */
export function formatDec(decDeg: number): string {
  const { unit, min, sec } = sexagesimal(decDeg, 1)
  return `${decDeg < 0 ? '-' : '+'}${pad(unit)}d${pad(min)}m${sec}s`
}

export function formatDecimal(c: Coords): string {
  return `${c.raDeg.toFixed(5)}°, ${c.decDeg >= 0 ? '+' : ''}${c.decDeg.toFixed(5)}°`
}

const RA_SEX = String.raw`(\d{1,2})\s*[h:\s]\s*(\d{1,2})\s*[m:\s]\s*(\d+(?:\.\d+)?)\s*s?`
const DEC_SEX = String.raw`([+-]?)\s*(\d{1,2})\s*[d°:\s]\s*(\d{1,2})\s*[m':\s]\s*(\d+(?:\.\d+)?)\s*[s"]?`
const SEXAGESIMAL = new RegExp(`^${RA_SEX}[\\s,]+${DEC_SEX}$`, 'i')
const DECIMAL = /^([+-]?\d+(?:\.\d+)?)\s*°?[\s,]+([+-]?\d+(?:\.\d+)?)\s*°?$/

/**
 * Interpreta o texto do input de busca.
 * Aceita graus decimais ("133.795 -7.245") e sexagesimal
 * ("08h55m10.8s -07d14m42s", "08:55:10.8 -07:14:42", "08 55 10.8 -07 14 42").
 * Devolve null quando o texto não é uma coordenada (ex.: nome de objeto).
 */
export function parseCoords(input: string): Coords | null {
  const text = input.trim()

  const dec = DECIMAL.exec(text)
  if (dec) {
    const raDeg = Number(dec[1])
    const decDeg = Number(dec[2])
    return isValid(raDeg, decDeg) ? { raDeg, decDeg } : null
  }

  const sex = SEXAGESIMAL.exec(text)
  if (sex) {
    const [, h, m, s, sign, d, dm, ds] = sex
    if (Number(m) >= 60 || Number(s) >= 60 || Number(dm) >= 60 || Number(ds) >= 60) return null
    const raDeg = (Number(h) + Number(m) / 60 + Number(s) / 3600) * 15
    const decAbs = Number(d) + Number(dm) / 60 + Number(ds) / 3600
    const decDeg = sign === '-' ? -decAbs : decAbs
    return isValid(raDeg, decDeg) ? { raDeg, decDeg } : null
  }

  return null
}

/** Duas posições contam como a mesma se diferirem por menos de ~0,4". */
export function sameCoords(a: Coords, b: Coords): boolean {
  return Math.abs(a.raDeg - b.raDeg) < 1e-4 && Math.abs(a.decDeg - b.decDeg) < 1e-4
}
