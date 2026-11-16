import os
import io
import re
import glob
import json
import time
import shutil
import tempfile
import threading
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
from scipy.ndimage import map_coordinates, maximum_filter
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

# Ferramentas da tela de análise (estiramento e composição RGB): além dos PNGs, cada busca
# grava os números brutos de cada imagem ("camadas") para o site poder redesenhá-las ao vivo.
# Além das épocas, entra uma imagem de cada um dos outros detectores (outras faixas de cor).
BANDAS_EXTRAS = True

# Faixas de comprimento de onda ("bins") e mapa de cor de cada detector
PASTA_ONDA = os.path.join("dados_fits", "onda")  # mapas de comprimento de onda já lidos (um por detector, ~2 KB)
LADO_DETECTOR = 2040                               # pixels de lado de cada detector do SPHEREx
MAPAS_ONDA = {}                                    # os mesmos mapas, em memória

# Espectro do ponto: o brilho do alvo medido em TODAS as exposições do catálogo (uma cor cada).
# São centenas de leituras pequenas no S3 (~30 s), por isso roda depois de a busca responder,
# em segundo plano, e grava <prefixo>_espectro.json, que o site fica consultando.
ESPECTRO = True
RAIO_ABERTURA_PX = 2.0         # círculo onde a luz do alvo é somada (2 px = ~12")
ANEL_FUNDO_PX = (5.0, 8.0)     # anel em volta, de onde sai o brilho do céu a descontar
MEIA_JANELA_PX = 16            # lê-se só um quadrado de 33 x 33 px em volta do alvo
CUBO_LADO = 21                 # o cubo espectral é uma pilha de imagens de 21 x 21 px (~2') ...
CUBO_PIXEL_ARCSEC = 6.15       # ... com o pixel do tamanho do pixel do SPHEREx, norte para cima
FATOR_REAMOSTRAGEM = 1.25      # ao reamostrar uma imagem o ruído "se espalha"; o erro real é ~25% maior
ALINHAMENTO_FINO = True        # confere o alinhamento pelas estrelas e corrige frações de pixel
ARQUIVO_MODELOS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "modelos_galaxias.json")
ESPECTRO_MAX_EXPOSICOES = 600  # campos profundos têm milhares de exposições: usa uma amostra
ESPECTRO_TRABALHADORES = 32    # leituras ao mesmo tempo
ESPECTROS_EM_CURSO = set()     # prefixos que estão a ser medidos agora
SESSOES = threading.local()    # uma conexão reaproveitada por linha de execução


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


def escolher_bandas(tabela, coord: SkyCoord, banda_principal: str):
    """
    Uma exposição de cada um dos outros detectores (D1..D6), para a composição em cores.
    Cada detector vê uma faixa do infravermelho; fica a exposição em que o alvo está mais
    perto do centro do detector. Devolve [(linha, banda), ...] em ordem de detector.
    """
    bandas = np.asarray(tabela["energy_bandpassname"]).astype(str)
    centros = SkyCoord(np.asarray(tabela["s_ra"], dtype=float) * u.deg,
                       np.asarray(tabela["s_dec"], dtype=float) * u.deg, frame="icrs")
    distancia = coord.separation(centros).deg
    escolhidas = []
    for banda in sorted(set(bandas) - {banda_principal}):
        indices = np.where(bandas == banda)[0]
        escolhidas.append((tabela[int(min(indices, key=lambda i: distancia[i]))], banda))
    return escolhidas


def bins_spherex(lam0=0.75, lam1=5.0):
    """
    Divide o infravermelho do SPHEREx (0,75 a 5 µm) em faixas ("bins") de comprimento de onda.

    Cada faixa tem a largura que o telescópio consegue distinguir naquela cor: a resolução
    R = λ/Δλ vale 41 até 2,42 µm, 35 até 3,82 µm, 110 até 4,42 µm e 130 daí em diante.
    Começa em lam0 e vai multiplicando por (1 + 1/R) até passar de lam1.
    Devolve (bordas das faixas, centro de cada faixa), em µm.
    """
    def R(l):
        return 41 if l < 2.42 else 35 if l < 3.82 else 110 if l < 4.42 else 130
    edges = [lam0]
    while edges[-1] < lam1:
        edges.append(edges[-1] * (1 + 1 / R(edges[-1])))
    edges = np.array(edges)
    return edges, 0.5 * (edges[1:] + edges[:-1])


def _tabela_onda(hdu):
    """Tira da camada WCS-WAVE a grade (X, Y) e os valores [comprimento de onda, largura] em µm."""
    dados = hdu.data
    return (np.array(dados["X"][0], dtype=float), np.array(dados["Y"][0], dtype=float),
            np.array(dados["VALUES"][0], dtype=float))


def _ler_mapa_onda_remoto(url: str):
    """Lê só a camada WCS-WAVE (a última do arquivo, ~2 KB) de um FITS no S3."""
    with requests.Session() as sessao:
        posicao = 0
        for _ in range(12):
            header, inicio = _ler_header(sessao, url, posicao)
            tamanho = _tamanho_dados(header)
            if str(header.get("EXTNAME", "")).strip() == "WCS-WAVE":
                dados = _ler_faixa(sessao, url, inicio, inicio + tamanho)
                mini = fits.PrimaryHDU().header.tostring().encode("ascii") + header.tostring().encode("ascii") + dados
                with fits.open(io.BytesIO(mini)) as hdul:
                    return _tabela_onda(hdul[1])
            posicao = inicio + tamanho
    raise RuntimeError("camada WCS-WAVE não encontrada")


def obter_mapa_onda(banda: str, url: str = None, guardado: str = None):
    """
    Mapa de comprimento de onda de um detector. No SPHEREx o filtro fica colado no detector e
    muda de cor ao longo dele, então cada pixel enxerga sempre a mesma cor: o mapa é igual em
    todas as exposições do mesmo detector (conferido), e basta lê-lo uma vez.
    Procura na memória, depois em disco, depois num FITS guardado e por fim no S3.
    """
    if banda in MAPAS_ONDA:
        return MAPAS_ONDA[banda]
    caminho = os.path.join(PASTA_ONDA, nome_seguro(banda) + ".npz")
    if os.path.exists(caminho):
        with np.load(caminho) as arquivo:
            mapa = (arquivo["x"], arquivo["y"], arquivo["valores"])
    else:
        if guardado and os.path.exists(guardado):
            with fits.open(guardado) as hdul:
                mapa = _tabela_onda(hdul["WCS-WAVE"])
        elif url:
            mapa = _ler_mapa_onda_remoto(url.replace(PREFIXO_IRSA, PREFIXO_S3) if url.startswith(PREFIXO_IRSA) else url)
        else:
            raise RuntimeError(f"sem de onde ler o mapa de {banda}")
        os.makedirs(PASTA_ONDA, exist_ok=True)
        np.savez(caminho, x=mapa[0], y=mapa[1], valores=mapa[2])
    MAPAS_ONDA[banda] = mapa
    return mapa


def onda_no_pixel(mapa, x, y):
    """
    Comprimento de onda e largura de banda (µm) no pixel (x, y), contado a partir de 0.
    A tabela dá os valores numa grade de poucos pontos; entre eles, interpola em linha reta
    (é o que a NASA define; dá o mesmo que o Astropy com a distorção SIP desligada).
    """
    grade_x, grade_y, valores = mapa
    x, y = np.atleast_1d(np.asarray(x, dtype=float)), np.atleast_1d(np.asarray(y, dtype=float))
    saida = np.empty((2, x.size))
    for k in (0, 1):
        # primeiro ao longo de x em cada linha da grade, depois ao longo de y (a tabela conta a partir de 1)
        por_linha = np.array([np.interp(x + 1, grade_x, valores[j, :, k]) for j in range(len(grade_y))])
        saida[k] = [np.interp(y[i] + 1, grade_y, por_linha[:, i]) for i in range(x.size)]
    return saida[0], saida[1]


def pixel_pelos_cantos(regiao: str, coord: SkyCoord):
    """
    Em que pixel do detector o alvo caiu, usando só os 4 cantos da exposição que o catálogo
    informa (assim não é preciso abrir cada arquivo). Projeta cantos e alvo num plano tangente
    ao céu e resolve a transformação que leva os 4 cantos aos 4 cantos do detector.
    Erro medido contra o WCS completo: poucos pixels, desprezível perto da largura de uma faixa.
    """
    numeros = [float(v) for v in re.findall(r"[-+]?\d+\.?\d*(?:[eE][-+]?\d+)?", str(regiao))]
    cantos = np.radians(np.array(numeros[:8]).reshape(4, 2))
    # centro da projeção: média dos cantos como vetores na esfera
    vetores = np.stack([np.cos(cantos[:, 1]) * np.cos(cantos[:, 0]), np.cos(cantos[:, 1]) * np.sin(cantos[:, 0]), np.sin(cantos[:, 1])])
    centro = vetores.mean(axis=1)
    ra0, dec0 = np.arctan2(centro[1], centro[0]), np.arcsin(centro[2] / np.linalg.norm(centro))

    def plano(ra, dec):
        d = np.sin(dec0) * np.sin(dec) + np.cos(dec0) * np.cos(dec) * np.cos(ra - ra0)
        return np.cos(dec) * np.sin(ra - ra0) / d, (np.cos(dec0) * np.sin(dec) - np.sin(dec0) * np.cos(dec) * np.cos(ra - ra0)) / d

    u_c, v_c = plano(cantos[:, 0], cantos[:, 1])
    borda = LADO_DETECTOR - 0.5
    destino = np.array([[-0.5, -0.5], [borda, -0.5], [borda, borda], [-0.5, borda]])  # ordem conferida no catálogo
    # transformação projetiva (8 incógnitas) que leva os 4 cantos do céu aos 4 cantos do detector
    a, b = [], []
    for (uu, vv), (px, py) in zip(zip(u_c, v_c), destino):
        a.append([uu, vv, 1, 0, 0, 0, -px * uu, -px * vv]); b.append(px)
        a.append([0, 0, 0, uu, vv, 1, -py * uu, -py * vv]); b.append(py)
    h = np.linalg.solve(np.array(a), np.array(b))
    uu, vv = plano(coord.ra.rad, coord.dec.rad)
    w = h[6] * uu + h[7] * vv + 1
    return float((h[0] * uu + h[1] * vv + h[2]) / w), float((h[3] * uu + h[4] * vv + h[5]) / w)


def cobertura_espectral(tabela, coord: SkyCoord, pasta: str):
    """
    Em que comprimentos de onda este ponto do céu já foi observado.

    Cada exposição do catálogo viu o alvo num pixel diferente do detector, e portanto numa cor
    diferente. Calcula essa cor para todas as exposições e conta quantas caem em cada faixa de
    bins_spherex(). É a base do espectro do ponto (as medidas de brilho vêm depois).
    """
    bandas = np.asarray(tabela["energy_bandpassname"]).astype(str)
    tempos = np.asarray(tabela["t_min"], dtype=float)
    regioes = [str(r) for r in tabela["s_region"]]
    urls = [str(v) for v in tabela["access_url"]]
    ids = [str(v) for v in tabela["obs_id"]]

    # um mapa por detector (lidos em paralelo na primeira vez; depois vêm do disco)
    primeira = {}
    for i, banda in enumerate(bandas):
        primeira.setdefault(banda, i)

    def carregar(banda):
        i = primeira[banda]
        try:
            return obter_mapa_onda(banda, urls[i], os.path.join(pasta, nome_seguro(f"{ids[i]}_{banda}") + ".fits"))
        except Exception as e:
            print(f"Mapa de comprimento de onda de {banda} indisponível ({type(e).__name__}: {e})")
            return None

    with ThreadPoolExecutor(max_workers=6) as pool:
        mapas = dict(zip(primeira, pool.map(carregar, primeira)))

    amostras = []
    for i, banda in enumerate(bandas):
        if mapas.get(banda) is None:
            continue
        try:
            x, y = pixel_pelos_cantos(regioes[i], coord)
        except Exception:
            continue
        if not (0 <= x <= LADO_DETECTOR - 1 and 0 <= y <= LADO_DETECTOR - 1):
            continue
        onda, largura = onda_no_pixel(mapas[banda], x, y)
        amostras.append((float(onda[0]), float(largura[0]), banda.split("-")[-1], float(tempos[i])))

    bordas, centros = bins_spherex()
    contagem, _ = np.histogram([a[0] for a in amostras], bins=bordas)
    return {
        "edges": [round(float(v), 5) for v in bordas],
        "centers": [round(float(v), 5) for v in centros],
        "counts": [int(v) for v in contagem],
        # uma linha por exposição: [comprimento de onda (µm), largura (µm), detector, data (MJD)]
        "samples": [[round(a[0], 5), round(a[1], 5), a[2], round(a[3], 4)] for a in sorted(amostras)],
    }


def gravar_camada(dados, caminho: str):
    """
    Grava os números brutos de uma imagem para o site: float de 16 bits, linha a linha, com a
    primeira linha no topo (a mesma orientação do PNG). Metade do tamanho de um float comum,
    e com precisão de sobra para desenhar na tela.
    """
    limite = float(np.finfo(np.float16).max)
    np.clip(np.flipud(np.nan_to_num(dados)), -limite, limite).astype("<f2").tofile(caminho)


def _ler_faixa(sessao, url: str, inicio: int, fim: int) -> bytes:
    """Baixa só os bytes [inicio, fim) do arquivo (pedido HTTP "Range")."""
    resposta = sessao.get(url, headers={"Range": f"bytes={inicio}-{fim - 1}"}, timeout=PARCIAL_TIMEOUT_S)
    if resposta.status_code != 206:
        raise RuntimeError(f"o servidor não aceitou a leitura parcial (HTTP {resposta.status_code})")
    return resposta.content


def _ler_header(sessao, url: str, posicao: int, blocos: int = 16, buffer: bytes = b""):
    """
    Lê um cabeçalho FITS que começa em `posicao`. Devolve (header, posição onde começam os dados).
    `buffer` são bytes já baixados a partir de `posicao` (poupa um pedido quando já os temos).
    """
    while len(buffer) < 200 * BLOCO_FITS:
        if len(buffer) < BLOCO_FITS:
            buffer += _ler_faixa(sessao, url, posicao + len(buffer), posicao + len(buffer) + blocos * BLOCO_FITS)
        for inicio in range(0, len(buffer) - BLOCO_FITS + 1, BLOCO_FITS):
            bloco = buffer[inicio:inicio + BLOCO_FITS]
            # O cabeçalho termina no bloco que contém o cartão "END"
            if any(bloco[i:i + 8] == b"END     " for i in range(0, BLOCO_FITS, 80)):
                fim = inicio + BLOCO_FITS
                return fits.Header.fromstring(buffer[:fim].decode("ascii")), posicao + fim
        buffer += _ler_faixa(sessao, url, posicao + len(buffer), posicao + len(buffer) + blocos * BLOCO_FITS)
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


def _ler_linhas_comprimidas(sessao, url: str, header, inicio: int, y0: int, y1: int, tabela_bytes: bytes = None):
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
    if tabela_bytes is None or len(tabela_bytes) < tamanho_tabela:  # quem chama pode já ter baixado a tabela
        tabela_bytes = _ler_faixa(sessao, url, inicio, inicio + tamanho_tabela)
    tabela = np.frombuffer(tabela_bytes[:tamanho_tabela], dtype=">i4").reshape(n_linhas, 2)
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


def _sessao():
    """Conexão desta linha de execução (reaproveitá-la poupa a abertura de uma nova a cada arquivo)."""
    if not hasattr(SESSOES, "sessao"):
        SESSOES.sessao = requests.Session()
    return SESSOES.sessao


def ler_janela(url: str, coord: SkyCoord):
    """
    Lê de uma exposição no S3 só um quadrado de 33 x 33 px em volta do alvo, em três camadas:
    IMAGE (brilho), FLAGS (avisos) e VARIANCE (incerteza). São 6 pedidos pequenos (~0,4 MB).
    Devolve None quando o alvo está fora do detector ou colado na borda.
    """
    sessao = _sessao()
    comeco = _ler_faixa(sessao, url, 0, 16 * BLOCO_FITS)  # traz de uma vez os dois primeiros cabeçalhos
    _, posicao = _ler_header(sessao, url, 0, buffer=comeco)
    header, inicio = _ler_header(sessao, url, posicao, buffer=comeco[posicao:])
    if str(header.get("EXTNAME", "")).strip() != "IMAGE":
        raise RuntimeError("camada IMAGE não encontrada")

    nx, ny = header["NAXIS1"], header["NAXIS2"]
    wcs = WCS(header)
    x, y = (float(v) for v in wcs.world_to_pixel(coord))
    if not (np.isfinite(x) and np.isfinite(y)):
        return None
    meia = MEIA_JANELA_PX
    xc, yc = int(round(x)), int(round(y))
    if not (meia <= xc < nx - meia and meia <= yc < ny - meia):
        return None
    x0, x1, y0, y1 = xc - meia, xc + meia + 1, yc - meia, yc + meia + 1

    def linhas(cabecalho, onde):
        if (cabecalho["NAXIS1"], cabecalho["NAXIS2"]) != (nx, ny) or cabecalho.get("BSCALE", 1) != 1:
            raise RuntimeError("camada num formato inesperado")
        tipo = np.dtype(TIPOS_FITS[cabecalho["BITPIX"]])
        bruto = _ler_faixa(sessao, url, onde + y0 * nx * tipo.itemsize, onde + y1 * nx * tipo.itemsize)
        return np.frombuffer(bruto, dtype=tipo).reshape(y1 - y0, nx)[:, x0:x1].astype(np.float64) + cabecalho.get("BZERO", 0)

    imagem = linhas(header, inicio)

    # FLAGS vem logo depois da IMAGE; o mesmo pedido traz o cabeçalho e a tabela de linhas
    posicao = inicio + _tamanho_dados(header)
    trecho = _ler_faixa(sessao, url, posicao, posicao + 14 * BLOCO_FITS)
    header_flags, inicio_flags = _ler_header(sessao, url, posicao, buffer=trecho)
    if str(header_flags.get("EXTNAME", "")).strip() != "FLAGS":
        raise RuntimeError("camada FLAGS não encontrada")
    if header_flags.get("ZIMAGE"):
        flags = _ler_linhas_comprimidas(sessao, url, header_flags, inicio_flags, y0, y1,
                                        tabela_bytes=trecho[inicio_flags - posicao:])[:, x0:x1]
    else:
        flags = linhas(header_flags, inicio_flags)
    flags = np.asarray(flags).astype(np.int64)

    variancia = None
    header_var, inicio_var = _ler_header(sessao, url, inicio_flags + _tamanho_dados(header_flags), blocos=4)
    if str(header_var.get("EXTNAME", "")).strip() == "VARIANCE":
        variancia = linhas(header_var, inicio_var)

    escalas = proj_plane_pixel_scales(wcs)  # graus por pixel em cada eixo
    return {
        "imagem": imagem, "variancia": variancia, "flags": flags, "nomes": nomes_das_flags(header_flags),
        "x": x - x0, "y": y - y0,          # posição do alvo dentro do quadrado
        "x0": x0, "y0": y0, "wcs": wcs,    # para o cubo: onde o quadrado fica no detector
        "x_detector": x, "y_detector": y,  # e no detector inteiro (é ela que define a cor)
        "area_pixel_sr": float(escalas[0] * escalas[1]) * (np.pi / 180) ** 2,
    }


def fundo_do_anel(imagem, flags, nomes: dict, x: float, y: float):
    """
    Brilho do céu em volta de (x, y): mediana dos pixels de um anel afastado do alvo, sem os
    pixels com aviso (inclusive SOURCE: há outra estrela ali) e sem os muito fora da curva.
    Devolve (fundo, ruído do fundo, nº de pixels usados) ou None.
    """
    ny, nx = imagem.shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    distancia = np.hypot(xx - x, yy - y)
    bits_ruins = sum(1 << bit for bit, nome in nomes.items() if nome != "FULLSAMPLE")
    no_anel = (distancia >= ANEL_FUNDO_PX[0]) & (distancia <= ANEL_FUNDO_PX[1]) & np.isfinite(imagem)
    limpos = no_anel & ((flags & bits_ruins) == 0)
    valores = imagem[limpos] if limpos.sum() >= 20 else imagem[no_anel]
    if valores.size < 20:
        return None
    for _ in range(3):  # joga fora os pontos muito fora da curva (estrelas vizinhas, raios cósmicos)
        mediana = np.median(valores)
        espalhamento = 1.4826 * np.median(np.abs(valores - mediana))
        if espalhamento == 0:
            break
        valores = valores[np.abs(valores - mediana) <= 3 * espalhamento]
    return float(np.median(valores)), float(np.std(valores)), int(valores.size)


def corrigir_erro_reamostragem(mapa_erro, fator_kernel=FATOR_REAMOSTRAGEM):
    """
    Corrige o erro de uma imagem que foi reamostrada (redesenhada noutra grade de pixels).
    A reamostragem mistura pixels vizinhos: a imagem parece mais lisa do que é, e o erro
    calculado pixel a pixel sai pequeno demais. Multiplicar por ~1,25 devolve o erro real.
    """
    return mapa_erro * fator_kernel


def grade_do_cubo(coord: SkyCoord):
    """Posições no céu dos pixels do cubo: quadrado centrado no alvo, norte para cima, leste à esquerda."""
    passos = (np.arange(CUBO_LADO) - CUBO_LADO // 2) * CUBO_PIXEL_ARCSEC
    leste, norte = np.meshgrid(-passos, passos)
    return coord.spherical_offsets_by(leste * u.arcsec, norte * u.arcsec)


def fatia_da_exposicao(janela, mapa, grade, fundo: float, bordas):
    """
    O que uma exposição contribui para o cubo: para cada pixel do cubo, o brilho ali (lido da
    exposição por interpolação), a variância, e em que faixa de cor aquele pedaço do detector
    enxerga. Num mesmo instante, pontos vizinhos do céu são vistos em cores ligeiramente diferentes.
    """
    xs, ys = janela["wcs"].world_to_pixel(grade)  # posição de cada pixel do cubo no detector
    nomes = janela["nomes"]
    bits_ruins = sum(1 << bit for bit, nome in nomes.items() if nome not in FLAGS_INFORMATIVAS)
    imagem = np.where((janela["flags"] & bits_ruins) != 0, np.nan, janela["imagem"] - fundo)
    onde = [ys - janela["y0"], xs - janela["x0"]]
    valores = map_coordinates(imagem, onde, order=1, mode="constant", cval=np.nan)
    if janela["variancia"] is not None:
        variancias = map_coordinates(janela["variancia"], onde, order=1, mode="constant", cval=np.nan)
    else:
        variancias = np.full(valores.shape, np.nan)
    onda, _ = onda_no_pixel(mapa, xs.ravel(), ys.ravel())
    faixas = (np.searchsorted(bordas, onda, side="right") - 1).reshape(valores.shape)
    return faixas, valores, variancias


def construir_cubo(fatias, n_faixas: int, lado: int = CUBO_LADO):
    """
    Cubo espectral: uma imagem pequena do alvo para cada faixa de cor, empilhadas. Cada pixel de
    cada exposição vai para a "gaveta" da sua cor; no fim, cada gaveta é a média do que recebeu.
    Devolve (cubo, erro, nº de medidas), cada um com forma (faixas, lado, lado); NaN onde não há dado.
    O erro já sai com a correção de reamostragem.
    """
    soma, soma_var = np.zeros((n_faixas, lado, lado)), np.zeros((n_faixas, lado, lado))
    quantos = np.zeros((n_faixas, lado, lado), dtype=int)
    linhas, colunas = np.mgrid[0:lado, 0:lado]
    for faixas, valores, variancias in fatias:
        bom = np.isfinite(valores) & np.isfinite(variancias) & (faixas >= 0) & (faixas < n_faixas)
        np.add.at(soma, (faixas[bom], linhas[bom], colunas[bom]), valores[bom])
        np.add.at(soma_var, (faixas[bom], linhas[bom], colunas[bom]), variancias[bom])
        np.add.at(quantos, (faixas[bom], linhas[bom], colunas[bom]), 1)
    com_dado = quantos > 0
    cubo = np.where(com_dado, soma / np.maximum(quantos, 1), np.nan)
    erro = np.where(com_dado, np.sqrt(soma_var) / np.maximum(quantos, 1), np.nan)
    return cubo, corrigir_erro_reamostragem(erro), quantos


def ajustar_z(lam, f, e, t_lam, t_f, zs=np.linspace(0, 3, 601)):
    """
    Redshift: estica o modelo de galáxia (t_lam, t_f) por (1 + z) e mede o quanto ele discorda
    do espectro observado (chi², já com o melhor brilho para cada z). O z de menor chi² é o palpite.
    """
    chi2 = np.full(len(zs), np.inf)
    for k, z in enumerate(zs):
        t = np.interp(lam, t_lam * (1 + z), t_f, left=np.nan, right=np.nan)
        ok = np.isfinite(t)
        if ok.sum() >= 10:
            w = 1 / e[ok]**2
            a = np.sum(f[ok] * t[ok] * w) / np.sum(t[ok]**2 * w)
            chi2[k] = np.sum(w * (f[ok] - a * t[ok])**2) / ok.sum()
    return zs, chi2


def estimar_redshift(lam, f, e):
    """Aplica ajustar_z com os modelos de galáxia disponíveis e devolve o melhor de cada um."""
    lam, f, e = (np.asarray(v, dtype=float) for v in (lam, f, e))
    bom = np.isfinite(f) & np.isfinite(e) & (e > 0)
    if bom.sum() < 15:
        return None
    with open(ARQUIVO_MODELOS, encoding="utf-8") as arquivo:
        biblioteca = json.load(arquivo)
    resultados = []
    for chave, modelo in biblioteca["templates"].items():
        zs, chi2 = ajustar_z(lam[bom], f[bom], e[bom], np.array(modelo["lam"]), np.array(modelo["fnu"]))
        if not np.any(np.isfinite(chi2)):
            continue
        k = int(np.argmin(chi2))
        resultados.append({"template": chave, "name": modelo["name"], "z": round(float(zs[k]), 3), "chi2": float(f"{chi2[k]:.4g}"),
                           "curve": [float(f"{v:.4g}") if np.isfinite(v) else None for v in chi2]})
    if not resultados:
        return None
    resultados.sort(key=lambda r: r["chi2"])
    return {"zMin": 0, "zMax": 3, "steps": 601, "source": biblioteca["source"], "fits": resultados}


def medir_deslocamento(referencia, alvo):
    """
    Quanto `alvo` está deslocado em relação a `referencia`, em pixels, medido pelas estrelas:
    acha as estrelas mais brilhantes da referência, calcula o centro de luz de cada uma nas duas
    imagens e fica com a mediana das diferenças. Devolve (dx, dy, nº de estrelas usadas).
    """
    ref, outra = np.nan_to_num(referencia), np.nan_to_num(alvo)
    validos = ref[ref != 0]
    if validos.size < 100:
        return 0.0, 0.0, 0
    mediana = np.median(validos)
    ruido = 1.4826 * np.median(np.abs(validos - mediana))
    picos = (ref == maximum_filter(ref, size=9)) & (ref > mediana + 15 * ruido)
    picos[:6, :] = picos[-6:, :] = picos[:, :6] = picos[:, -6:] = False
    ys, xs = np.nonzero(picos)
    ordem = np.argsort(ref[ys, xs])[::-1][:60]
    yy, xx = np.mgrid[-3:4, -3:4]
    borda = (np.abs(yy) == 3) | (np.abs(xx) == 3)

    def centro(imagem, x, y):
        caixa = imagem[y - 3:y + 4, x - 3:x + 4]
        if np.any(caixa == 0):
            return None  # pixel sem dado ou estrela saturada
        peso = np.clip(caixa - np.median(caixa[borda]), 0, None)
        if peso.sum() <= 0:
            return None
        return float((peso * xx).sum() / peso.sum()), float((peso * yy).sum() / peso.sum())

    diferencas = []
    for i in ordem:
        a, b = centro(ref, xs[i], ys[i]), centro(outra, xs[i], ys[i])
        if a and b and abs(b[0] - a[0]) < 1.5 and abs(b[1] - a[1]) < 1.5:
            diferencas.append((b[0] - a[0], b[1] - a[1]))
    if len(diferencas) < 5:
        return 0.0, 0.0, len(diferencas)
    dx, dy = np.median(np.array(diferencas), axis=0)
    return float(dx), float(dy), len(diferencas)


def alinhar_imagens(referencia, dados_recorte, wcs_recorte, wcs_ref, forma_ref):
    """
    Alinhamento subpixel. Primeiro leva a imagem para a grade da referência pelas coordenadas
    do céu (WCS). Depois confere pelas estrelas: se sobrou um deslocamento de frações de pixel,
    refaz o passo anterior já compensando-o (uma interpolação só, para não borrar duas vezes).
    Devolve (imagem alinhada, {"dx", "dy", "stars", "residual"} ou None).
    """
    alinhada, _ = reproject_interp((dados_recorte, wcs_recorte), wcs_ref, shape_out=forma_ref)
    if not ALINHAMENTO_FINO or referencia is None:
        return alinhada, None
    try:
        dx, dy, estrelas = medir_deslocamento(referencia, alinhada)
        if estrelas < 5:
            return alinhada, {"dx": None, "dy": None, "stars": estrelas, "residual": None}
        antes = float(np.hypot(dx, dy))
        info = {"dx": round(dx, 3), "dy": round(dy, 3), "stars": estrelas, "residual": round(antes, 3)}
        if antes < 0.02:
            return alinhada, info
        wcs_fino = wcs_ref.deepcopy()
        wcs_fino.wcs.crpix = wcs_fino.wcs.crpix - np.array([dx, dy])
        corrigida, _ = reproject_interp((dados_recorte, wcs_recorte), wcs_fino, shape_out=forma_ref)
        rx, ry, n2 = medir_deslocamento(referencia, corrigida)
        depois = float(np.hypot(rx, ry))
        if n2 >= 5 and depois < antes:  # só fica com a correção se ela de fato melhorou
            info["residual"] = round(depois, 3)
            return corrigida, info
        return alinhada, {**info, "dx": 0.0, "dy": 0.0}
    except Exception as e:
        print(f"Alinhamento fino indisponível ({type(e).__name__}: {e})")
        return alinhada, None


def fotometria_abertura(imagem, variancia, flags, nomes: dict, x: float, y: float, raio: float = RAIO_ABERTURA_PX):
    """
    Mede o brilho de um ponto: soma a luz dentro de um círculo de raio `raio` em volta de (x, y)
    e desconta o brilho do céu, estimado num anel mais afastado (que também leva embora a luz
    zodiacal). Devolve (brilho, incerteza) na unidade da imagem vezes pixel, ou None se não der.

    Pixels cortados pela borda do círculo entram pela fração que fica dentro dele.
    """
    ceu = fundo_do_anel(imagem, flags, nomes, x, y)
    if ceu is None:
        return None
    fundo, ruido_fundo, n_fundo = ceu
    ny, nx = imagem.shape
    yy, xx = np.mgrid[0:ny, 0:nx]

    # Fração de cada pixel dentro do círculo (cada pixel dividido em 5 x 5 pedaços)
    passos = (np.arange(5) + 0.5) / 5 - 0.5
    peso = np.zeros(imagem.shape)
    for dy in passos:
        for dx in passos:
            peso += np.hypot(xx + dx - x, yy + dy - y) <= raio
    peso /= passos.size ** 2
    dentro = peso > 0
    if not np.all(np.isfinite(imagem[dentro])):
        return None

    brilho = float(np.sum(peso[dentro] * (imagem[dentro] - fundo)))
    var_pixels = variancia[dentro] if variancia is not None else np.full(dentro.sum(), np.nan)
    var_pixels = np.where(np.isfinite(var_pixels) & (var_pixels > 0), var_pixels, ruido_fundo ** 2)
    # incerteza: a de cada pixel somada, mais a de ter estimado o fundo com um número finito de pixels
    var_total = np.sum(peso[dentro] ** 2 * var_pixels) + peso.sum() ** 2 * ruido_fundo ** 2 / n_fundo
    return brilho, float(np.sqrt(var_total))


# Regras do "tradutor": (id, faixa da feição, janelas vizinhas de comparação, tipo, limiar, título, explicação)
FEICOES = [
    ("water-1.4", (1.35, 1.45), ((1.24, 1.31), (1.55, 1.68)), "absorcao", 0.85,
     "Assinatura de água (~1,4 µm)",
     "O brilho cai nesta cor em relação às cores vizinhas. É característico de estrelas frias, anãs marrons ou atmosferas planetárias."),
    ("water-1.9", (1.82, 1.98), ((1.60, 1.72), (2.10, 2.25)), "absorcao", 0.85,
     "Assinatura de água (~1,9 µm)",
     "Segunda faixa em que o vapor de água absorve luz. Junto com a de 1,4 µm, reforça que se trata de um objeto frio."),
    ("pah-3.3", (3.25, 3.35), ((3.10, 3.20), (3.50, 3.60)), "emissao", 1.10,
     "Emissão de PAH (~3,3 µm)",
     "Há um pico de brilho nesta cor: poeira rica em hidrocarbonetos iluminada por radiação ultravioleta, típica de regiões de formação de estrelas."),
]


def traduzir_espectro(lam, fluxo, erro=None):
    """
    Lê o espectro (um valor por faixa de cor) e devolve frases simples sobre o que ele mostra.

    Cada regra compara o brilho médio numa faixa com o "contínuo": o brilho esperado ali se não
    houvesse nada de especial, tirado das cores vizinhas dos dois lados (linha reta entre elas).
    Absorção = a faixa fica abaixo de 85% do contínuo; emissão = acima de 110%.
    Com as incertezas, exige também que a diferença seja maior que 3 vezes o erro.
    """
    lam, fluxo = np.asarray(lam, dtype=float), np.asarray(fluxo, dtype=float)
    erro = np.asarray(erro, dtype=float) if erro is not None else None
    bom = np.isfinite(lam) & np.isfinite(fluxo)

    def media(faixa):
        """Média do brilho numa faixa: (comprimento de onda médio, brilho médio, erro da média) ou None."""
        m = bom & (lam > faixa[0]) & (lam < faixa[1])
        if not np.any(m):
            return None
        e = float(np.sqrt(np.sum(erro[m] ** 2)) / m.sum()) if erro is not None else 0.0
        return float(np.mean(lam[m])), float(np.mean(fluxo[m])), e

    if bom.sum() < 5:
        return [{"id": "no-data", "title": "Sem medidas suficientes",
                 "text": "Não há pontos suficientes no espectro para interpretá-lo."}]
    if erro is not None and np.nanmedian(fluxo[bom] / erro[bom]) < 5:
        return [{"id": "faint", "title": "Sinal fraco demais",
                 "text": "O brilho medido neste ponto mal se distingue do ruído do céu; qualquer interpretação seria chute."}]

    diagnosticos = []
    for ident, faixa, (esquerda, direita), tipo, limiar, titulo, texto in FEICOES:
        centro, lado_a, lado_b = media(faixa), media(esquerda), media(direita)
        if not (centro and lado_a and lado_b):
            continue  # o alvo não foi observado nesta cor ou nas vizinhas
        t = (centro[0] - lado_a[0]) / (lado_b[0] - lado_a[0])
        continuo = lado_a[1] + t * (lado_b[1] - lado_a[1])
        erro_total = float(np.sqrt(centro[2] ** 2 + ((1 - t) * lado_a[2]) ** 2 + (t * lado_b[2]) ** 2))
        if continuo <= 3 * erro_total:
            continue  # sem brilho de referência confiável
        razao = centro[1] / continuo
        achou = razao < limiar if tipo == "absorcao" else razao > limiar
        if achou and abs(centro[1] - continuo) > 3 * erro_total:
            diagnosticos.append({"id": ident, "title": titulo, "text": texto, "ratio": round(razao, 3)})

    if not diagnosticos:
        diagnosticos.append({"id": "continuum", "title": "Espectro contínuo",
                             "text": "Sem feições moleculares óbvias: o brilho varia suavemente de cor para cor, "
                                     "como em estrelas quentes ou num contínuo estelar comum."})
    return diagnosticos


def medir_espectro(tabela, coord: SkyCoord, ao_progredir=None):
    """
    Espectro de um ponto do céu: o brilho do alvo em cada exposição do catálogo.

    Cada exposição viu o alvo num pixel diferente do detector e, portanto, numa cor diferente.
    Para cada uma: lê um quadradinho em volta do alvo, mede o brilho (fotometria de abertura) e
    olha no mapa do detector qual era a cor ali. Depois junta as medidas pelas faixas de
    bins_spherex() (mediana das medidas sem avisos de qualidade).
    """
    bandas = np.asarray(tabela["energy_bandpassname"]).astype(str)
    tempos = np.asarray(tabela["t_min"], dtype=float)
    urls = [str(v) for v in tabela["access_url"]]
    urls = [v.replace(PREFIXO_IRSA, PREFIXO_S3) if v.startswith(PREFIXO_IRSA) else v for v in urls]

    indices = np.argsort(tempos)
    if len(indices) > ESPECTRO_MAX_EXPOSICOES:  # amostra espalhada no tempo
        indices = indices[np.linspace(0, len(indices) - 1, ESPECTRO_MAX_EXPOSICOES).round().astype(int)]

    bordas, centros = bins_spherex()
    grade = grade_do_cubo(coord)

    def medir(i):
        """Devolve (medida do brilho | "saturada" | None, fatia para o cubo | None)."""
        try:
            janela = ler_janela(urls[i], coord)
            if janela is None:
                return None, None
            mapa = obter_mapa_onda(bandas[i], urls[i])
            ceu = fundo_do_anel(janela["imagem"], janela["flags"], janela["nomes"], janela["x"], janela["y"])
            fatia = fatia_da_exposicao(janela, mapa, grade, ceu[0], bordas) if ceu else None
            medida = fotometria_abertura(janela["imagem"], janela["variancia"], janela["flags"], janela["nomes"],
                                         janela["x"], janela["y"])
            if medida is None:
                # com céu medido mas sem brilho: há pixels sem valor em cima do alvo (estrela saturada)
                return ("saturada" if ceu else None), fatia
            onda, largura = onda_no_pixel(mapa, janela["x_detector"], janela["y_detector"])
            para_mjy = janela["area_pixel_sr"] * 1e9  # MJy/sr x área do pixel (sr) = MJy; x 1e9 = mJy
            avisos = sorted(flags_no_alvo(janela["flags"], janela["nomes"], janela["x"], janela["y"]))
            return (float(onda[0]), float(largura[0]), medida[0] * para_mjy, medida[1] * para_mjy,
                    bandas[i].split("-")[-1], float(tempos[i]), avisos), fatia
        except Exception as e:
            return e

    pontos, fatias, saturadas, falhas, feitas, ultimo_aviso = [], [], 0, 0, 0, 0.0
    with ThreadPoolExecutor(max_workers=ESPECTRO_TRABALHADORES) as pool:
        for resultado in pool.map(medir, indices):
            feitas += 1
            if isinstance(resultado, Exception):
                falhas += 1
                if falhas <= 3:
                    print(f"Espectro: exposição falhou ({type(resultado).__name__}: {resultado})")
            else:
                ponto, fatia = resultado
                if fatia is not None:
                    fatias.append(fatia)
                if ponto == "saturada":
                    saturadas += 1
                elif ponto is not None:
                    pontos.append(ponto)
            if ao_progredir and time.time() - ultimo_aviso > 1:
                ultimo_aviso = time.time()
                ao_progredir(feitas, len(indices))
    pontos.sort(key=lambda p: p[0])

    # Junta por faixa de cor. Medidas com aviso de qualidade só entram se a faixa não tiver outra.
    ondas = np.array([p[0] for p in pontos])
    faixas = []
    for k in range(len(centros)):
        na_faixa = [p for p, onda in zip(pontos, ondas) if bordas[k] <= onda < bordas[k + 1]]
        limpas = [p for p in na_faixa if not p[6]]
        usadas = limpas or na_faixa
        if not usadas:
            continue
        brilhos, erros = np.array([p[2] for p in usadas]), np.array([p[3] for p in usadas])
        erro = float(np.median(erros) / np.sqrt(len(usadas)))
        if len(usadas) >= 3:  # se as medidas discordam mais que o erro previsto, vale a discordância
            erro = max(erro, float(1.4826 * np.median(np.abs(brilhos - np.median(brilhos))) / np.sqrt(len(usadas))))
        faixas.append((float(centros[k]), float(np.median(brilhos)), erro, len(usadas), not limpas))

    def arredondar(valor):
        return float(f"{valor:.4g}")

    # Para interpretar (tradutor e redshift) valem as faixas sem aviso, desde que cubram quase todo o
    # espectro; se os avisos atingem muitas faixas (alvo brilhante), usar só as limpas deixaria de fora
    # justamente as cores que têm as feições, então entram todas.
    limpas = [f for f in faixas if not f[4]]
    confiaveis = limpas if len(limpas) >= 0.8 * len(faixas) else faixas
    redshift = None
    try:
        redshift = estimar_redshift([f[0] for f in confiaveis], [f[1] for f in confiaveis], [f[2] for f in confiaveis])
    except Exception as e:
        print(f"Redshift indisponível ({type(e).__name__}: {e})")
    cubo = construir_cubo(fatias, len(centros)) if fatias else None
    return {
        "status": "done",
        "unit": "mJy",
        "apertureRadiusPx": RAIO_ABERTURA_PX,
        "exposures": int(len(indices)),
        "failed": falhas,
        "saturated": saturadas,
        "redshift": redshift,
        "_cubo": cubo,  # (cubo, erro, contagem): gravado à parte, não vai para o JSON
        # uma linha por exposição: [comprimento de onda (µm), largura (µm), brilho, erro, detector, data (MJD), avisos]
        "points": [[round(p[0], 5), round(p[1], 5), arredondar(p[2]), arredondar(p[3]), p[4], round(p[5], 4), p[6]] for p in pontos],
        # uma linha por faixa de cor: [centro (µm), brilho, erro, nº de medidas, só havia medidas com aviso?]
        "bins": [[round(f[0], 5), arredondar(f[1]), arredondar(f[2]), f[3], f[4]] for f in faixas],
        "diagnostics": traduzir_espectro([f[0] for f in confiaveis], [f[1] for f in confiaveis], [f[2] for f in confiaveis]),
    }


def gravar_cubo(cubo_erro_contagem, prefixo: str):
    """Grava o cubo (<prefixo>_cubo.bin, float de 16 bits, primeira linha no topo) e devolve a sua ficha."""
    cubo, erro, quantos = cubo_erro_contagem
    limite = float(np.finfo(np.float16).max)
    nome = f"{prefixo}_cubo.bin"
    np.clip(np.nan_to_num(cubo[:, ::-1, :]), -limite, limite).astype("<f2").tofile(os.path.join(OUTPUT_DIR, nome))
    fatias = []
    for k in range(cubo.shape[0]):
        com_dado = quantos[k] > 0
        fatias.append({
            "coverage": round(float(com_dado.mean()), 3),            # fração da imagem com dado
            "exposures": int(quantos[k].max()),                       # até quantas medidas por pixel
            "noise": float(f"{np.median(erro[k][com_dado]):.4g}") if com_dado.any() else None,  # MJy/sr
        })
    return {"file": nome, "size": int(cubo.shape[1]), "pixelArcsec": CUBO_PIXEL_ARCSEC, "unit": "MJy/sr",
            "noiseFactor": FATOR_REAMOSTRAGEM, "slices": fatias}


def espectro_em_segundo_plano(tabela, coord: SkyCoord, prefixo: str):
    """Mede o espectro depois de a busca ter respondido e grava <prefixo>_espectro.json (com o andamento)."""
    if prefixo in ESPECTROS_EM_CURSO:
        return
    ESPECTROS_EM_CURSO.add(prefixo)
    caminho = os.path.join(OUTPUT_DIR, f"{prefixo}_espectro.json")

    def gravar(conteudo):
        # grava num arquivo ao lado e troca de uma vez, para o site nunca ler um arquivo pela metade
        with open(caminho + ".tmp", "w", encoding="utf-8") as arquivo:
            json.dump(conteudo, arquivo)
        os.replace(caminho + ".tmp", caminho)

    def trabalho():
        inicio = time.time()
        try:
            gravar({"status": "running", "done": 0, "total": int(min(len(tabela), ESPECTRO_MAX_EXPOSICOES))})
            resultado = medir_espectro(tabela, coord, lambda feitas, total: gravar({"status": "running", "done": feitas, "total": total}))
            cubo = resultado.pop("_cubo", None)
            resultado["cube"] = gravar_cubo(cubo, prefixo) if cubo else None
            gravar(resultado)
            print(f"Espectro: {len(resultado['points'])} medidas em {len(resultado['bins'])} faixas ({time.time() - inicio:.1f} s)")
        except Exception as e:
            print(f"Espectro falhou ({type(e).__name__}: {e})")
            try:
                gravar({"status": "failed"})
            except Exception:
                pass
        finally:
            ESPECTROS_EM_CURSO.discard(prefixo)

    threading.Thread(target=trabalho, daemon=True).start()


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
        return [], None, [], None, None
    print(f"Catálogo da NASA: {len(tabela)} exposições em {time.time() - inicio:.1f} s")

    linhas, banda = escolher_epocas(tabela, coord)
    tamanho = min(max(fov, RECORTE_MIN_GRAUS), RECORTE_MAX_GRAUS) * u.deg

    # Em que comprimentos de onda este ponto já foi observado (não baixa imagens: só usa o catálogo)
    espectral = None
    try:
        inicio = time.time()
        espectral = cobertura_espectral(tabela, coord, pasta)
        print(f"Cobertura espectral: {len(espectral['samples'])} exposições em "
              f"{sum(c > 0 for c in espectral['counts'])} de {len(espectral['counts'])} faixas ({time.time() - inicio:.1f} s)")
    except Exception as e:
        print(f"Sem cobertura espectral ({type(e).__name__}: {e})")

    def onda_da_camada(banda_camada, wcs_camada):
        """Comprimento de onda exato do alvo nesta exposição (usa o WCS completo dela)."""
        try:
            x, y = wcs_camada.world_to_pixel(coord)
            onda, largura = onda_no_pixel(obter_mapa_onda(banda_camada), float(x), float(y))
            return round(float(onda[0]), 5), round(float(largura[0]), 5)
        except Exception:
            return None, None

    # Outras faixas de cor (uma exposição por detector), baixadas junto com as épocas
    extras = []
    if BANDAS_EXTRAS:
        try:
            extras = escolher_bandas(tabela, coord, banda)
        except Exception as e:
            print(f"Sem bandas extras ({type(e).__name__}: {e})")

    def carregar_extra(par):
        linha, banda_extra = par
        try:
            return carregar_epoca(linha, banda_extra, pasta, coord, tamanho)
        except Exception as e:  # uma banda a menos não pode derrubar a busca
            print(f"Banda {banda_extra} indisponível ({type(e).__name__}: {e})")
            return None

    inicio = time.time()
    with ThreadPoolExecutor(max_workers=N_EPOCAS + max(len(extras), 1)) as pool:
        futuras_extras = [pool.submit(carregar_extra, par) for par in extras]
        carregadas = list(pool.map(lambda linha: carregar_epoca(linha, banda, pasta, coord, tamanho), linhas))
        carregadas_extras = [f.result() for f in futuras_extras]
    print(f"Dados de {len(carregadas)} época(s) e {sum(c is not None for c in carregadas_extras)} banda(s) extra(s) "
          f"em {time.time() - inicio:.1f} s")

    epocas = []
    wcs_ref, forma_ref = None, None

    for dados, header, flags, nomes in carregadas:
        wcs = WCS(header)

        # Recorta só a região pedida em volta do alvo (o detector inteiro cobre ~3,5°)
        recorte = Cutout2D(dados, coord, tamanho, wcs=wcs, mode="partial", fill_value=np.nan)
        dados, wcs_recorte = recorte.data, recorte.wcs

        # Alinha todas as épocas na grade de pixels da primeira
        deslocamento = None
        if wcs_ref is None:
            wcs_ref, forma_ref, dados_ref = wcs_recorte, dados.shape, dados
        else:
            dados, deslocamento = alinhar_imagens(dados_ref, dados, wcs_recorte, wcs_ref, forma_ref)

        # Avisos de qualidade só em cima do alvo, na imagem original (antes de alinhar)
        avisos = set()
        if flags is not None:
            x, y = wcs.world_to_pixel(coord)
            avisos = flags_no_alvo(flags, nomes, float(x), float(y))

        onda, largura = onda_da_camada(banda, wcs)
        epocas.append({
            "dados": np.nan_to_num(dados),
            "date": header.get("DATE-OBS", "desconhecida"),
            "flags": avisos,
            "wavelength": onda,
            "bandwidth": largura,
            "shift": deslocamento,
        })

    # As outras bandas vão para a mesma grade de pixels das épocas, para poderem ser sobrepostas
    camadas_extras = []
    for (_, banda_extra), carregada in zip(extras, carregadas_extras):
        if carregada is None:
            continue
        try:
            dados, header, _, _ = carregada
            wcs_extra = WCS(header)
            recorte = Cutout2D(dados, coord, tamanho, wcs=wcs_extra, mode="partial", fill_value=np.nan)
            dados, deslocamento = alinhar_imagens(dados_ref, recorte.data, recorte.wcs, wcs_ref, forma_ref)
            if np.isfinite(dados).mean() < 0.2:
                continue  # o alvo ficou na borda deste detector: quase tudo vazio
            onda, largura = onda_da_camada(banda_extra, wcs_extra)
            camadas_extras.append({
                "dados": np.nan_to_num(dados),
                "band": banda_extra,
                "date": header.get("DATE-OBS", "desconhecida"),
                "wavelength": onda,
                "bandwidth": largura,
                "shift": deslocamento,
            })
        except Exception as e:
            print(f"Banda {banda_extra} descartada ({type(e).__name__}: {e})")

    return epocas, banda, camadas_extras, espectral, tabela


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
    camadas_extras = []
    espectral = None
    tabela = None
    banda = None
    origem_dados = "NASA_API_LIVE"

    # 1. Caminho principal: exposições reais da NASA para o ponto pedido
    try:
        print(f"A tentar API da NASA para {req.ra}, {req.dec}...")
        # Cada coordenada tem a sua subpasta: dados_fits/nasa/<RA>_<Dec>/
        pasta_alvo = os.path.join(PASTA_NASA, nome_seguro(f"{req.ra.strip()}_{req.dec.strip()}"))
        epocas, banda, camadas_extras, espectral, tabela = preparar_epocas_nasa(coord, req.fov, pasta_alvo)
    except (FuturesTimeout, Exception) as e:
        print(f"NASA indisponível/lenta ({type(e).__name__}: {e}). A usar FITS reais locais...")
        epocas = []

    # 2. Plano B garantido: lê os ficheiros .fits reais da pasta dados_fits/
    if not epocas:
        epocas = preparar_epocas_locais()
        origem_dados = "LOCAL_REAL_FITS"
        banda = None
        camadas_extras = []
        espectral = None
        tabela = None

    if not epocas:
        # Erro de verdade (não 200): assim o C# não guarda uma resposta vazia no cache
        raise HTTPException(status_code=503, detail="Sem dados: a NASA não respondeu e dados_fits/ está vazia.")

    prefixo = nome_seguro(f"{req.ra.strip()}_{req.dec.strip()}_{req.fov}")

    # Apaga os arquivos de um processamento anterior desta mesma coordenada (ex.: uma vez o
    # plano B gerou 3 épocas e agora a NASA devolveu 2: a terceira não pode ficar para trás)
    for extensao in ("png", "bin", "json"):
        for antigo in glob.glob(os.path.join(OUTPUT_DIR, glob.escape(prefixo) + f"_*.{extensao}")):
            os.remove(antigo)
    camadas = []  # lista do que o site pode usar nas ferramentas de imagem

    def registrar_camada(dados, nome: str, tipo: str, banda_camada, origem: dict):
        gravar_camada(dados, os.path.join(OUTPUT_DIR, nome))
        camadas.append({"file": nome, "kind": tipo, "band": banda_camada, "date": origem["date"],
                        "wavelength": origem.get("wavelength"), "bandwidth": origem.get("bandwidth"), "shift": origem.get("shift"),
                        "width": int(dados.shape[1]), "height": int(dados.shape[0])})
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
        registrar_camada(epoca["dados"], f"{prefixo}_epoca_{idx}.bin", "epoch", banda, epoca)

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

    # 5. Camadas das outras bandas e a lista de tudo (lida pelo site a partir do nome do PNG)
    for extra in camadas_extras:
        detector = nome_seguro(extra["band"].split("-")[-1])
        registrar_camada(extra["dados"], f"{prefixo}_banda_{detector}.bin", "band", extra["band"], extra)
    with open(os.path.join(OUTPUT_DIR, f"{prefixo}_camadas.json"), "w", encoding="utf-8") as arquivo:
        json.dump({"format": "float16-le", "source": origem_dados, "layers": camadas, "spectral": espectral}, arquivo)

    # 6. Espectro do ponto: começa agora e continua depois de a resposta sair (o site acompanha pelo arquivo)
    if ESPECTRO and tabela is not None:
        espectro_em_segundo_plano(tabela, coord, prefixo)

    print(f"Concluído com sucesso via {origem_dados}!")
    return {
        "source": origem_dados,
        "band": banda,
        "epochs": epocas_saida,
        "subtractedFileName": nome_subtraida,
        "contaminationFlags": sorted(flags_detectadas) if flags_detectadas else ["NONE"]
    }
