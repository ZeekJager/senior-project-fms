// Reading the depot's check-in QR with the phone's camera (FMS-141): the browser's own BarcodeDetector where it has
// one that reads QR codes, jsQR (loaded only then) otherwise.

/** Reads the QR code in a video frame, if there is one. */
export interface QrReader {
  kind: 'native' | 'js'
  read(video: HTMLVideoElement): Promise<string | null>
}

interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>
}
interface BarcodeDetectorClass {
  new (options: { formats: string[] }): BarcodeDetectorLike
  getSupportedFormats?(): Promise<string[]>
}

/** jsQR is quicker on fewer pixels, and a code filling the viewfinder survives the scaling. */
const MAX_SIDE = 640

export async function createQrReader(): Promise<QrReader> {
  const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector
  if (Detector) {
    try {
      const formats = (await Detector.getSupportedFormats?.()) ?? ['qr_code']
      if (formats.includes('qr_code')) {
        const detector = new Detector({ formats: ['qr_code'] })
        return { kind: 'native', read: async (video) => (await detector.detect(video))[0]?.rawValue ?? null }
      }
    } catch {
      // A detector that cannot start: read with jsQR instead.
    }
  }
  const { default: jsQR } = await import('jsqr')
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  return {
    kind: 'js',
    read: async (video) => {
      const { videoWidth: w, videoHeight: h } = video
      if (!context || !w || !h) return null
      const scale = Math.min(1, MAX_SIDE / Math.max(w, h))
      canvas.width = Math.round(w * scale)
      canvas.height = Math.round(h * scale)
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const image = context.getImageData(0, 0, canvas.width, canvas.height)
      return jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })?.data ?? null
    },
  }
}

/** Only the depot's check-in codes are sent; any other QR in view is ignored. */
export const isCheckInCode = (text: string) => text.startsWith('FMSA1.')

/** Why the camera did not open, in the terms the screen explains. */
export type CameraProblem = 'unsupported' | 'denied' | 'unavailable'

export function cameraProblem(err: unknown): CameraProblem {
  const name = (err as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'Unsupported') return 'unsupported'
  return 'unavailable'
}

/** The back camera, which faces the screen while the driver reads their phone. */
export function openCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(Object.assign(new Error('No camera API'), { name: 'Unsupported' }))
  return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
}
