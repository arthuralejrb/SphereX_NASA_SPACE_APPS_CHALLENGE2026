/** Tipagem mínima do Aladin Lite v3: só o que o projeto usa. */
declare module 'aladin-lite' {
  export interface AladinOptions {
    survey?: string
    target?: string
    fov?: number
    cooFrame?: string
    projection?: string
    mode?: 'dark' | 'light'
    log?: boolean
    [option: string]: unknown
  }

  export interface AladinInstance {
    /** Pixel do canvas -> [ra, dec] em graus. */
    pix2world(x: number, y: number, frame?: string): [number, number] | null | undefined
    /** [ra, dec] em graus -> pixel do canvas (null se fora da vista). */
    world2pix(ra: number, dec: number, frame?: string): [number, number] | null | undefined
    gotoRaDec(ra: number, dec: number): void
    gotoObject(name: string, callbacks?: { success?: (raDec: [number, number]) => void; error?: () => void }): void
    getRaDec(): [number, number]
    setFoV(fovDeg: number): void
    getFov(): [number, number]
    addCatalog(catalog: AladinCatalog): void
  }

  export interface AladinCatalogOptions {
    name?: string
    color?: string
    sourceSize?: number
    shape?: string
    /** 'showPopup' abre um balão com os dados da fonte; 'showTable' abre a tabela inferior. */
    onClick?: 'showPopup' | 'showTable'
  }

  export interface AladinSource {
    ra: number
    dec: number
  }

  export interface AladinCatalog {
    addSources(sources: AladinSource[]): void
    removeAll(): void
  }

  const A: {
    /** Resolve quando o núcleo WebAssembly/WebGL2 está carregado. */
    init: Promise<void>
    aladin(target: HTMLElement | string, options?: AladinOptions): AladinInstance
    catalog(options?: AladinCatalogOptions): AladinCatalog
    /** Catálogo progressivo (HiPS): o Aladin baixa as fontes conforme a vista. */
    catalogHiPS(url: string, options?: AladinCatalogOptions): AladinCatalog
    source(ra: number, dec: number, data?: Record<string, string>): AladinSource
  }
  export default A
}
