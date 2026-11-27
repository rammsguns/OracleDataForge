import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Preserve the browser targets used by Vite 6 during the bundler upgrade.
  build: { target: ["es2020", "edge88", "firefox78", "chrome87", "safari14"] },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        // Keep Host aligned with the browser Origin, including LAN addresses.
        // Vite's string shorthand enables changeOrigin and breaks the backend origin guard.
        changeOrigin: false,
      },
    },
    watch: {
      // the backend writes data/ (versions, changelog, connections) at runtime and none of
      // these are frontend inputs — without this, every compile/versioned DDL full-reloads the SPA
      ignored: ["**/data/**", "**/server/**", "**/docs/**", "**/*.md", "**/.claude/**", "**/deploy/**"],
    },
  },
});
