import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@vibe/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 12001,
    // Allow the container's public hostname when running behind a proxy.
    allowedHosts: true,
    proxy: {
      "/v1": "http://localhost:12000",
      "/health": "http://localhost:12000",
    },
  },
});
