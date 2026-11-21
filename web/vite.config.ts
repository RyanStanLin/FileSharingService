import {defineConfig} from 'vite'

const target = process.env.FILESHARING_API_TARGET ?? 'http://127.0.0.1:8847'
const proxy = {
  '/api/v1': {target, ws: true},
  '/demo': {target},
}

export default defineConfig({
  server: {host: 'localhost', port: 5173, strictPort: true, proxy},
  preview: {host: 'localhost', port: 5173, strictPort: true, proxy},
})
