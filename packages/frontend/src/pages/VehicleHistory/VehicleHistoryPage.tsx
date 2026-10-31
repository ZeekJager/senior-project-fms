import { AlertTriangle, ArrowLeft, Truck } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, StatusBadge } from '@/components/shared'
import { Badge, Skeleton, ViewTabs, type ViewOption } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { HealthBadge } from '@/features/health/HealthBadge'
import { ServiceDueBadge, useVehicleServiceDue } from '@/features/service-due'
import { ApiError } from '@/lib/api/errors'
import { FUEL_TYPE_LABELS, VEHICLE_TYPE_LABELS, type Vehicle } from '@/pages/Vehicles/types'
import { useVehicle } from './api'
import { DocumentsSection } from './DocumentsSection'
import { formatDay, formatKm } from './format'
import { FuelSection } from './FuelSection'
import { HealthSection } from './HealthSection'
import { RepairsSection } from './RepairsSection'
import { ServiceDueSection } from './ServiceDueSection'
import { TripsSection } from './TripsSection'

type Section = 'repairs' | 'service' | 'trips' | 'fuel' | 'documents' | 'health'

/**
 * S-22 Vehicle history (FMS-136): everything that happened to one vehicle, one section at a time: its repairs
 * and services, its service due (FMS-129), its trips with the route each drove, fuel and odometer, its documents and its health. Each
 * section shows only with its read permission; the section is kept in the URL (?section=), so a link opens it.
 */
export function VehicleHistoryPage() {
  const { vehicleId = '' } = useParams()
  const { hasPermission } = useAuth()
  const [params, setParams] = useSearchParams()
  const vehicle = useVehicle(vehicleId)

  const sections = useMemo(() => {
    const all: (ViewOption<Section> & { allowed: boolean })[] = [
      { value: 'repairs', label: 'Repairs', allowed: hasPermission('maintenance:read') },
      { value: 'trips', label: 'Trips and routes', allowed: hasPermission('trip:read') },
      { value: 'fuel', label: hasPermission('fuel:read') ? 'Fuel and odometer' : 'Odometer', allowed: true },
      { value: 'documents', label: 'Documents', allowed: hasPermission('document:read') },
      { value: 'health', label: 'Health', allowed: hasPermission('prediction:read') },
      // Last, so no one's first section changes; vehicle:read, as the page itself (FMS-129).
      { value: 'service', label: 'Service due', allowed: true },
    ]
    return all.filter((s) => s.allowed)
  }, [hasPermission])
  const requested = params.get('section') as Section | null
  const section = sections.find((s) => s.value === requested)?.value ?? sections[0].value
  const choose = (next: Section) => setParams(next === sections[0].value ? {} : { section: next }, { replace: true })

  if (vehicle.isError) {
    const missing = vehicle.error instanceof ApiError && vehicle.error.status === 404
    return (
      <div className="space-y-6">
        <BackLink />
        {missing ? (
          <EmptyState icon={<Truck />} heading="Vehicle not found" description="It does not exist, or it belongs to a depot you do not see." />
        ) : (
          <ErrorState error={vehicle.error} onRetry={() => void vehicle.refetch()} />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4 border-b border-line pb-5">
        <BackLink />
        {vehicle.data ? (
          <Header vehicle={vehicle.data} onHealth={hasPermission('prediction:read') ? () => choose('health') : undefined} onService={() => choose('service')} />
        ) : (
          <HeaderSkeleton />
        )}
      </div>

      <ViewTabs label="Vehicle history sections" value={section} options={sections} onChange={choose} />

      {vehicle.data &&
        (section === 'repairs' ? (
          <RepairsSection vehicle={vehicle.data} />
        ) : section === 'service' ? (
          <ServiceDueSection vehicle={vehicle.data} />
        ) : section === 'trips' ? (
          <TripsSection vehicle={vehicle.data} />
        ) : section === 'fuel' ? (
          <FuelSection vehicle={vehicle.data} />
        ) : section === 'documents' ? (
          <DocumentsSection vehicle={vehicle.data} />
        ) : (
          <HealthSection vehicle={vehicle.data} />
        ))}
    </div>
  )
}

function BackLink() {
  return (
    <Link to="/vehicles" className="focus-ring inline-flex items-center gap-1.5 rounded-control text-sm font-medium text-ink-muted transition-colors hover:text-ink">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Vehicles
    </Link>
  )
}

function Header({ vehicle, onHealth, onService }: { vehicle: Vehicle; onHealth?: () => void; onService: () => void }) {
  const depots = useDepots()
  // Its most urgent service (FMS-129): said in the header when due or overdue, and opens Service due.
  const service = useVehicleServiceDue(vehicle.id).data?.find((d) => d.status !== 'upcoming')
  const depot = depots.data?.find((d) => d.id === vehicle.depot_id)
  const trip = vehicle.current_trip
  return (
    <header className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="plate flex flex-wrap items-center gap-x-3 gap-y-2 text-2xl font-semibold tracking-tight text-ink">
            <span>{vehicle.registration_number}</span>
            {vehicle.status !== 'active' && <StatusBadge status={vehicle.status} />}
            {vehicle.maintenance_flag && (
              <Badge tone="warning" icon={<AlertTriangle />}>
                Flagged for maintenance
              </Badge>
            )}
            {service && (
              <button type="button" onClick={onService} className="focus-ring rounded-full font-sans" aria-label={`Service ${service.status}: ${service.program.name}. Open Service due.`}>
                <ServiceDueBadge status={service.status}>{service.status === 'overdue' ? 'Service overdue' : 'Service due'}</ServiceDueBadge>
              </button>
            )}
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            {vehicle.make} {vehicle.model}
            {vehicle.year ? ` · ${vehicle.year}` : ''} · {VEHICLE_TYPE_LABELS[vehicle.vehicle_type]}
            {vehicle.vin ? <span className="tabular text-ink-subtle"> · VIN {vehicle.vin}</span> : null}
          </p>
        </div>
        {/* A vehicle never scored has nothing to say here; its Health section explains why. */}
        {vehicle.health_score !== null && <HealthBadge score={vehicle.health_score} updatedAt={vehicle.health_score_updated_at} onOpen={onHealth} />}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
        <Fact label="Depot">{depot?.name ?? '—'}</Fact>
        <Fact label="Odometer">
          <span className="tabular">{formatKm(vehicle.odometer_km)}</span>
        </Fact>
        <Fact label="Fuel">
          {FUEL_TYPE_LABELS[vehicle.fuel_type]}
          {vehicle.fuel_efficiency_ml_per_km !== null && (
            <span className="tabular text-ink-muted"> · {(vehicle.fuel_efficiency_ml_per_km / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })} L/100 km</span>
          )}
        </Fact>
        <Fact label="In the fleet since">{formatDay(vehicle.created_at)}</Fact>
        <Fact label="Now">{trip ? `On a trip, ${trip.origin ?? 'origin'} to ${trip.destination ?? 'destination'}` : 'No trip under way'}</Fact>
      </dl>
    </header>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd className="mt-1 text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

function HeaderSkeleton() {
  return (
    <div className="space-y-5" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  )
}
