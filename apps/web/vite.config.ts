import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Production: Fastify serves apps/web/dist from the same origin. Dev: proxy /api to the loopback backend
// (start the backend with ENGLISHLAB_DEV_ORIGIN=http://localhost:5173 so its exact-Origin check accepts Vite).
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:4318", changeOrigin: true } },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
