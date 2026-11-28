import { cn } from '@/components/ui'

/** The FMS mark: the fleet's truck on the brand colour. Decorative; the product name always sits beside it. */
export function BrandMark({ size = 'md', className }: { size?: 'sm' | 'md'; className?: string }) {
  return (
    <div className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-control bg-brand', size === 'sm' ? 'h-9 w-9' : 'h-10 w-10', className)}>
      <img src="/brand/truck-mark.png" alt="" aria-hidden="true" draggable={false} className={size === 'sm' ? 'w-[30px]' : 'w-[34px]'} />
    </div>
  )
}
