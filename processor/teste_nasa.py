from astroquery.ipac.irsa import Irsa
from astropy.coordinates import SkyCoord
import astropy.units as u
from astropy.io import fits
from astropy.visualization import ZScaleInterval
import matplotlib.pyplot as plt

# 1. Coordenada oficial de teste da NASA (WISE 0855)
coord = SkyCoord("08h55m10.831s -7d14m42.53s", frame="icrs")

print("Consultando o IRSA/NASA...")

try:
    # Tenta via SIA usando o cliente oficial do IRSA
    tabela = Irsa.query_sia(pos=(coord, 0.05 * u.deg), collection="spherex_dr1")
    if len(tabela) == 0:
        tabela = Irsa.query_sia(pos=(coord, 0.05 * u.deg), collection="spherex_qr3")
except Exception as e:
    print(f"SIA instável no servidor da NASA ({e}), tentando via TAP...")
    # Fallback via TAP (consulta espacial direta no catálogo ObsCore)
    query = f"""
    SELECT TOP 10 *
    FROM spherex.obscore
    WHERE CONTAINS(POINT('ICRS', s_ra, s_dec), CIRCLE('ICRS', {coord.ra.deg}, {coord.dec.deg}, 0.05)) = 1
    """
    tabela = Irsa.query_tap(query).to_table()

print(f"Total de imagens encontradas: {len(tabela)}")

if len(tabela) > 0:
    print("Colunas disponíveis:", tabela.colnames)
    url_primeira_imagem = tabela["access_url"][0]
    print(f"\nBaixando e lendo FITS: {url_primeira_imagem}")

    with fits.open(url_primeira_imagem) as hdul:
        dados_imagem = hdul["IMAGE"].data if "IMAGE" in hdul else hdul[1].data

    zscale = ZScaleInterval()
    vmin, vmax = zscale.get_limits(dados_imagem)

    plt.imsave("resultado_nasa.png", dados_imagem, cmap="gray", vmin=vmin, vmax=vmax, origin="lower")
    print("SUCESSO! Abra o arquivo 'resultado_nasa.png' na pasta processor.")
else:
    print("Nenhuma imagem retornada para essa coordenada.")