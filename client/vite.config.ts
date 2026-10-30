import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Shared protocol types live one level up.
    fs: { allow: [".."] },
    proxy: {
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
  test: {
    environment: "node",
  },
});
