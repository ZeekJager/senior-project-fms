import QRCode from 'qrcode'
import { useMemo } from 'react'
import { cn } from '@/components/ui'

/** Modules of white margin around the code: scanners need four. */
const QUIET_ZONE = 4

/**
 * A QR code as an SVG, one path of dark modules. Always dark on white, in either theme: a scanner reads contrast,
 * and an inverted code fails on many phones. Medium error correction survives a scuffed tablet screen.
 */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { size, path } = useMemo(() => {
    const { modules } = QRCode.create(value, { errorCorrectionLevel: 'M' })
    let d = ''
    for (let y = 0; y < modules.size; y++) {
      for (let x = 0; x < modules.size; x++) {
        if (modules.get(y, x)) d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`
      }
    }
    return { size: modules.size + QUIET_ZONE * 2, path: d }
  }, [value])

  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" className={cn('block bg-white', className)}>
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#0b1220" />
    </svg>
  )
}
