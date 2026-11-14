import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * O arquivo do Gaia (ESA) não envia cabeçalhos CORS, então o navegador não
 * pode consultá-lo direto. O servidor do Vite repassa /gaia-tap para ele.
 * Vale para `npm run dev` e `npm run preview`; ver src/services/gaia.ts.
 */
const gaiaProxy = {
  '/gaia-tap': {
    target: 'https://gea.esac.esa.int',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/gaia-tap/, '/tap-server/tap'),
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { proxy: gaiaProxy },
  preview: { proxy: gaiaProxy },
})
