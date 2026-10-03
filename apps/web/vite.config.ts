import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import { viteStaticCopy } from "vite-plugin-static-copy"

export default defineConfig({
  envDir: "../../",
  plugins: [
    vue(),
    viteStaticCopy({
      targets: [
        { src: "../../node_modules/cesium/Build/Cesium/Workers", dest: "cesium" },
        { src: "../../node_modules/cesium/Build/Cesium/ThirdParty", dest: "cesium" },
        { src: "../../node_modules/cesium/Build/Cesium/Assets", dest: "cesium" },
        { src: "../../node_modules/cesium/Build/Cesium/Widgets", dest: "cesium" }
      ]
    })
  ],
  define: {
    CESIUM_BASE_URL: JSON.stringify("/cesium")
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true
      }
    }
  },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          cesium: ["cesium"],
          vue: ["vue", "pinia"],
          element: ["element-plus", "@element-plus/icons-vue"]
        }
      }
    }
  }
})
