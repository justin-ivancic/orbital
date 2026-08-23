import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.justinivancic.orbital',
  appName: 'Orbital Library',
  webDir: 'dist',
  android: {
    backgroundColor: '#ffffff',
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#ffffff',
      showSpinner: false,
    },
  },
}

export default config
