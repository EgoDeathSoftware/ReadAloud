import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      src: resolve(__dirname, "src"),
    },
  },
  server: {
    port: 8056,
    proxy: {
      "/api": {
        target: "http://localhost:8055",
        changeOrigin: true,
      },
    },
  },
});
