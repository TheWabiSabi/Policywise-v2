import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8001",
        changeOrigin: true,
      },
      "/auth": {
        target: "https://insurai-backend.shareindiainsurance.com",
        changeOrigin: true,
      },
      "/users": {
        target: "https://insurai-backend.shareindiainsurance.com",
        changeOrigin: true,
      },
      "/health": {
        target: "https://insurai-backend.shareindiainsurance.com",
        changeOrigin: true,
      },
    },
  },
});
