/// <reference types="vite/client" />

declare const CESIUM_BASE_URL: string

interface Window {
  __wurenjiMapTest?: {
    entityScreenPosition: (id: string) => { x: number; y: number } | null
    geoPointScreenPosition: (longitude: number, latitude: number, altitude?: number) => { x: number; y: number } | null
    viewState: () => {
      camera: { longitude: number; latitude: number; height: number; heading: number; pitch: number }
      focus: { longitude: number; latitude: number; height: number; range: number } | null
      ready: boolean
    } | null
  }
}
