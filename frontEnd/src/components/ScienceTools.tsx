import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Download, LoaderCircle } from 'lucide-react'
import { DEFAULT_STRETCH, cubeSlice, loadCube, micron, renderGray } from '../utils/imaging'
import type { CubeInfo, Layer, SpectrumData, SpectrumState } from '../utils/imaging'

/** 1234.5 -> "1.230"; 0.01234 -> "0,0123" (três algarismos significativos, à brasileira). */
const sig =(value: number, digits = 3) =>
  Number(value.toPrecision(digits)).toLocaleString('pt-BR', { maximumSignificantDigits: digits, useGrouping: Math.abs(value) >= 10000 })

/**
 * Mostra o conteúdo quando o espectro está pronto; antes disso, o andamento da medição ou o
 * motivo de não haver espectro. Usado por todas as ferramentas que dependem dele.
 */
export function WithSpectrum({ state, children }: { state: SpectrumState; children(data: SpectrumData): ReactNode }) {
  if (state.status === 'done') return <>{children(state)}</>
  if (state.status === 'running') {
    const ratio = state.total > 0 ? state.done / state.total : 0
    return (
      <div className="progress" role="status">
        <p className="tools__note">
          <LoaderCircle size={13} className="spin" aria-hidden="true" />
          {state.total > 0 ? `Medindo o brilho do alvo: ${state.done} de ${state.total} exposições…` : 'Preparando a medição do brilho…'}
        </p>
        <div className="progress__track">
          <span style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
        <p className="tools__note">Leva cerca de meio minuto. Pode continuar usando o resto da tela.</p>
      </div>
    )
  }
  return (
    <p className="tools__note">
      {state.status === 'failed'
        ? 'Não foi possível medir o espectro deste ponto. Tente refazer a busca mais tarde.'
        : 'Disponível em buscas feitas com dados da NASA a partir desta versão. Refaça a busca para ver.'}
    </p>
  )
}

/* ---------- Função 4: espectro do ponto ---------- */

const W = 284
const H = 150
const PAD = { left: 38, right: 6, top: 8, bottom: 22 }
const X_RANGE: [number, number] = [0.75, 5]

/** Gráfico do brilho do alvo em cada cor: pontos claros = cada exposição; linha = média por faixa. */
export function SpectrumChart({ data, fileBase }: { data: SpectrumData; fileBase: string }) {
  const bins = data.bins
  const clean = data.points.filter((p) => p[6].length === 0)
  const shown = clean.length >= 5 ? clean : data.points

  const scale = useMemo(() => {
    const values = bins.flatMap((b) => [b[1] + b[2], b[1] - b[2]])
    const top = Math.max(...values, 0)
    const bottom = Math.min(...values, 0)
    const span = top - bottom || 1
    const y0 = bottom - 0.05 * span
    const y1 = top + 0.08 * span
    return {
      x: (wl: number) => PAD.left + ((wl - X_RANGE[0]) / (X_RANGE[1] - X_RANGE[0])) * (W - PAD.left - PAD.right),
      y: (v: number) => PAD.top + (1 - (Math.min(y1, Math.max(y0, v)) - y0) / (y1 - y0)) * (H - PAD.top - PAD.bottom),
      y0,
      y1,
    }
  }, [bins])

  const csv = useMemo(() => {
    const lines = ['comprimento_de_onda_um,largura_um,brilho_mJy,erro_mJy,detector,data_MJD,avisos']
    for (const p of data.points) lines.push([p[0], p[1], p[2], p[3], p[4], p[5], p[6].join(' ')].join(','))
    return `data:text/csv;charset=utf-8,${encodeURIComponent(lines.join('\n'))}`
  }, [data.points])

  if (bins.length === 0) {
    return (
      <p className="tools__note">
        {data.saturated > 0
          ? `O alvo é brilhante demais: saturou o detector nas ${data.saturated} exposições lidas, e não há como medir o brilho com confiança.`
          : 'Nenhuma exposição permitiu medir o brilho deste ponto.'}
      </p>
    )
  }

  const { x, y } = scale
  const ticksY = [scale.y0 + 0.05 * (scale.y1 - scale.y0), (scale.y0 + scale.y1) / 2, scale.y1 - 0.08 * (scale.y1 - scale.y0)]
  const line = bins.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(b[0]).toFixed(1)},${y(b[1]).toFixed(1)}`).join(' ')
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Espectro do ponto: brilho em ${bins.length} faixas de cor, de ${micron(bins[0][0])} a ${micron(bins[bins.length - 1][0])} µm`}>
        {ticksY.map((v) => (
          <g key={v}>
            <line className="chart__grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text className="chart__tick" x={PAD.left - 4} y={y(v) + 3} textAnchor="end">
              {sig(v, 2)}
            </text>
          </g>
        ))}
        {[1, 2, 3, 4, 5].map((wl) => (
          <text key={wl} className="chart__tick" x={x(wl)} y={H - 8} textAnchor="middle">
            {wl}
          </text>
        ))}
        {scale.y0 < 0 && <line className="chart__zero" x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} />}
        {shown.map((p, i) => (
          <circle key={i} className="chart__point" cx={x(p[0])} cy={y(p[2])} r={1.1} />
        ))}
        <path className="chart__line" d={line} />
        {bins.map((b) => (
          <g key={b[0]}>
            <line className="chart__error" x1={x(b[0])} x2={x(b[0])} y1={y(b[1] - b[2])} y2={y(b[1] + b[2])} />
            <circle className={`chart__bin${b[4] ? ' chart__bin--flagged' : ''}`} cx={x(b[0])} cy={y(b[1])} r={2}>
              <title>{`${micron(b[0], 3)} µm · ${sig(b[1])} ± ${sig(b[2], 2)} ${data.unit} · ${b[3]} ${b[3] === 1 ? 'medida' : 'medidas'}${b[4] ? ' (com aviso de qualidade)' : ''}`}</title>
            </circle>
          </g>
        ))}
      </svg>
      <div className="chart__axis">
        <span>brilho ({data.unit})</span>
        <span>comprimento de onda (µm)</span>
      </div>
      <p className="tools__note">
        {data.points.length} medidas em {bins.length} faixas de cor. Pontos claros: cada exposição; linha: valor típico por faixa. Passe o mouse num
        ponto para ver os números.
      </p>
      {data.saturated > 0 && (
        <p className="tools__note tools__note--warn">
          Em {data.saturated} exposições o alvo saturou o detector (brilhante demais) e a medida foi descartada.
        </p>
      )}
      <a className="btn tools__download" href={csv} download={`${fileBase}_espectro.csv`}>
        <Download size={14} aria-hidden="true" />
        Baixar medidas (.csv)
      </a>
    </div>
  )
}

/* ---------- Função 3: tradutor ---------- */

/** Cartões com a leitura automática do espectro, em linguagem simples. */
export function Diagnostics({ data }: { data: SpectrumData }) {
  return (
    <ul className="diagnostics">
      {data.diagnostics.map((d) => (
        <li key={d.id} className={`diagnostics__item diagnostics__item--${d.id.split('-')[0]}`}>
          <b>{d.title}</b>
          <span>{d.text}</span>
          {d.ratio !== undefined && (
            <span className="diagnostics__ratio">
              Brilho nesta cor: {Math.round(d.ratio * 100)}% do esperado pelas cores vizinhas.
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

/* ---------- Função 5: alinhamento subpixel ---------- */

export function AlignmentInfo({ layers, layerLabel }: { layers: Layer[]; layerLabel(layer: Layer): string }) {
  const measured = layers.filter((l) => l.shift)
  if (measured.length === 0) {
    return <p className="tools__note">Disponível em buscas feitas com dados da NASA a partir desta versão. Refaça a busca para ver.</p>
  }
  const px = (v: number) => `${v.toFixed(2).replace('.', ',')} px`
  return (
    <>
      <ul className="align">
        <li>
          <span>{layerLabel(layers[0])}</span>
          <span>referência</span>
        </li>
        {measured.map((l) => {
          const s = l.shift!
          const before = s.dx === null || s.dy === null ? null : Math.hypot(s.dx, s.dy)
          return (
            <li key={l.id} title={before === null ? undefined : `Deslocamento medido: ${px(s.dx!)} na horizontal, ${px(s.dy!)} na vertical`}>
              <span>{layerLabel(l)}</span>
              <span>
                {before === null || s.residual === null
                  ? `poucas estrelas (${s.stars})`
                  : before === 0
                    ? `${px(s.residual)} · ${s.stars} estrelas`
                    : `${px(before)} → ${px(s.residual)} · ${s.stars} estrelas`}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="tools__note">
        Cada imagem é encaixada na primeira pelas coordenadas do céu e depois conferida pelas estrelas: o que sobra de desvio (frações de pixel) é
        corrigido. Assim nenhuma estrela aparece tremida ao comparar.
      </p>
    </>
  )
}

/* ---------- Funções 9 e 6: cubo espectral e correção de ruído ---------- */

/** Navega pelas fatias do cubo: uma imagem pequena do alvo em cada faixa de cor. */
export function CubeViewer({ cube, address, centers }: { cube: CubeInfo; address: string; centers: number[] }) {
  const [data, setData] = useState<Float32Array | null>(null)
  const [failed, setFailed] = useState(false)
  /** Só as fatias que têm dado entram no controle. */
  const filled = useMemo(() => cube.slices.flatMap((s, k) => (s.coverage > 0 ? [k] : [])), [cube])
  const [position, setPosition] = useState(() => Math.floor(filled.length / 2))
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    loadCube(address, cube)
      .then((d) => !cancelled && setData(d))
      .catch((err) => {
        console.warn('[cubo] não foi possível ler o cubo espectral.', err)
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [address, cube])

  const index = filled[Math.min(position, filled.length - 1)]
  useEffect(() => {
    if (!data || index === undefined || !canvas.current) return
    canvas.current.getContext('2d')?.putImageData(renderGray(cubeSlice(data, cube, index), DEFAULT_STRETCH), 0, 0)
  }, [data, cube, index])

  if (failed) return <p className="tools__note">Não foi possível ler o cubo espectral.</p>
  if (filled.length === 0) return <p className="tools__note">Nenhuma faixa de cor tem dados suficientes para montar o cubo.</p>
  const slice = cube.slices[index]
  const field = Math.round((cube.size * cube.pixelArcsec) / 6) / 10
  return (
    <div className="cube">
      <canvas ref={canvas} width={cube.size} height={cube.size} className="cube__image" aria-label={`Imagem do alvo em ${micron(centers[index] ?? 0)} µm`} />
      <label className="tools__slider">
        <span className="tools__slider-label">
          Faixa {index + 1} de {cube.slices.length}
          <output>{centers[index] ? `${micron(centers[index], 3)} µm` : ''}</output>
        </span>
        <input type="range" min={0} max={filled.length - 1} step={1} value={Math.min(position, filled.length - 1)} onChange={(e) => setPosition(Number(e.target.value))} />
      </label>
      <dl className="cube__facts">
        <dt>Medidas somadas</dt>
        <dd>até {slice.exposures} por pixel</dd>
        <dt>Área com dado</dt>
        <dd>{Math.round(slice.coverage * 100)}%</dd>
        <dt>Ruído (erro) por pixel</dt>
        <dd>{slice.noise === null ? 'sem estimativa' : `${sig(slice.noise)} ${cube.unit}`}</dd>
        <dt>Sem a correção</dt>
        <dd>{slice.noise === null ? 'sem estimativa' : `${sig(slice.noise / cube.noiseFactor)} ${cube.unit}`}</dd>
      </dl>
      <p className="tools__note">
        Imagem de {String(field).replace('.', ',')}′ de lado em volta do alvo, norte para cima. Arraste o controle para percorrer as cores, do
        infravermelho mais próximo ao mais distante.
      </p>
      <p className="tools__note">
        <b>Correção de ruído de reamostragem:</b>&nbsp;ao redesenhar cada exposição na grade do cubo, pixels vizinhos se misturam e o erro calculado sai
        pequeno demais. Por isso o erro é multiplicado por {String(cube.noiseFactor).replace('.', ',')}.
      </p>
    </div>
  )
}

/* ---------- Função 8: redshift ---------- */

const RW = 284
const RH = 118

/** Curva de discordância (chi²) entre o espectro e um modelo de galáxia, para cada redshift testado. */
export function RedshiftChart({ data }: { data: SpectrumData }) {
  const fits = data.redshift?.fits ?? []
  const [chosen, setChosen] = useState(0)
  if (!data.redshift || fits.length === 0) {
    return <p className="tools__note">São precisas pelo menos 15 faixas de cor com brilho medido para tentar o ajuste.</p>
  }
  const fit = fits[Math.min(chosen, fits.length - 1)]
  const { zMin, zMax } = data.redshift
  const finite = fit.curve.filter((v): v is number => v !== null && v > 0)
  const lo = Math.log10(Math.min(...finite))
  const hi = Math.log10(Math.max(...finite))
  const pad = { left: 8, right: 8, top: 8, bottom: 20 }
  const x = (z: number) => pad.left + ((z - zMin) / (zMax - zMin)) * (RW - pad.left - pad.right)
  const y = (v: number) => pad.top + (1 - (Math.log10(v) - lo) / (hi - lo || 1)) * (RH - pad.top - pad.bottom)
  const step = (zMax - zMin) / (fit.curve.length - 1)
  let path = ''
  let pen = false
  fit.curve.forEach((v, k) => {
    if (v === null || v <= 0) {
      pen = false
      return
    }
    path += `${pen ? 'L' : 'M'}${x(zMin + k * step).toFixed(1)},${y(v).toFixed(1)} `
    pen = true
  })
  const good = fit.chi2 < 3
  return (
    <div className="chart">
      <div className="segmented segmented--small" role="group" aria-label="Modelo de galáxia">
        {fits.map((f, i) => (
          <button key={f.template} type="button" className={i === chosen ? 'is-on' : ''} aria-pressed={i === chosen} onClick={() => setChosen(i)}>
            {f.name.replace('Galáxia ', '').replace('com surto de formação estelar', 'surto estelar')}
          </button>
        ))}
      </div>
      <svg viewBox={`0 0 ${RW} ${RH}`} role="img" aria-label={`Ajuste de redshift com o modelo ${fit.name}: melhor valor z = ${fit.z}`}>
        {[0, 1, 2, 3].map((z) => (
          <text key={z} className="chart__tick" x={x(z)} y={RH - 6} textAnchor="middle">
            {z}
          </text>
        ))}
        <path className="chart__line" d={path} />
        <line className="chart__best" x1={x(fit.z)} x2={x(fit.z)} y1={pad.top} y2={RH - pad.bottom} />
      </svg>
      <div className="chart__axis">
        <span>discordância (quanto mais baixo, melhor)</span>
        <span>redshift z</span>
      </div>
      <p className="tools__note">
        <b>
          {fit.name}: z = {String(fit.z).replace('.', ',')}
        </b>
        &nbsp;(discordância {sig(fit.chi2)}).{' '}
        {good
          ? 'O modelo é compatível com o espectro, o que por si só não prova que o alvo seja uma galáxia (um espectro com muito ruído é compatível com quase tudo).'
          : 'O modelo não acompanha bem o espectro: trate o valor como um palpite fraco.'}
      </p>
      <p className="tools__note tools__note--warn">
        Só faz sentido se o alvo for uma galáxia. Para estrelas e nebulosas da nossa galáxia o resultado não tem significado.
      </p>
      <p className="tools__note">
        O modelo de galáxia é esticado por (1 + z) até se encaixar no espectro medido; o quanto foi preciso esticar indica a distância. Modelos:{' '}
        {data.redshift.source}.
      </p>
    </div>
  )
}
