import os
import glob
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel
from astropy.io import fits
from astropy.coordinates import SkyCoord
import astropy.units as u
from astropy.visualization import ZScaleInterval
from astroquery.ipac.irsa import Irsa
import matplotlib.pyplot as plt

app = FastAPI()

OUTPUT_DIR = os.getenv("OUTPUT_DIR", "/app/images")
os.makedirs(OUTPUT_DIR, exist_ok=True)

class SkyRequest(BaseModel):
    ra: str
    dec: str
    fov: float = 0.05

def _consultar_irsa(ra: str, dec: str, fov: float):
    coord = SkyCoord(f"{ra} {dec}", frame="icrs")
    tabela = Irsa.query_sia(pos=(coord, fov * u.deg), collection="spherex_dr1")

    if len(tabela) == 0:
        tabela = Irsa.query_sia(pos=(coord, fov * u.deg), collection="spherex_qr3")

    if len(tabela) == 0:
        return []

    if "t_min" in tabela.colnames:
        tabela.sort("t_min")

    return list(tabela["access_url"][:3])

def buscar_urls_nasa(ra: str, dec: str, fov: float):
    """Corta a tentativa à NASA ao fim de 4 segundos exatos."""
    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(_consultar_irsa, ra, dec, fov)
    try:
        return future.result(timeout=4)
    finally:
        executor.shutdown(wait=False, cancel_futures=True)

@app.post("/process")
def process_sky(req: SkyRequest):
    fontes_fits = []
    origem_dados = "NASA_API_LIVE"

    # 1. Tenta consultar a NASA durante no máximo 4 segundos
    try:
        print(f"A tentar API da NASA para {req.ra}, {req.dec}...")
        fontes_fits = buscar_urls_nasa(req.ra, req.dec, req.fov)
    except (FuturesTimeout, Exception) as e:
        print(f"NASA indisponível/lenta ({type(e).__name__}). A usar FITS reais locais...")

    # 2. Plano B garantido: lê os ficheiros .fits reais da pasta dados_fits/
    if not fontes_fits:
        fontes_fits = sorted(glob.glob("dados_fits/*.fits"))[:3]
        origem_dados = "LOCAL_REAL_FITS"

    if not fontes_fits:
        return {"error": "Nenhum ficheiro FITS encontrado em dados_fits/."}

    prefixo = req.ra.replace(" ", "").replace(":", "-")[:10]
    epocas_saida = []
    matrizes = []
    flags_detectadas = set()
    zscale = ZScaleInterval()

    # 3. Processa os FITS reais e guarda os PNGs na pasta partilhada com o C#
    for idx, fonte in enumerate(fontes_fits, start=1):
        with fits.open(fonte) as hdul:
            header = hdul["IMAGE"].header if "IMAGE" in hdul else hdul[1].header
            dados_brutos = hdul["IMAGE"].data if "IMAGE" in hdul else hdul[1].data
            dados = np.nan_to_num(dados_brutos[::2, ::2])
            data_obs = header.get("DATE-OBS", f"2025-04-24T18:0{idx}:00")

            if "FLAGS" in hdul and np.any(hdul["FLAGS"].data > 0):
                flags_detectadas.add("DETECTOR_ARTIFACT_OR_COSMIC_RAY")

        nome_png = f"{prefixo}_epoca_{idx}.png"
        caminho_png = os.path.join(OUTPUT_DIR, nome_png)

        vmin, vmax = zscale.get_limits(dados)
        plt.imsave(caminho_png, dados, cmap="gray", vmin=vmin, vmax=vmax, origin="lower")

        matrizes.append(dados)
        epocas_saida.append({
            "date": data_obs,
            "fileName": nome_png
        })

    # 4. Gera a imagem subtraída
    nome_subtraida = None
    if len(matrizes) >= 2 and matrizes[-1].shape == matrizes[0].shape:
        subtraida = matrizes[-1] - matrizes[0]
        nome_subtraida = f"{prefixo}_subtraida.png"
        caminho_sub = os.path.join(OUTPUT_DIR, nome_subtraida)

        vmin_s, vmax_s = zscale.get_limits(subtraida)
        plt.imsave(caminho_sub, subtraida, cmap="gray", vmin=vmin_s, vmax=vmax_s, origin="lower")

    print(f"Concluído com sucesso via {origem_dados}!")
    return {
        "source": origem_dados,
        "epochs": epocas_saida,
        "subtractedFileName": nome_subtraida,
        "contaminationFlags": list(flags_detectadas) if flags_detectadas else ["NONE"]
    }
