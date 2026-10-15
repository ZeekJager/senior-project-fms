import { Moon, Sun } from 'lucide-react'
import { IconButton } from '@/components/ui'
import { useTheme } from '@/theme/theme'

/** Switches between the light and dark theme; the choice is remembered on this device. */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme()
  const dark = theme === 'dark'
  return <IconButton label={dark ? 'Switch to light theme' : 'Switch to dark theme'} icon={dark ? <Sun /> : <Moon />} onClick={toggle} className={className} />
}
