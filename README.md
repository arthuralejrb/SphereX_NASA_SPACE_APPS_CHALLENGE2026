# OrbitaX

A time-domain sky explorer built for the NASA Space Apps Challenge 2026.

OrbitaX shows how a single point in the sky changes over time. It uses images from
SPHEREx, a NASA space telescope that maps the entire sky in infrared light
(0.75 to 5 µm) and returns to every point at regular intervals.

## What you can do

- Search for an object by name ("M42", "Vega") or by coordinates, or click on the sky map.
- See the images of that point taken on different dates, laid out on a timeline.
- Compare two images side by side or overlaid, and play the sequence as an animation (downloadable as a GIF).
- Use the analysis tools, grouped in three tabs:

| Tab | Tools |
|---|---|
| Basic | Stretch (Asinh, black point, gamma) · RGB composite · Spectrum translator |
| Advanced | Point spectrum · Sub-pixel alignment |
| Scientific | Wavelength bins · Spectral cube · Background gradient removal · Redshift |

The interface is in Portuguese.

## Installation

The only requirement is [Docker](https://docs.docker.com/get-docker/) (with Docker
Compose, which ships with Docker Desktop) and an internet connection: the sky map and
the SPHEREx data are fetched live from NASA and CDS servers.

1. Clone the repository and enter it:

   ```bash
   git clone https://github.com/arthuralejrb/SphereX_NASA_SPACE_APPS_CHALLENGE2026.git
   cd SphereX_NASA_SPACE_APPS_CHALLENGE2026
   ```

2. Build and start the three containers:

   ```bash
   docker compose up -d --build
   ```

   The first build takes a few minutes: it installs the Python dependencies
   (Astropy, Astroquery, Reproject and others), compiles the C# API and builds the website.

3. Open http://localhost:3000.

4. Try it: click **R Draconis** or **Barnard's Star** under "Acesso rápido", or type
   `M31` in the search box and press Enter.

The first search of a given point takes about half a minute. Later searches of the
same point open instantly, because the result is cached.

## Commands

| What | Command |
|---|---|
| Start everything | `docker compose up -d --build` |
| Stop everything | `docker compose down` |
| See what is running | `docker compose ps` |
| Follow the processing log | `docker compose logs -f processor` |
| Rebuild one service after a code change | `docker compose up -d --build processor` (or `backend`, `frontend`) |

### Running without Docker (for development)

Docker is the supported way to run the project. To work on one part at a time you need
Python 3.11, the .NET 10 SDK and Node.js 24, and three terminals:

```bash
# 1. Processor (Python): installs Astropy and the other dependencies, then starts on port 5000
cd processor
pip install -r requirements.txt
OUTPUT_DIR=../backEnd/wwwroot/images uvicorn main:app --port 5000

# 2. API (C#): port 8080, talks to the processor at http://localhost:5000
cd backEnd
ASPNETCORE_URLS=http://localhost:8080 dotnet run

# 3. Website: Vite dev server (it prints the address, usually http://localhost:5173)
cd frontEnd
npm install
npm run dev
```

`OUTPUT_DIR` makes the processor write the images where the API serves them from.
On Windows PowerShell, set the variables with `$env:OUTPUT_DIR = "..."` before the command.

## Architecture

```
            browser
 ┌───────────────────────────────┐
 │  frontend (React)             │        sky tiles (HiPS)
 │   ├─ Aladin Lite  ────────────┼──────► CDS / IRSA servers
 │   └─ analysis screen          │
 └──────────────┬────────────────┘
                │ GET /api/sky?ra&dec&fov        (RA/Dec picked in Aladin Lite)
                ▼
 ┌───────────────────────────────┐
 │  backend (C# API, port 8080)  │  cache: wwwroot/cache
 │                               │  serves: wwwroot/images
 └──────────────┬────────────────┘
                │ POST /process                  (only when not cached)
                ▼
 ┌───────────────────────────────┐        catalogue: IRSA (SIA)
 │  processor (Python, port 5000)├──────► image files: NASA public S3 bucket
 └───────────────────────────────┘
```

| Service | Address | What it does |
|---|---|---|
| frontend | http://localhost:3000 | The website (React + TypeScript + Vite) |
| backend | http://localhost:8080 | C# API: receives searches, keeps the cache and serves the images |
| processor | http://localhost:5000 | Python (FastAPI + Astropy): fetches the data from NASA and builds the images |

### How the backend connects to Aladin Lite

Aladin Lite runs entirely in the browser, as a component of the frontend. It draws the
interactive sky map by loading image tiles straight from public astronomy servers
(CDS and IRSA); those tiles never pass through our backend.

What links the two is a **sky coordinate**:

1. The user moves around the map and clicks a point, or searches by name. Aladin Lite
   reports the right ascension and declination (RA/Dec) of that point.
2. The frontend sends those coordinates, plus the chosen field of view, to the backend:
   `GET /api/sky?ra=...&dec=...&fov=...`.
3. If that search was done before, the backend answers from `backEnd/wwwroot/cache`.
4. Otherwise the backend calls the processor (`POST /process`), which:
   - queries the SPHEREx catalogue at IRSA to find the exposures that contain the point;
   - reads from NASA's public bucket only the part of each file it needs;
   - crops and aligns the images and writes them to `backEnd/wwwroot/images`.
5. The backend returns the list of dates and image addresses, and the frontend shows
   them on the analysis screen. Going back to the map, Aladin Lite stays centred on the
   same point.
6. After answering, the processor measures in the background the brightness of the
   target in every exposure (the spectrum) and builds the spectral cube. The frontend
   follows the progress through a file served by the backend.

The list of featured targets shown next to the map comes from `GET /api/targets`.

### Fallback when NASA's catalogue is down

If IRSA does not respond, the processor falls back to real SPHEREx images stored in
`processor/dados_fits`. They show a different region of the sky and only keep the
site from being empty; no spectrum is produced in that case.

These files are not in the repository (`*.fits` is git-ignored, about 65 MB each).
To download them, run from the `processor` folder:

```bash
python baixar_mockup_real.py
```

## Project layout

```
frontEnd/    website
backEnd/     C# API, plus the wwwroot/images and wwwroot/cache folders
processor/   image processing in Python
docker-compose.yml
```

## Known limitations

- Very bright stars saturate the detector and get no spectrum.
- High proper-motion objects are measured at the searched coordinates, not at their current position.
- The redshift estimate is only meaningful for galaxies.
- The absolute brightness of the spectrum has not been checked against a reference catalogue.

## Data sources

- Images and catalogue: SPHEREx, through the NASA/IPAC Infrared Science Archive (IRSA).
- Sky map: Aladin Lite (CDS).
- Object names: Sesame (CDS).
- Galaxy templates: SWIRE template library (Polletta et al. 2007, ApJ 663, 81).

## Team

- Murilo Paiva Tavares
- Gabriela Alves Ribeiro
- Árthur Alejandro Rodrigues Balmaceda
- Maria Eduarda Rios Trivellato
- Ryan Pereira Campos
- Samuel Isaac Andrade Martins

## License

MIT. See the `LICENSE` file.
