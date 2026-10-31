import { Compass, LayoutDashboard, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/shared'
import { Card } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { AnalyticsDashboardPage } from '@/pages/Analytics'

// Stand-ins so every portal home and menu link resolves to a real page
// (FMS-114: no dead links). Each is replaced by its own card's screen.
function Placeholder({ title, icon: Icon, description }: { title: string; icon: LucideIcon; description: string }) {
  return (
    <div className="space-y-6">
      <header className="border-b border-line pb-5">
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">{title}</h1>
      </header>
      <Card>
        <EmptyState icon={<Icon />} heading="This screen is on its way" description={description} headingLevel="h2" />
      </Card>
    </div>
  )
}

/** Everyone's home. With analytics:read it is S-18, the analytics dashboard (FMS-51); others keep the menu. */
export function DashboardPage() {
  const { hasPermission } = useAuth()
  if (hasPermission('analytics:read')) return <AnalyticsDashboardPage />
  return <Placeholder title="Dashboard" icon={LayoutDashboard} description="Use the menu to open your screens." />
}

export const NotFoundPage = () => (
  <div className="space-y-6">
    <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Page not found</h1>
    <Card>
      <EmptyState
        icon={<Compass />}
        heading="Nothing lives at this address"
        description="The link may be old, or the screen may not be part of your access."
        action={
          <Link to="/" className="focus-ring inline-flex h-10 items-center rounded-control bg-brand px-4 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-strong">
            Go to my home
          </Link>
        }
      />
    </Card>
  </div>
)
