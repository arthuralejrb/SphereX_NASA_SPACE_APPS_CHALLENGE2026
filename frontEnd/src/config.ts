import type { Target } from './types'

/**
 * Links do modal de opções. Preencha quando o fórum e o canal de suporte existirem;
 * enquanto estiverem vazios, os botões aparecem desabilitados.
 */
export const LINKS = {
  forum: '',
  support: '',
}

/**
 * Levantamentos (HiPS) candidatos a fundo do mapa, em ordem de preferência.
 * O mapa usa o primeiro cujo servidor responder, então a queda de um
 * servidor não deixa a tela vazia. URLs diretas: o Aladin Lite 3.9 ainda
 * consulta um domínio antigo do CDS quando recebe só o identificador.
 */
export const BASE_SURVEYS = [
  { name: 'SPHEREx QR2 (CDS)', url: 'https://alasky.cds.unistra.fr/SPHEREx/color' },
  { name: '2MASS infravermelho (IRSA)', url: 'https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color' },
  { name: 'DSS2 óptico (ESA)', url: 'https://skies.esac.esa.int/DSSColor' },
]

/** Tempo máximo (ms) para resolver um nome de objeto antes de desistir. */
export const RESOLVE_TIMEOUT_MS = 8000

/** Atalhos fixos do ACESSO RÁPIDO, exibidos antes dos alvos que vêm de GET /api/targets. */
export const FEATURED_TARGETS: Target[] = [
  { name: 'M 31', description: 'Galáxia de Andrômeda', coords: { raDeg: 10.684708, decDeg: 41.26875 } },
  { name: 'M 42', description: 'Nebulosa de Órion', coords: { raDeg: 83.82208, decDeg: -5.39111 } },
  { name: 'Sgr A*', description: 'Centro galáctico', coords: { raDeg: 266.416837, decDeg: -29.007811 } },
]

/**
 * Tamanhos (graus) que o usuário pode escolher para o recorte do Nível 2.
 * Medido: até 1° a busca quase não muda de tempo; em 1,5° gasta ~3 s a mais e as imagens
 * somam ~5 MB; acima disso o alvo deixa de caber inteiro no detector. O processador corta em 1,5°.
 */
export const FOV_OPTIONS = [0.25, 0.5, 1, 1.5]

/** Campo de visão (graus) usado ao centralizar o mapa numa coordenada. */
export const FOCUS_FOV = 1.5
