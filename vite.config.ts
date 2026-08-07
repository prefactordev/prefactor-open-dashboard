import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, Vite serves the frontend and forwards API calls to server.mjs, which
// holds the token. Run both with `npm run dev`. The proxy follows PORT so a
// custom port works in dev exactly as it does in production.
const apiPort = process.env.PORT ?? "8788";

export default defineConfig({
  plugins: [react()],
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
