import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/dash/",
  plugins: [react()],
  resolve: {
    alias: {
      "@harryaskham/pi-daemon/dashboard-contract": fileURLToPath(new URL("../src/dashboard-contract.ts", import.meta.url)),
      "@harryaskham/pi-daemon/dashboard-fixtures": fileURLToPath(new URL("../src/dashboard-fixtures.ts", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    manifest: true,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
          if (id.includes("node_modules/lucide-react")) return "icons";
          if (id.includes("node_modules/@tanstack")) return "virtual";
          return undefined;
        },
      },
    },
  },
});
