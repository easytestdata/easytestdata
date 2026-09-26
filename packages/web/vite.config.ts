import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@ui": resolve(__dirname, "../../packages/ui/src")
    }
  },
  server: {
    port: 5173,
    proxy: {
      // The server's dev script runs local mode on 28080. The Host header stays
      // localhost:5173 (changeOrigin: false), which local mode accepts as its public address
      // (LOCAL_PUBLIC_URL), so the Intuit redirect and OAuth popup share the page's origin.
      "/api": {
        target: "http://localhost:28080",
        changeOrigin: false
      }
    }
  },
  build: {
    outDir: "dist",
    sourcemap: true
  }
});
