import csv
import io
import os
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits

TAP_SYNC_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
BASE_DIR = "dados_fits"
os.makedirs(BASE_DIR, exist_ok=True)

ALVOS = [
    ("WISE 0855", "08h55m10.831s", "-7d14m42.53s"),
    ("Barnard's Star", "17h57m48.50s", "+04d41m36.1s"),
    ("Epsilon Indi B", "22h04m10.52s", "-56d46m57.7s"),
    ("RW Aurigae", "05h07m49.54s", "+30d24m05.1s"),
    ("R Draconis", "16h32m40.23s", "+66d45m17.9s"),
    ("NEP", "18h00m00.0s", "+66d33m38.6s"),
    ("SEP", "06h00m00.0s", "-66d33m38.6s"),
]


def resolver_url_fits(access_url: str) -> str | None:
    """Resolve DataLink XML para a URL direta do arquivo .fits daquela observação."""
    if ".fits" in access_url.lower():
        return access_url
    try:
        req = urllib.request.Request(access_url, headers={"User-Agent": "SPHEREx-Explorer/1.0"})
        xml_bytes = urllib.request.urlopen(req, timeout=15).read()
        root = ET.fromstring(xml_bytes)
        for td in root.iter():
            if td.tag.endswith("TD") and td.text:
                txt = td.text.strip()
                if txt.startswith("http") and ".fits" in txt.lower():
                    return txt
    except Exception as e:
        print(f"  [!] Falha ao resolver DataLink: {e}", flush=True)
    return None


def consultar_irsa_por_coordenada(ra_str: str, dec_str: str, raio_deg: float = 2.5) -> list[str]:
    """Consulta síncrona indexada em spherex.obscore pelas coordenadas exatas do alvo."""
    coord = SkyCoord(f"{ra_str} {dec_str}", frame="icrs")
    adql = (
        "SELECT TOP 25 obs_id, s_ra, s_dec, t_min, calib_level, access_url "
        "FROM spherex.obscore "
        f"WHERE 1 = CONTAINS(POINT('ICRS', s_ra, s_dec), CIRCLE('ICRS', {coord.ra.deg:.6f}, {coord.dec.deg:.6f}, {raio_deg}))"
    )
    params = urllib.parse.urlencode({
        "REQUEST": "doQuery",
        "LANG": "ADQL",
        "FORMAT": "csv",
        "QUERY": adql,
    })
    req = urllib.request.Request(
        f"{TAP_SYNC_URL}?{params}",
        headers={"User-Agent": "SPHEREx-Explorer/1.0"},
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        texto = resp.read().decode("utf-8", errors="replace")

    if texto.lstrip().startswith("<"):
        raise RuntimeError(f"Resposta XML/erro da IRSA: {texto[:250]}")

    linhas = list(csv.DictReader(io.StringIO(texto)))
    if not linhas:
        return []

    linhas.sort(
        key=lambda r: (
            0 if int(float(r.get("calib_level") or 0)) == 2 else 1,
            float(r.get("t_min") or 0.0),
        )
    )

    urls_distintas = []
    tempos_vistos = set()

    for row in linhas:
        raw_url = (row.get("access_url") or "").strip()
        if not raw_url:
            continue
        fits_url = resolver_url_fits(raw_url)
        if not fits_url:
            continue

        t_chave = round(float(row.get("t_min") or 0.0), 4)
        if t_chave not in tempos_vistos and fits_url not in urls_distintas:
            tempos_vistos.add(t_chave)
            urls_distintas.append(fits_url)

        if len(urls_distintas) >= 3:
            break

    return urls_distintas


def salvar_fits_enxuto_via_range(url_remota: str, destino_local: str):
    """Lê apenas PRIMARY + IMAGE + FLAGS via HTTP Range Requests."""
    try:
        hdul = fits.open(url_remota, use_fsspec=True, fsspec_kwargs={"cache_type": "bytes", "block_size": 1048576})
        usar_section = True
    except Exception:
        hdul = fits.open(url_remota)
        usar_section = False

    with hdul:
        primary_hdr = hdul[0].header.copy()
        img_hdu = hdul["IMAGE"] if "IMAGE" in hdul else hdul[1]
        img_hdr = img_hdu.header.copy()
        fatia = img_hdu.section[::2, ::2] if usar_section else img_hdu.data[::2, ::2]
        img_data = np.nan_to_num(fatia).astype(np.float32)

        novas_hdus = [
            fits.PrimaryHDU(header=primary_hdr),
            fits.ImageHDU(data=img_data, header=img_hdr, name="IMAGE"),
        ]

        if "FLAGS" in hdul:
            fatia_flags = hdul["FLAGS"].section[::2, ::2] if usar_section else hdul["FLAGS"].data[::2, ::2]
            novas_hdus.append(fits.ImageHDU(data=fatia_flags.astype(np.uint8), name="FLAGS"))

        fits.HDUList(novas_hdus).writeto(destino_local, overwrite=True)


def main():
    for nome, ra, dec in ALVOS:
        safe_ra = re.sub(r"[^a-zA-Z0-9._+-]", "", ra.strip())
        safe_dec = re.sub(r"[^a-zA-Z0-9._+-]", "", dec.strip())
        pasta_alvo = os.path.join(BASE_DIR, f"{safe_ra}_{safe_dec}")
        os.makedirs(pasta_alvo, exist_ok=True)

        print(f"\n=== {nome} ({ra}, {dec}) ===", flush=True)
        try:
            urls = consultar_irsa_por_coordenada(ra, dec)
        except Exception as e:
            print(f"  [!] Erro na consulta TAP/sync: {e}", flush=True)
            continue

        if not urls:
            print("  [-] Nenhuma observação pública do SPHEREx cobre esta coordenada ainda.", flush=True)
            continue

        print(f"  [+] {len(urls)} exposições exatas encontradas na IRSA!", flush=True)
        for idx, url in enumerate(urls, start=1):
            destino = os.path.join(pasta_alvo, f"epoca_{idx}.fits")
            if os.path.exists(destino):
                print(f"  [=] Já existe: {destino}", flush=True)
                continue
            print(f"  [{idx}/{len(urls)}] Baixando fatia parcial -> {destino} ...", flush=True)
            try:
                salvar_fits_enxuto_via_range(url, destino)
                print(f"  [OK] Salvo ({os.path.getsize(destino) // 1024} KB)", flush=True)
            except Exception as e:
                print(f"  [!] Erro ao baixar FITS: {e}", flush=True)


if __name__ == "__main__":
    main()