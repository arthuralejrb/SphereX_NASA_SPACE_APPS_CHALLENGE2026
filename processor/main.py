import os
import re
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


DETECTOR_BANDS = {
    "D1": "0.75–1.11 µm (Banda 1 • Detector D1)",
    "D2": "1.11–1.64 µm (Banda 2 • Detector D2)",
    "D3": "1.64–2.42 µm (Banda 3 • Detector D3)",
    "D4": "2.42–3.82 µm (Banda 4 • Detector D4)",
    "D5": "3.82–4.42 µm (Banda 5 • Detector D5)",
    "D6": "4.42–5.00 µm (Banda 6 • Detector D6)",
}


class SkyRequest(BaseModel):
    ra: str
    dec: str
    fov: float = 0.05


def extrair_banda(header, nome_fonte: str) -> str:
    det = str(header.get("DETECTOR", "")).upper()
    if det in DETECTOR_BANDS:
        return DETECTOR_BANDS[det]
    match = re.search(r"(D[1-6])", f"{header.get('FILENAME', '')}_{nome_fonte}".upper())
    if match:
        return DETECTOR_BANDS[match.group(1)]
    return "0.75–5.00 µm (Infravermelho Próximo • LVF)"


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

    try:
        fontes_fits = buscar_urls_nasa(req.ra, req.dec, req.fov)
    except (FuturesTimeout, Exception) as e:
        print(f"NASA indisponível/lenta ({type(e).__name__}). Usando FITS reais locais...")

    if not fontes_fits:
        fontes_fits = sorted(glob.glob("dados_fits/*.fits"))[:3]
        origem_dados = "LOCAL_REAL_FITS"

    if not fontes_fits:
        return {
            "source": "NONE",
            "band": None,
            "epochs": [],
            "subtractedFileName": None,
            "contaminationFlags": ["NO_FITS_AVAILABLE"],
        }

    safe_ra = re.sub(r"[^a-zA-Z0-9._+-]", "", req.ra.strip())
    safe_dec = re.sub(r"[^a-zA-Z0-9._+-]", "", req.dec.strip())
    prefixo = f"{safe_ra}_{safe_dec}"

    epocas_saida = []
    matrizes = []
    flags_detectadas = set()
    banda_detectada = None
    zscale = ZScaleInterval()

    for idx, fonte in enumerate(fontes_fits, start=1):
        with fits.open(fonte) as hdul:
            header = hdul["IMAGE"].header if "IMAGE" in hdul else hdul[1].header
            dados_brutos = hdul["IMAGE"].data if "IMAGE" in hdul else hdul[1].data
            dados = np.nan_to_num(dados_brutos[::2, ::2])
            data_obs = header.get("DATE-OBS", f"2025-04-24T18:0{idx}:00")

            if not banda_detectada:
                banda_detectada = extrair_banda(header, str(fonte))

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

    nome_subtraida = None
    if len(matrizes) >= 2 and matrizes[-1].shape == matrizes[0].shape:
        subtraida = matrizes[-1] - matrizes[0]
        nome_subtraida = f"{prefixo}_subtraida.png"
        caminho_sub = os.path.join(OUTPUT_DIR, nome_subtraida)

        vmin_s, vmax_s = zscale.get_limits(subtraida)
        plt.imsave(caminho_sub, subtraida, cmap="gray", vmin=vmin_s, vmax=vmax_s, origin="lower")

    return {
        "source": origem_dados,
        "band": banda_detectada,
        "epochs": epocas_saida,
        "subtractedFileName": nome_subtraida,
        "contaminationFlags": list(flags_detectadas) if flags_detectadas else ["NONE"]
    }
