import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Set base path for GitHub Pages. Replace with your repo name if different.
  base: process.env.VITE_BASE || '/n-picture-export-pdf/',
  plugins: [react()],
})
