import os
import urllib.request
import xml.etree.ElementTree as ET
from astropy.io import fits
from astropy.visualization import ZScaleInterval
import matplotlib.pyplot as plt

os.makedirs("dados_fits", exist_ok=True)
os.makedirs("imagens_prontas", exist_ok=True)

BUCKET = "https://nasa-irsa-spherex.s3.amazonaws.com"

def buscar_fits_ceu(prefixo="dr1/", profundidade=0):
    url = f"{BUCKET}/?list-type=2&prefix={prefixo}&delimiter=/&max-keys=50"
    xml_data = urllib.request.urlopen(url, timeout=15).read()
    root = ET.fromstring(xml_data)

    subpastas = []
    fits_encontrados = []

    for elem in root.iter():
        if elem.tag.endswith("Prefix") and elem.text and elem.text != prefixo:
            subpastas.append(elem.text)
        elif elem.tag.endswith("Key") and elem.text and elem.text.endswith(".fits"):
            fits_encontrados.append(elem.text)

    if fits_encontrados:
        return fits_encontrados

    # Ignora pastas de calibração interna do telescópio e prioriza imagens de ciência
    ignorar = ("abs_gain", "cal", "dark", "flat", "mask", "psf", "nonlin", "readnoise")
    preferidas = [p for p in subpastas if any(k in p.lower() for k in ("level2", "l2", "spec", "sci", "img"))]
    outras = [p for p in subpastas if not any(k in p.lower() for k in ignorar) and p not in preferidas]

    for pasta in (preferidas + outras):
        if profundidade < 6:
            res = buscar_fits_ceu(pasta, profundidade + 1)
            if res:
                return res
    return []

arquivos_ceu = buscar_fits_ceu("dr1/")

for i, key in enumerate(arquivos_ceu[:3], start=1):
    url_download = f"{BUCKET}/{key}"
    nome_local = f"dados_fits/ceu_real_{i}.fits"

    print(f"\n[{i}/3] Baixando observação real: {key}")
    urllib.request.urlretrieve(url_download, nome_local)

    with fits.open(nome_local) as hdul:
        print("Camadas (MEF):", [hdu.name for hdu in hdul])
        header = hdul["IMAGE"].header if "IMAGE" in hdul else hdul[1].header
        dados = hdul["IMAGE"].data if "IMAGE" in hdul else hdul[1].data

        print(f"Data real da foto: {header.get('DATE-OBS', 'N/A')}")
        print(f"Coordenada real (RA, Dec): ({header.get('CRVAL1', 'N/A')}, {header.get('CRVAL2', 'N/A')})")

    zscale = ZScaleInterval()
    vmin, vmax = zscale.get_limits(dados)
    plt.imsave(f"imagens_prontas/ceu_real_{i}.png", dados, cmap="gray", vmin=vmin, vmax=vmax, origin="lower")
    print(f"Imagem do espaço salva em: imagens_prontas/ceu_real_{i}.png")