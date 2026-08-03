import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // Vercel serves static assets only from public/** for Express
    // projects (express.static() is ignored there) — point the Vite
    // build output there directly instead of the default dist/.
    outDir: "public",
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
