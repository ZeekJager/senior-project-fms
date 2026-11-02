import { Bus, Car, CarFront, Motorbike, Truck, Van } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '@/components/ui'

// Photos of people and vehicles (docs/photos.md), and the placeholders shown without one: a person's initials
// on a colour of their own, a vehicle's type as an icon. A photo that fails to load falls back to the same.

export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}

/** Soft backgrounds with readable ink in both themes, chosen by the name so a person keeps theirs. */
const TONES = [
  'bg-brand-soft text-brand-ink',
  'bg-info-soft text-info',
  'bg-success-soft text-success',
  'bg-warning-soft text-warning',
  'bg-danger-soft text-danger',
  'bg-neutral-soft text-ink-muted',
] as const

export function toneOf(name: string | null | undefined): (typeof TONES)[number] {
  let hash = 0
  for (const ch of name ?? '') hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return TONES[hash % TONES.length]
}

const AVATAR_SIZES = { xs: 'h-7 w-7 text-2xs', sm: 'h-9 w-9 text-xs', md: 'h-12 w-12 text-sm', lg: 'h-20 w-20 text-xl', xl: 'h-28 w-28 text-2xl' } as const
export type AvatarSize = keyof typeof AVATAR_SIZES

/** True once `src` has failed to load; reset when it changes. */
function useBroken(src: string | null | undefined): [boolean, () => void] {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])
  return [broken, () => setBroken(true)]
}

/** A person: their photo, or their initials. Decorative (`aria-hidden`) unless `label` is given. */
export function Avatar({ name, src, size = 'sm', className, label }: { name: string | null | undefined; src?: string | null; size?: AvatarSize; className?: string; label?: string }) {
  const [broken, onError] = useBroken(src)
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const }
  const photo = Boolean(src) && !broken
  return (
    <span
      {...a11y}
      data-photo={photo || undefined}
      className={cn('relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-semibold', AVATAR_SIZES[size], !photo && toneOf(name), className)}
    >
      {photo ? <img src={src!} alt="" loading="lazy" decoding="async" onError={onError} className="h-full w-full object-cover" /> : initialsOf(name)}
    </span>
  )
}

const VEHICLE_ICONS = { truck: Truck, bus: Bus, van: Van, car: Car, suv: CarFront, motorcycle: Motorbike } as const

const VEHICLE_SIZES = { sm: 'h-9 w-12 rounded-control', md: 'h-12 w-16 rounded-control', lg: 'h-24 w-32 rounded-card', xl: 'aspect-[4/3] w-full rounded-card' } as const
export type VehiclePhotoSize = keyof typeof VEHICLE_SIZES

/** A vehicle: its photo (4:3), or its type's icon on a quiet panel. Decorative unless `label` is given. */
export function VehiclePhoto({ src, vehicleType, size = 'sm', className, label }: { src?: string | null; vehicleType?: string | null; size?: VehiclePhotoSize; className?: string; label?: string }) {
  const [broken, onError] = useBroken(src)
  const Icon = VEHICLE_ICONS[(vehicleType ?? '') as keyof typeof VEHICLE_ICONS] ?? Truck
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const }
  const photo = Boolean(src) && !broken
  return (
    <span
      {...a11y}
      data-photo={photo || undefined}
      className={cn('relative inline-flex shrink-0 items-center justify-center overflow-hidden border border-line bg-surface-sunken text-ink-subtle', VEHICLE_SIZES[size], className)}
    >
      {photo ? (
        <img src={src!} alt="" loading="lazy" decoding="async" onError={onError} className="h-full w-full object-cover" />
      ) : (
        <Icon className={size === 'xl' ? 'h-1/3 w-1/3' : size === 'lg' ? 'h-10 w-10' : 'h-1/2 w-1/2'} strokeWidth={1.5} />
      )}
    </span>
  )
}
