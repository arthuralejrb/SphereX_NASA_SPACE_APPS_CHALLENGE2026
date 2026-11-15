import json
import os
import re
import glob
import urllib.request
import xml.etree.ElementTree as ET
import numpy as np
import pyvo
from fastapi import BackgroundTasks, FastAPI
from pydantic import BaseModel
from astropy.io import fits
from astropy.coordinates import SkyCoord
from astropy.visualization import ZScaleInterval
import matplotlib.pyplot as plt

app = FastAPI()

OUTPUT_DIR = os.getenv("OUTPUT_DIR", "/app/images")
FITS_BASE_DIR = "dados_fits"
TAP_URL = "https://irsa.ipac.caltech.edu/TAP"

os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(FITS_BASE_DIR, exist_ok=True)

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


def _resolver_url_fits(access_url: str) -> str | None:
    if ".fits" in access_url.lower():
        return access_url
    try:
        xml_bytes = urllib.request.urlopen(access_url, timeout=15).read()
        root = ET.fromstring(xml_bytes)
        for td in root.iter():
            if td.tag.endswith("TD") and td.text and ".fits" in td.text.lower():
                return td.text.strip()
    except Exception:
        pass
    return None


def consultar_irsa_ao_vivo(ra: str, dec: str) -> list[str]:
    coord = SkyCoord(f"{ra} {dec}", frame="icrs")
    service = pyvo.dal.TAPService(TAP_URL)
    adql = f"""
    SELECT TOP 12 t_min, calib_level, access_url
    FROM spherex.obscore
    WHERE 1 = CONTAINS(POINT('ICRS', {coord.ra.deg:.6f}, {coord.dec.deg:.6f}), s_region)
    """
    job = service.submit_job(adql)
    job.run()
    job.wait(phases=["COMPLETED", "ERROR", "ABORTED"], timeout=45)

    if job.phase != "COMPLETED":
        return []

    tabela = job.fetch_result().to_table()
    job.delete()

    if len(tabela) == 0:
        return []

    linhas = sorted(
        tabela,
        key=lambda r: (0 if int(r["calib_level"] or 0) == 2 else 1, float(r["t_min"] or 0.0)),
    )

    urls = []
    tempos_vistos = set()
    for row in linhas:
        raw_url = str(row["access_url"] or "").strip()
        if not raw_url:
            continue
        fits_url = _resolver_url_fits(raw_url)
        if not fits_url:
            continue
        t_chave = round(float(row["t_min"] or 0.0), 4)
        if t_chave not in tempos_vistos and fits_url not in urls:
            tempos_vistos.add(t_chave)
            urls.append(fits_url)
        if len(urls) >= 3:
            break
    return urls


def inspecionar_flags_em_background(fontes: list[str], pasta_alvo: str):
    """Etapa 2 (Background): lê apenas a camada FLAGS via Range Request sem travar a UI."""
    os.makedirs(pasta_alvo, exist_ok=True)
    flags_encontradas = set()

    for fonte in fontes:
        try:
            is_remoto = fonte.startswith("http")
            kwargs = {"use_fsspec": True, "fsspec_kwargs": {"cache_type": "bytes"}} if is_remoto else {}
            with fits.open(fonte, **kwargs) as hdul:
                if "FLAGS" in hdul:
                    amostra_flags = hdul["FLAGS"].section[::4, ::4] if is_remoto else hdul["FLAGS"].data
                    if np.any(amostra_flags > 0):
                        flags_encontradas.add("DETECTOR_ARTIFACT_OR_COSMIC_RAY")
        except Exception as e:
            print(f"[Background] Aviso ao ler FLAGS de {fonte}: {e}")

    resultado = list(flags_encontradas) if flags_encontradas else ["NONE"]
    with open(os.path.join(pasta_alvo, "flags.json"), "w", encoding="utf-8") as f:
        json.dump({"contaminationFlags": resultado}, f)


@app.post("/process")
def process_sky(req: SkyRequest, background_tasks: BackgroundTasks):
    safe_ra = re.sub(r"[^a-zA-Z0-9._+-]", "", req.ra.strip())
    safe_dec = re.sub(r"[^a-zA-Z0-9._+-]", "", req.dec.strip())
    chave_coord = f"{safe_ra}_{safe_dec}"
    pasta_alvo = os.path.join(FITS_BASE_DIR, chave_coord)

    fontes_fits = sorted(glob.glob(os.path.join(pasta_alvo, "*.fits")))[:3]
    origem_dados = "NASA_IRSA_CACHED" if fontes_fits else "NASA_IRSA_LIVE"

    if not fontes_fits:
        try:
            print(f"Consultando NASA IRSA (TAP Async) para {req.ra}, {req.dec}...")
            fontes_fits = consultar_irsa_ao_vivo(req.ra, req.dec)
        except Exception as e:
            print(f"Erro na consulta IRSA ({type(e).__name__}: {e}).")

    if not fontes_fits:
        return {
            "source": "NO_COVERAGE",
            "band": None,
            "epochs": [],
            "subtractedFileName": None,
            "contaminationFlags": ["NO_SPHEREX_COVERAGE_AT_COORDINATE"],
        }

    epocas_saida = []
    matrizes = []
    banda_detectada = None
    zscale = ZScaleInterval()

    for idx, fonte in enumerate(fontes_fits, start=1):
        is_remoto = str(fonte).startswith("http")
        kwargs = {"use_fsspec": True, "fsspec_kwargs": {"cache_type": "bytes"}} if is_remoto else {}

        with fits.open(fonte, **kwargs) as hdul:
            img_hdu = hdul["IMAGE"] if "IMAGE" in hdul else hdul[1]
            header = img_hdu.header
            dados_brutos = img_hdu.section[::2, ::2] if is_remoto else img_hdu.data[::2, ::2]
            dados = np.nan_to_num(dados_brutos)
            data_obs = header.get("DATE-OBS", f"2025-04-24T18:0{idx}:00")

            if not banda_detectada:
                banda_detectada = extrair_banda(header, str(fonte))

        nome_png = f"{chave_coord}_epoca_{idx}.png"
        caminho_png = os.path.join(OUTPUT_DIR, nome_png)

        if not os.path.exists(caminho_png):
            vmin, vmax = zscale.get_limits(dados)
            plt.imsave(caminho_png, dados, cmap="gray", vmin=vmin, vmax=vmax, origin="lower")

        matrizes.append(dados)
        epocas_saida.append({
            "date": data_obs,
            "fileName": nome_png,
        })

    nome_subtraida = None
    if len(matrizes) >= 2 and matrizes[-1].shape == matrizes[0].shape:
        nome_subtraida = f"{chave_coord}_subtraida.png"
        caminho_sub = os.path.join(OUTPUT_DIR, nome_subtraida)

        if not os.path.exists(caminho_sub):
            subtraida = matrizes[-1] - matrizes[0]
            vmin_s, vmax_s = zscale.get_limits(subtraida)
            plt.imsave(caminho_sub, subtraida, cmap="gray", vmin=vmin_s, vmax=vmax_s, origin="lower")

    arquivo_flags = os.path.join(pasta_alvo, "flags.json")
    if os.path.exists(arquivo_flags):
        with open(arquivo_flags, "r", encoding="utf-8") as f:
            flags_saida = json.load(f).get("contaminationFlags", ["NONE"])
    else:
        flags_saida = ["ANALYZING_IN_BACKGROUND"]
        background_tasks.add_task(inspecionar_flags_em_background, [str(x) for x in fontes_fits], pasta_alvo)

    return {
        "source": origem_dados,
        "band": banda_detectada,
        "epochs": epocas_saida,
        "subtractedFileName": nome_subtraida,
        "contaminationFlags": flags_saida,
    }
