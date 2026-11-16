import { useState } from 'react'
import { Activity, Blend, Boxes, Contrast, Crosshair, Download, Languages, LoaderCircle, Palette, Rainbow, RotateCcw, Ruler, SlidersHorizontal, X } from 'lucide-react'
import { AlignmentInfo, CubeViewer, Diagnostics, RedshiftChart, SpectrumChart, WithSpectrum } from './ScienceTools'
import type { ImageTools as Tools, RgbChoice } from '../hooks/useImageTools'
import { micron } from '../utils/imaging'
import type { Layer, SpectralCoverage, SpectrumState } from '../utils/imaging'

interface Props {
  tools: Tools
  /** Texto de cada camada nos seletores de cor. */
  layerLabel(layer: Layer): string
  rgbActive: boolean
  /** Na comparação: qual painel estes controles ajustam ("A" ou "B"). */
  pane?: string
  onToggleRgb(): void
  /** Imagem em exibição já ajustada (para baixar); null se for a original. */
  download: { href: string; name: string } | null
  /** Espectro do ponto (medido em segundo plano) e o endereço do seu arquivo. */
  spectrum: SpectrumState
  spectrumAddress: string | null
  /** Começo do nome dos arquivos baixados. */
  fileBase: string
  onClose(): void
}

/** As três divisórias do painel, como num fichário: do mais simples ao mais técnico. */
const TABS = [
  { id: 'basic', label: 'Básicas', hint: 'Ajustar a imagem e entender o que ela mostra' },
  { id: 'advanced', label: 'Avançadas', hint: 'Medidas feitas sobre o alvo' },
  { id: 'science', label: 'Científicas', hint: 'Dados e correções para análise' },
] as const
type Tab = (typeof TABS)[number]['id']

const CHANNELS: { key: keyof RgbChoice; label: string }[] = [
  { key: 'r', label: 'Vermelho' },
  { key: 'g', label: 'Verde' },
  { key: 'b', label: 'Azul' },
]

/** Painel de ferramentas da tela de análise: estiramento e composição em cores. */
export function ImageTools({ tools, layerLabel, rgbActive, pane, onToggleRgb, download, spectrum, spectrumAddress, fileBase, onClose }: Props) {
  const { layers, params, choice } = tools
  const [tab, setTab] = useState<Tab>('basic')
  const percent = (value: number) => `${Math.round(value * 100)}%`

  return (
    <section className="tools" aria-label="Ferramentas de imagem">
      <header className="tools__header">
        <span className="with-icon">
          <SlidersHorizontal size={14} aria-hidden="true" />
          Ferramentas{pane ? ` · painel ${pane}` : ''}
        </span>
        <button type="button" className="icon-btn icon-btn--sm" onClick={onClose} aria-label="Fechar ferramentas" title="Fechar">
          <X size={13} />
        </button>
      </header>

      <div className="tools__tabs" role="tablist" aria-label="Grupos de ferramentas">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'is-on' : ''} title={t.hint} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {!layers ? (
        <p className="tools__note">
          {tools.failed ? (
            'Não foi possível preparar as imagens para ajuste.'
          ) : (
            <>
              <LoaderCircle size={12} className="spin" aria-hidden="true" /> Preparando as imagens…
            </>
          )}
        </p>
      ) : (
        <>
          {tab === 'basic' && (
          <>
          <div className="tools__group">
            <div className="tools__title">
              <label className="tools__switch">
                <input type="checkbox" checked={tools.adjusting} onChange={(e) => tools.setAdjusting(e.target.checked)} />
                <Contrast size={15} aria-hidden="true" />
                Estiramento
              </label>
              <button type="button" className="icon-btn icon-btn--sm" onClick={tools.reset} aria-label="Restaurar ajustes" title="Restaurar">
                <RotateCcw size={12} />
              </button>
            </div>
            {/* Desligado, os controles ficam apagados; mexer em um deles liga de novo. */}
            <div className={`tools__sliders${tools.adjusting ? '' : ' tools__sliders--off'}`}>
            <Slider
              label="Asinh"
              hint="Realça o que é fraco (nebulosas, braços de galáxias) sem estourar as estrelas."
              value={params.stretch}
              min={0}
              max={1}
              step={0.01}
              text={percent(params.stretch)}
              onChange={(stretch) => tools.setParams({ ...params, stretch })}
            />
            <Slider
              label="Ponto preto"
              hint="Tudo abaixo deste nível vira preto: escurece o fundo do céu."
              value={params.black}
              min={0}
              max={0.6}
              step={0.01}
              text={percent(params.black)}
              onChange={(black) => tools.setParams({ ...params, black })}
            />
            <Slider
              label="Gama"
              hint="Acima de 1 clareia os tons médios; abaixo de 1 escurece."
              value={params.gamma}
              min={0.3}
              max={3}
              step={0.05}
              text={params.gamma.toFixed(2).replace('.', ',')}
              onChange={(gamma) => tools.setParams({ ...params, gamma })}
            />
            </div>
            {!layers.raw && <p className="tools__note">Busca sem dados brutos: os ajustes agem sobre a imagem pronta.</p>}
          </div>

          <div className="tools__group">
            <div className="tools__title">
              <span className="with-icon">
                <Palette size={15} aria-hidden="true" />
                Composição RGB
              </span>
            </div>
            {choice &&
              CHANNELS.map(({ key, label }) => (
                <label key={key} className="tools__channel">
                  <span className={`tools__dot tools__dot--${key}`} aria-hidden="true" />
                  <span className="tools__channel-name">{label}</span>
                  <select value={choice[key]} onChange={(e) => tools.setChoice({ ...choice, [key]: e.target.value })}>
                    {layers.bands.length > 0 && (
                      <optgroup label="Outras faixas de cor">
                        {layers.bands.map((layer) => (
                          <option key={layer.id} value={layer.id}>
                            {layerLabel(layer)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="Épocas">
                      {layers.epochs.map((layer) => (
                        <option key={layer.id} value={layer.id}>
                          {layerLabel(layer)}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </label>
              ))}
            <p className="tools__note">
              {layers.bands.length > 0
                ? 'Cada cor recebe uma faixa do infravermelho. Os controles de estiramento também valem aqui.'
                : 'Esta busca só tem uma faixa de cor: usando datas diferentes em cada cor, o que mudou no tempo aparece colorido.'}
            </p>
            <button
              type="button"
              className={`btn tools__rgb${rgbActive ? ' is-on' : ''}`}
              onClick={onToggleRgb}
              aria-pressed={rgbActive}
            >
              <Palette size={14} aria-hidden="true" />
              {rgbActive ? 'Ocultar composição' : 'Ver composição'}
            </button>
          </div>

          <div className="tools__group">
            <div className="tools__title">
              <span className="with-icon">
                <Languages size={15} aria-hidden="true" />
                Tradutor do espectro
              </span>
            </div>
            <WithSpectrum state={spectrum}>{(data) => <Diagnostics data={data} />}</WithSpectrum>
            <p className="tools__note">Leitura automática, por regras simples, do brilho do alvo em cada cor (o gráfico está na aba Avançadas).</p>
          </div>
          </>
          )}

          {tab === 'advanced' && (
          <>
          <div className="tools__group">
            <div className="tools__title">
              <span className="with-icon">
                <Activity size={15} aria-hidden="true" />
                Espectro do ponto
              </span>
            </div>
            <WithSpectrum state={spectrum}>{(data) => <SpectrumChart data={data} fileBase={fileBase} />}</WithSpectrum>
          </div>
          <div className="tools__group">
            <div className="tools__title">
              <span className="with-icon">
                <Crosshair size={15} aria-hidden="true" />
                Alinhamento subpixel
              </span>
            </div>
            <AlignmentInfo layers={[...layers.epochs, ...layers.bands]} layerLabel={layerLabel} />
          </div>
          </>
          )}

          {tab === 'science' && (
          <>
          <div className="tools__group">
            <div className="tools__title">
              <span className="with-icon">
                <Rainbow size={15} aria-hidden="true" />
                Faixas de cor
              </span>
            </div>
            {layers.spectral ? (
              <SpectrumStrip
                spectral={layers.spectral}
                marks={
                  choice
                    ? CHANNELS.flatMap(({ key }) => {
                        const layer = [...layers.epochs, ...layers.bands].find((l) => l.id === choice[key])
                        return layer?.wavelength ? [{ key, wavelength: layer.wavelength }] : []
                      })
                    : []
                }
              />
            ) : (
              <p className="tools__note">Disponível em buscas feitas com dados da NASA a partir desta versão. Refaça a busca para ver.</p>
            )}
          </div>

          <div className="tools__group">
            <div className="tools__title">
              <span className="with-icon">
                <Boxes size={15} aria-hidden="true" />
                Cubo espectral
              </span>
            </div>
            <WithSpectrum state={spectrum}>
              {(data) =>
                data.cube && spectrumAddress && layers.spectral ? (
                  <CubeViewer cube={data.cube} address={spectrumAddress} centers={layers.spectral.centers} />
                ) : (
                  <p className="tools__note">Sem dados suficientes para montar o cubo deste ponto.</p>
                )
              }
            </WithSpectrum>
          </div>
          <div className="tools__group">
            <div className="tools__title">
              <label className="tools__switch">
                <input type="checkbox" checked={tools.flat} onChange={(e) => tools.setFlat(e.target.checked)} />
                <Blend size={15} aria-hidden="true" />
                Remover gradiente de fundo
              </label>
            </div>
            <p className="tools__note">
              Tira o brilho difuso que deixa um lado da imagem mais claro que o outro (resto da luz da poeira do Sistema Solar). Vale para as épocas e
              para a composição em cores.
            </p>
          </div>
          <div className="tools__group">
            <div className="tools__title">
              <span className="with-icon">
                <Ruler size={15} aria-hidden="true" />
                Redshift
              </span>
            </div>
            <WithSpectrum state={spectrum}>{(data) => <RedshiftChart data={data} />}</WithSpectrum>
          </div>
          </>
          )}

          {download && (
            <a className="btn tools__download" href={download.href} download={download.name}>
              <Download size={14} aria-hidden="true" />
              Baixar esta visualização
            </a>
          )}
        </>
      )}
    </section>
  )
}

/**
 * Régua do infravermelho do SPHEREx, dividida nas faixas de comprimento de onda. Cada coluna
 * é uma faixa: acesa quando alguma exposição viu este ponto do céu naquela cor (mais alta
 * quanto mais exposições). As bolinhas mostram onde estão as cores da composição RGB.
 */
function SpectrumStrip({ spectral, marks }: { spectral: SpectralCoverage; marks: { key: keyof RgbChoice; wavelength: number }[] }) {
  const { edges, counts } = spectral
  const total = counts.length
  const most = Math.max(1, ...counts)
  const filled = counts.filter((c) => c > 0).length
  const exposures = counts.reduce((sum, c) => sum + c, 0)
  /** Em que faixa (com fração) um comprimento de onda cai: posição horizontal na régua. */
  const position = (wavelength: number) => {
    const i = edges.findIndex((edge, k) => k < total && wavelength >= edge && wavelength < edges[k + 1])
    return i < 0 ? null : ((i + (wavelength - edges[i]) / (edges[i + 1] - edges[i])) / total) * 100
  }
  return (
    <div className="spectrum">
      <div className="spectrum__marks" aria-hidden="true">
        {marks.map(({ key, wavelength }) => {
          const left = position(wavelength)
          return left === null ? null : <span key={key} className={`tools__dot tools__dot--${key}`} style={{ left: `${left}%` }} />
        })}
      </div>
      <div className="spectrum__bars" role="img" aria-label={`${filled} de ${total} faixas de cor têm dados`}>
        {counts.map((count, i) => (
          <span
            key={edges[i]}
            className={`spectrum__bar${count === 0 ? ' spectrum__bar--empty' : ''}`}
            style={{ height: `${count === 0 ? 12 : 30 + (70 * count) / most}%`, background: count === 0 ? undefined : `hsl(${250 - (250 * i) / (total - 1)} 85% 62%)` }}
            title={`${micron(edges[i], 3)}–${micron(edges[i + 1], 3)} µm · ${count === 0 ? 'sem dados' : `${count} ${count === 1 ? 'exposição' : 'exposições'}`}`}
          />
        ))}
      </div>
      <div className="spectrum__axis" aria-hidden="true">
        <span>{micron(edges[0])} µm</span>
        <span>{micron(edges[total])} µm</span>
      </div>
      <p className="tools__note">
        {filled} de {total} faixas têm dados ({exposures} exposições deste ponto). Passe o mouse numa coluna para ver a faixa.
      </p>
    </div>
  )
}

interface SliderProps {
  label: string
  hint: string
  value: number
  min: number
  max: number
  step: number
  text: string
  onChange(value: number): void
}

function Slider({ label, hint, value, min, max, step, text, onChange }: SliderProps) {
  return (
    <label className="tools__slider" title={hint}>
      <span className="tools__slider-label">
        {label}
        <output>{text}</output>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}
