import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // SPLIT deployment: frontend is a pure Vite project (Vercel Vite
    // preset collects dist/). The Express backend lives in its own
    // Vercel project (foresight-api). public/** collection is no
    // longer used, so outDir returns to the default dist/.
    outDir: "dist",
  },
  server: {
    port: 5173,
    host: "0.0.0.0",          // слушаем на всех интерфейсах, а не только localhost
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
