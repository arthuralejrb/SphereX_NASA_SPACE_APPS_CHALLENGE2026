import os
import io
import glob
import time
import shutil
import tempfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
import numpy as np
import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from astropy.io import fits
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales
from astropy.nddata import Cutout2D
from astropy.coordinates import SkyCoord
import astropy.units as u
from astropy.visualization import ZScaleInterval
from astroquery.ipac.irsa import Irsa
from reproject import reproject_interp
import matplotlib.pyplot as plt

app = FastAPI()

OUTPUT_DIR = os.getenv("OUTPUT_DIR", "/app/images")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# FITS inteiros já guardados (os alvos pré-baixados), uma subpasta por coordenada. O site não
# grava mais nada aqui: buscas novas leem só um pedaço do arquivo direto do S3, sem guardar.
# (por estarem em subpastas, não entram no plano B, que só lê dados_fits/*.fits)
PASTA_NASA = os.path.join("dados_fits", "nasa")

IRSA_TIMEOUT_S = 45          # consulta ao catálogo da NASA, já contando as repetições (medido: 4 a 5 s cada)
IRSA_TENTATIVAS = 5          # o IRSA devolve erro 502 de vez em quando; costuma passar na repetição
PARCIAL_TIMEOUT_S = 60       # cada pedido da leitura parcial (medido: 3 épocas em ~9 s no total)
DOWNLOAD_TIMEOUT_S = 150     # reserva: FITS inteiro de ~65 MB (medido: ~55 s com 3 em paralelo)
RAIO_BUSCA = 1 * u.arcsec    # só interessa a exposição que CONTÉM o ponto pedido
RECORTE_MIN_GRAUS = 0.05
RECORTE_MAX_GRAUS = 1.5     # acima disso o alvo raramente cabe inteiro no detector e o tempo dispara
INTERVALO_VISITAS_DIAS = 30  # exposições separadas por mais que isto são visitas diferentes
N_EPOCAS = 3

# O mesmo arquivo existe no IRSA e no bucket S3 público; o S3 é mais rápido e estável
PREFIXO_IRSA = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
PREFIXO_S3 = "https://nasa-irsa-spherex.s3.amazonaws.com/"

BLOCO_FITS = 2880  # todo arquivo FITS é organizado em blocos deste tamanho, em bytes
TIPOS_FITS = {8: "u1", 16: ">i2", 32: ">i4", 64: ">i8", -32: ">f4", -64: ">f8"}  # BITPIX -> tipo numpy

# Flags de contaminação: só contam os pixels dentro deste raio em volta do alvo
# (3 px = ~18", o tamanho da mancha de uma estrela no SPHEREx, cujo pixel tem 6,15")
RAIO_FLAGS_PX = 3
# Avisos que não são defeito e por isso não entram na lista:
#   SOURCE     = "há uma fonte conhecida aqui" (liga em 40% a 98% do detector)
#   FULLSAMPLE = "este pixel tem o histórico completo de leituras" (é informação a mais)
FLAGS_INFORMATIVAS = {"SOURCE", "FULLSAMPLE"}


class SkyRequest(BaseModel):
    ra: str
    dec: str
    fov: float = 0.5  # campo de visão pedido pelo site: vira o tamanho do recorte, em graus


def nome_seguro(texto: str) -> str:
    """Troca caracteres problemáticos em nome de arquivo por '_'."""
    return "".join(c if c.isalnum() or c in "+-." else "_" for c in texto)


def _consultar_irsa(coord: SkyCoord):
    """Lista as exposições do SPHEREx que contêm o ponto pedido."""
    ultimo_erro = None
    for tentativa in range(1, IRSA_TENTATIVAS + 1):
        try:
            for colecao in ("spherex_dr1", "spherex_qr3"):
                tabela = Irsa.query_sia(pos=(coord, RAIO_BUSCA), collection=colecao)
                if len(tabela) > 0:
                    return tabela
            return None  # a NASA respondeu: não há exposições neste ponto
        except Exception as e:
            ultimo_erro = e
            print(f"Consulta ao IRSA falhou (tentativa {tentativa}/{IRSA_TENTATIVAS}): {type(e).__name__}")
            time.sleep(2)
    raise ultimo_erro


def buscar_tabela_nasa(coord: SkyCoord):
    """Corta a consulta à NASA ao fim de IRSA_TIMEOUT_S segundos."""
    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(_consultar_irsa, coord)
    try:
        return future.result(timeout=IRSA_TIMEOUT_S)
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def escolher_epocas(tabela, coord: SkyCoord, n: int = N_EPOCAS):
    """
    Escolhe até n exposições de visitas diferentes, todas no mesmo detector.

    O SPHEREx volta ao mesmo ponto do céu a cada ~6 meses (uma "visita") e, em cada
    visita, tira várias exposições em poucos dias. Para comparar no tempo queremos
    uma exposição por visita. Dentro da visita, fica a exposição em que o alvo está
    mais perto do centro do detector (longe da borda).
    """
    tempos = np.asarray(tabela["t_min"], dtype=float)  # MJD: contado em dias
    bandas = np.asarray(tabela["energy_bandpassname"]).astype(str)
    centros = SkyCoord(np.asarray(tabela["s_ra"], dtype=float) * u.deg,
                       np.asarray(tabela["s_dec"], dtype=float) * u.deg, frame="icrs")
    distancia = coord.separation(centros).deg

    melhor = None
    for banda in sorted(set(bandas)):
        indices = np.where(bandas == banda)[0]
        indices = indices[np.argsort(tempos[indices])]
        visitas = [[indices[0]]]
        for i in indices[1:]:
            if tempos[i] - tempos[visitas[-1][-1]] > INTERVALO_VISITAS_DIAS:
                visitas.append([i])
            else:
                visitas[-1].append(i)
        # Ganha o detector com mais visitas; no empate, o que tem mais exposições
        chave = (len(visitas), len(indices))
        if melhor is None or chave > melhor[0]:
            melhor = (chave, banda, visitas)

    _, banda, visitas = melhor

    # Regiões observadas continuamente (campos profundos) não têm "visitas" separadas:
    # nesse caso, espalha a escolha ao longo do tempo
    if len(visitas) == 1 and len(visitas[0]) > 1:
        visitas = [[i] for i in visitas[0]]

    if len(visitas) > n:
        posicoes = sorted(set(np.linspace(0, len(visitas) - 1, n).round().astype(int)))
        visitas = [visitas[p] for p in posicoes]

    linhas = [tabela[int(min(visita, key=lambda i: distancia[i]))] for visita in visitas]
    return linhas, banda


def _ler_faixa(sessao, url: str, inicio: int, fim: int) -> bytes:
    """Baixa só os bytes [inicio, fim) do arquivo (pedido HTTP "Range")."""
    resposta = sessao.get(url, headers={"Range": f"bytes={inicio}-{fim - 1}"}, timeout=PARCIAL_TIMEOUT_S)
    if resposta.status_code != 206:
        raise RuntimeError(f"o servidor não aceitou a leitura parcial (HTTP {resposta.status_code})")
    return resposta.content


def _ler_header(sessao, url: str, posicao: int):
    """Lê um cabeçalho FITS que começa em `posicao`. Devolve (header, posição onde começam os dados)."""
    buffer = b""
    while len(buffer) < 200 * BLOCO_FITS:
        buffer += _ler_faixa(sessao, url, posicao + len(buffer), posicao + len(buffer) + 16 * BLOCO_FITS)
        for inicio in range(0, len(buffer) - BLOCO_FITS + 1, BLOCO_FITS):
            bloco = buffer[inicio:inicio + BLOCO_FITS]
            # O cabeçalho termina no bloco que contém o cartão "END"
            if any(bloco[i:i + 8] == b"END     " for i in range(0, BLOCO_FITS, 80)):
                fim = inicio + BLOCO_FITS
                return fits.Header.fromstring(buffer[:fim].decode("ascii")), posicao + fim
    raise RuntimeError("cabeçalho FITS não encontrado")


def _tamanho_dados(header) -> int:
    """Quantos bytes os dados desta camada ocupam no arquivo (o FITS arredonda para blocos de 2880)."""
    if header.get("NAXIS", 0) == 0:
        return 0
    elementos = 1
    for eixo in range(1, header["NAXIS"] + 1):
        elementos *= header[f"NAXIS{eixo}"]
    total = abs(header["BITPIX"]) // 8 * header.get("GCOUNT", 1) * (header.get("PCOUNT", 0) + elementos)
    return -(-total // BLOCO_FITS) * BLOCO_FITS


def nomes_das_flags(header) -> dict:
    """
    Lê do cabeçalho da camada FLAGS o nome de cada aviso. Cada pixel dessa camada é um número
    em que cada bit é um aviso diferente, e o próprio arquivo diz qual é qual:
    MSKN0010 = 'HOT' quer dizer "o bit 10 significa pixel quente". Devolve {10: "HOT", ...}.
    """
    nomes = {}
    for chave in header:
        if chave.startswith("MSKN") and chave[4:].isdigit():
            nomes[int(chave[4:])] = str(header[chave]).strip()
    return nomes


def flags_no_alvo(flags, nomes: dict, x: float, y: float) -> set:
    """Nomes dos avisos ligados em algum pixel a até RAIO_FLAGS_PX do ponto (x, y)."""
    ny, nx = flags.shape
    raio = RAIO_FLAGS_PX
    x0, x1 = max(0, int(np.floor(x - raio))), min(nx, int(np.ceil(x + raio)) + 1)
    y0, y1 = max(0, int(np.floor(y - raio))), min(ny, int(np.ceil(y + raio)) + 1)
    if x1 <= x0 or y1 <= y0:
        return set()  # o alvo está fora desta imagem
    janela = np.asarray(flags[y0:y1, x0:x1]).astype(np.int64)
    yy, xx = np.ogrid[y0:y1, x0:x1]
    valores = janela[(xx - x) ** 2 + (yy - y) ** 2 <= raio * raio]
    if valores.size == 0:
        return set()
    juntos = int(np.bitwise_or.reduce(valores))  # liga cada bit que aparece em pelo menos um pixel
    ligados = {nomes.get(bit, f"BIT_{bit}") for bit in range(32) if (juntos >> bit) & 1}
    return ligados - FLAGS_INFORMATIVAS


def _ler_linhas_comprimidas(sessao, url: str, header, inicio: int, y0: int, y1: int):
    """
    Lê as linhas [y0, y1) de uma camada comprimida (caso das FLAGS do SPHEREx).

    No arquivo, uma imagem comprimida é uma tabela com uma entrada por linha da imagem
    (tamanho e posição do bloco comprimido), seguida dos blocos. Baixamos a tabela (16 KB),
    depois só os blocos das linhas pedidas, e montamos em memória um mini-FITS com essas
    linhas para o Astropy descomprimir.
    """
    if header.get("ZTILE1") != header.get("ZNAXIS1") or header.get("ZTILE2", 1) != 1 or header.get("TFIELDS") != 1:
        raise RuntimeError("compressão num formato inesperado")
    n_linhas = header["NAXIS2"]
    tamanho_tabela = header["NAXIS1"] * n_linhas
    tabela = np.frombuffer(_ler_faixa(sessao, url, inicio, inicio + tamanho_tabela), dtype=">i4").reshape(n_linhas, 2)
    tamanhos, posicoes = tabela[y0:y1, 0].astype(np.int64), tabela[y0:y1, 1].astype(np.int64)
    comeco, fim = int(posicoes.min()), int((posicoes + tamanhos).max())
    inicio_blocos = inicio + header.get("THEAP", tamanho_tabela)
    blocos = _ler_faixa(sessao, url, inicio_blocos + comeco, inicio_blocos + fim)

    mini_header = header.copy()
    mini_header["NAXIS2"] = y1 - y0
    mini_header["ZNAXIS2"] = y1 - y0
    mini_header["PCOUNT"] = len(blocos)
    mini_header.remove("THEAP", ignore_missing=True)
    mini_tabela = np.stack([tamanhos, posicoes - comeco], axis=1).astype(">i4").tobytes()
    dados = mini_tabela + blocos
    dados += b"\0" * (-len(dados) % BLOCO_FITS)
    mini_fits = fits.PrimaryHDU().header.tostring().encode("ascii") + mini_header.tostring().encode("ascii") + dados
    with fits.open(io.BytesIO(mini_fits)) as hdul:
        return np.array(hdul[1].data)


def carregar_parcial(url: str, coord: SkyCoord, tamanho):
    """
    Lê do S3 só o que o recorte precisa, sem baixar nem guardar o arquivo (~5 MB em vez de ~65 MB).

    Um FITS do SPHEREx é uma fila de camadas (IMAGE, FLAGS, VARIANCE, ZODI...), cada uma com um
    cabeçalho de texto seguido da imagem linha a linha. Lendo os cabeçalhos sabemos onde cada
    camada começa; com o WCS sabemos em que linhas o alvo está; e pedimos só essas linhas.
    Devolve (imagem sem luz zodiacal, cabeçalho da IMAGE, flags, nomes das flags), no tamanho
    original do detector, com NaN (ou 0 nas flags) nas linhas que não foram baixadas.
    """
    with requests.Session() as sessao:  # uma conexão só para todos os pedidos deste arquivo
        camadas = {}
        posicao = 0
        for _ in range(8):
            header, inicio_dados = _ler_header(sessao, url, posicao)
            camadas[str(header.get("EXTNAME", "PRIMARY")).strip()] = (header, inicio_dados)
            posicao = inicio_dados + _tamanho_dados(header)
            if all(nome in camadas for nome in ("IMAGE", "FLAGS", "ZODI")):
                break
        if "IMAGE" not in camadas or "ZODI" not in camadas:
            raise RuntimeError("camadas IMAGE/ZODI não encontradas")

        header_imagem = camadas["IMAGE"][0]
        nx, ny = header_imagem["NAXIS1"], header_imagem["NAXIS2"]
        wcs = WCS(header_imagem)
        _, y = wcs.world_to_pixel(coord)
        graus_por_pixel = float(np.mean(proj_plane_pixel_scales(wcs)))
        meia_altura = int(np.ceil(tamanho.to_value(u.deg) / graus_por_pixel / 2)) + 4
        y0 = max(0, int(round(float(y))) - meia_altura)
        y1 = min(ny, int(round(float(y))) + meia_altura + 1)
        if y1 <= y0:
            raise RuntimeError("o alvo ficou fora da imagem")

        def linhas(nome: str, vazio):
            header, inicio = camadas[nome]
            if (header["NAXIS1"], header["NAXIS2"]) != (nx, ny) or header.get("BSCALE", 1) != 1:
                raise RuntimeError(f"camada {nome} num formato inesperado")
            tipo = np.dtype(TIPOS_FITS[header["BITPIX"]])
            bruto = _ler_faixa(sessao, url, inicio + y0 * nx * tipo.itemsize, inicio + y1 * nx * tipo.itemsize)
            completo = np.full((ny, nx), vazio, dtype=np.float64 if isinstance(vazio, float) else np.int64)
            completo[y0:y1] = np.frombuffer(bruto, dtype=tipo).reshape(y1 - y0, nx)
            # BZERO: o FITS guarda inteiros sem sinal (caso das FLAGS) somando um deslocamento fixo
            deslocamento = header.get("BZERO", 0)
            if deslocamento:
                completo[y0:y1] += type(vazio)(deslocamento)
            return completo

        dados = linhas("IMAGE", np.nan) - linhas("ZODI", np.nan)  # tira o brilho da luz zodiacal

        flags, nomes = None, {}
        if "FLAGS" in camadas:
            header_flags, inicio_flags = camadas["FLAGS"]
            nomes = nomes_das_flags(header_flags)
            if header_flags.get("ZIMAGE"):
                flags = np.zeros((ny, nx), dtype=np.int64)
                flags[y0:y1] = _ler_linhas_comprimidas(sessao, url, header_flags, inicio_flags, y0, y1)
            else:
                flags = linhas("FLAGS", 0)

    return dados, header_imagem, flags, nomes


def carregar_inteiro(caminho: str):
    """Lê um FITS inteiro do disco. Devolve o mesmo que carregar_parcial."""
    with fits.open(caminho) as hdul:
        imagem = hdul["IMAGE"]
        dados = imagem.data.astype(np.float64)
        if "ZODI" in hdul:
            dados = dados - hdul["ZODI"].data  # tira o brilho da luz zodiacal
        flags = np.array(hdul["FLAGS"].data) if "FLAGS" in hdul else None
        nomes = nomes_das_flags(hdul["FLAGS"].header) if "FLAGS" in hdul else {}
        return dados, imagem.header.copy(), flags, nomes


def carregar_inteiro_temporario(links):
    """Reserva: baixa o FITS inteiro para uma pasta temporária, lê e apaga em seguida."""
    pasta_temporaria = tempfile.mkdtemp(prefix="spherex_")
    caminho = os.path.join(pasta_temporaria, "exposicao.fits")
    try:
        ultimo_erro = None
        for link in links:
            try:
                with urllib.request.urlopen(link, timeout=DOWNLOAD_TIMEOUT_S) as resposta, open(caminho, "wb") as arquivo:
                    shutil.copyfileobj(resposta, arquivo)
                return carregar_inteiro(caminho)
            except Exception as e:
                ultimo_erro = e
        raise ultimo_erro
    finally:
        shutil.rmtree(pasta_temporaria, ignore_errors=True)


def carregar_epoca(linha, banda: str, pasta: str, coord: SkyCoord, tamanho):
    """Traz os dados de uma exposição pelo caminho mais rápido disponível."""
    # 1. Já existe guardado em dados_fits/nasa/<coordenada>/ (alvos pré-baixados): não usa a rede
    guardado = os.path.join(pasta, nome_seguro(f"{linha['obs_id']}_{banda}") + ".fits")
    if os.path.exists(guardado):
        return carregar_inteiro(guardado)

    url = str(linha["access_url"])
    url_s3 = url.replace(PREFIXO_IRSA, PREFIXO_S3) if url.startswith(PREFIXO_IRSA) else url

    # 2. Leitura parcial pelo S3: só os bytes do recorte, nada fica em disco
    try:
        return carregar_parcial(url_s3, coord, tamanho)
    except Exception as e:
        print(f"Leitura parcial falhou ({type(e).__name__}: {e}). A baixar o FITS inteiro (temporário)...")

    # 3. Reserva: arquivo inteiro, temporário
    return carregar_inteiro_temporario(dict.fromkeys([url_s3, url]))


def preparar_epocas_nasa(coord: SkyCoord, fov: float, pasta: str):
    """Caminho principal: imagens reais da região pedida, em datas diferentes e alinhadas."""
    inicio = time.time()
    tabela = buscar_tabela_nasa(coord)
    if tabela is None:
        return [], None
    print(f"Catálogo da NASA: {len(tabela)} exposições em {time.time() - inicio:.1f} s")

    linhas, banda = escolher_epocas(tabela, coord)
    tamanho = min(max(fov, RECORTE_MIN_GRAUS), RECORTE_MAX_GRAUS) * u.deg

    inicio = time.time()
    with ThreadPoolExecutor(max_workers=N_EPOCAS) as pool:
        carregadas = list(pool.map(lambda linha: carregar_epoca(linha, banda, pasta, coord, tamanho), linhas))
    print(f"Dados de {len(carregadas)} época(s) em {time.time() - inicio:.1f} s")

    epocas = []
    wcs_ref, forma_ref = None, None

    for dados, header, flags, nomes in carregadas:
        wcs = WCS(header)

        # Recorta só a região pedida em volta do alvo (o detector inteiro cobre ~3,5°)
        recorte = Cutout2D(dados, coord, tamanho, wcs=wcs, mode="partial", fill_value=np.nan)
        dados, wcs_recorte = recorte.data, recorte.wcs

        # Alinha todas as épocas na grade de pixels da primeira
        if wcs_ref is None:
            wcs_ref, forma_ref = wcs_recorte, dados.shape
        else:
            dados, _ = reproject_interp((dados, wcs_recorte), wcs_ref, shape_out=forma_ref)

        # Avisos de qualidade só em cima do alvo, na imagem original (antes de alinhar)
        avisos = set()
        if flags is not None:
            x, y = wcs.world_to_pixel(coord)
            avisos = flags_no_alvo(flags, nomes, float(x), float(y))

        epocas.append({
            "dados": np.nan_to_num(dados),
            "date": header.get("DATE-OBS", "desconhecida"),
            "flags": avisos,
        })

    return epocas, banda


def preparar_epocas_locais():
    """Plano B: FITS guardados em dados_fits/ (sempre os mesmos, de outra região do céu)."""
    epocas = []
    for idx, caminho in enumerate(sorted(glob.glob("dados_fits/*.fits"))[:N_EPOCAS], start=1):
        with fits.open(caminho) as hdul:
            header = hdul["IMAGE"].header if "IMAGE" in hdul else hdul[1].header
            dados_brutos = hdul["IMAGE"].data if "IMAGE" in hdul else hdul[1].data
            # Estas imagens são de outra região, então não há alvo: olha o centro da imagem
            avisos = set()
            if "FLAGS" in hdul:
                flags = hdul["FLAGS"].data
                avisos = flags_no_alvo(flags, nomes_das_flags(hdul["FLAGS"].header), flags.shape[1] / 2, flags.shape[0] / 2)
            epocas.append({
                "dados": np.nan_to_num(dados_brutos[::2, ::2]),
                "date": header.get("DATE-OBS", f"2025-04-24T18:0{idx}:00"),
                "flags": avisos,
            })
    return epocas


@app.post("/process")
def process_sky(req: SkyRequest):
    try:
        coord = SkyCoord(f"{req.ra} {req.dec}", frame="icrs")
    except Exception:
        raise HTTPException(status_code=400, detail="Coordenadas inválidas.")

    epocas = []
    banda = None
    origem_dados = "NASA_API_LIVE"

    # 1. Caminho principal: exposições reais da NASA para o ponto pedido
    try:
        print(f"A tentar API da NASA para {req.ra}, {req.dec}...")
        # Cada coordenada tem a sua subpasta: dados_fits/nasa/<RA>_<Dec>/
        pasta_alvo = os.path.join(PASTA_NASA, nome_seguro(f"{req.ra.strip()}_{req.dec.strip()}"))
        epocas, banda = preparar_epocas_nasa(coord, req.fov, pasta_alvo)
    except (FuturesTimeout, Exception) as e:
        print(f"NASA indisponível/lenta ({type(e).__name__}: {e}). A usar FITS reais locais...")
        epocas = []

    # 2. Plano B garantido: lê os ficheiros .fits reais da pasta dados_fits/
    if not epocas:
        epocas = preparar_epocas_locais()
        origem_dados = "LOCAL_REAL_FITS"
        banda = None

    if not epocas:
        # Erro de verdade (não 200): assim o C# não guarda uma resposta vazia no cache
        raise HTTPException(status_code=503, detail="Sem dados: a NASA não respondeu e dados_fits/ está vazia.")

    prefixo = nome_seguro(f"{req.ra.strip()}_{req.dec.strip()}_{req.fov}")

    # Apaga PNGs de um processamento anterior desta mesma coordenada (ex.: uma vez o plano B
    # gerou 3 épocas e agora a NASA devolveu 2: a terceira não pode ficar para trás)
    for antigo in glob.glob(os.path.join(OUTPUT_DIR, glob.escape(prefixo) + "_*.png")):
        os.remove(antigo)
    epocas_saida = []
    flags_detectadas = set()
    zscale = ZScaleInterval()

    # 3. Guarda os PNGs na pasta partilhada com o C#
    for idx, epoca in enumerate(epocas, start=1):
        nome_png = f"{prefixo}_epoca_{idx}.png"
        caminho_png = os.path.join(OUTPUT_DIR, nome_png)

        vmin, vmax = zscale.get_limits(epoca["dados"])
        plt.imsave(caminho_png, epoca["dados"], cmap="gray", vmin=vmin, vmax=vmax, origin="lower")

        flags_detectadas |= epoca["flags"]  # junta os avisos de todas as épocas

        epocas_saida.append({
            "date": epoca["date"],
            "fileName": nome_png
        })

    # 4. Gera a imagem subtraída (última época menos a primeira)
    nome_subtraida = None
    primeira, ultima = epocas[0]["dados"], epocas[-1]["dados"]
    if len(epocas) >= 2 and ultima.shape == primeira.shape:
        subtraida = ultima - primeira
        nome_subtraida = f"{prefixo}_subtraida.png"
        caminho_sub = os.path.join(OUTPUT_DIR, nome_subtraida)

        vmin_s, vmax_s = zscale.get_limits(subtraida)
        plt.imsave(caminho_sub, subtraida, cmap="gray", vmin=vmin_s, vmax=vmax_s, origin="lower")

    print(f"Concluído com sucesso via {origem_dados}!")
    return {
        "source": origem_dados,
        "band": banda,
        "epochs": epocas_saida,
        "subtractedFileName": nome_subtraida,
        "contaminationFlags": sorted(flags_detectadas) if flags_detectadas else ["NONE"]
    }
