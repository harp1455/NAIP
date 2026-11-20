import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.github.harp1455.naip',
  appName: 'NAIP',
  webDir: 'dist',
  android: {
    backgroundColor: '#111111',
    // Android 15+ 강제 edge-to-edge에서 시스템 바 밑으로 UI가 깔리지 않게 한다
    adjustMarginsForEdgeToEdge: 'force'
  }
}

export default config
