/// <reference types="vite/client" />
import type { SlateApi } from '../../shared/api'

declare global {
  interface Window {
    slate: SlateApi
  }
}

export {}
