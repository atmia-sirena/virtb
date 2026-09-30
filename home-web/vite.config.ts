import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by the backend at http://127.0.0.1:8787/home/ (loaded in the client's WebView2 window).
export default defineConfig({
  base: "/home/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "^/(agents|runs|events|me|v2|agent|runtime|app-config|flags|tts|web-search|codex-thread-launch)": "http://127.0.0.1:8787",
    },
  },
});
