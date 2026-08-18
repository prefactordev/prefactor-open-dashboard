import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, Vite serves the frontend and forwards API calls to server.mjs, which
// holds the token. Run both with `npm run dev`. The proxy follows PORT so a
// custom port works in dev exactly as it does in production.
const apiPort = process.env.PORT ?? "8788";

export default defineConfig({
  plugins: [react()],
  build: {
    // recharts alone minifies to ~565kB; it's split into its own cached chunk
    // below, so the default 500kB warning would only ever nag about a
    // third-party fact nothing here can change.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // The charting library is ~4× the app itself and changes only when
        // dependencies bump; splitting it lets the app chunk stay small and
        // the vendor chunk stay browser-cached across app updates.
        manualChunks: {
          vendor: ["react", "react-dom", "recharts"],
        },
      },
    },
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        // SSE (/api/events) must stream, not buffer.
        ws: true,
      },
    },
  },
});
