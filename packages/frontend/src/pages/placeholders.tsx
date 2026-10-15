import { Compass, Fuel, Home, LayoutDashboard, Radar, Route, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/shared'
import { Card } from '@/components/ui'

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

export const DashboardPage = () => (
  <Placeholder title="Dashboard" icon={LayoutDashboard} description="Fleet KPIs arrive with the analytics dashboard (S-18). Use the menu to open your screens." />
)

export const DriverHomePage = () => (
  <Placeholder title="Driver Home" icon={Home} description="Your assigned trip, with start and end, arrives with the driver app (S-11)." />
)

export const FuelReconciliationPage = () => (
  <Placeholder title="Fuel Reconciliation" icon={Fuel} description="Expected against actual fuel per vehicle arrives with S-15." />
)

export const DispatchPage = () => (
  <Placeholder title="Dispatch" icon={Route} description="Scheduled trips beside available drivers and vehicles arrive with the trip console (S-07)." />
)

export const CommandCenterPage = () => (
  <Placeholder title="Live map" icon={Radar} description="Live vehicle positions and active trips arrive with the command center (S-16)." />
)

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
