// Stand-ins so every portal route resolves. Each is replaced by its own
// card's screen (FMS-10 login, and the Wave 1+ portals).
function Placeholder({ title }: { title: string }) {
  return <h1 className="text-2xl font-semibold text-fms-primary">{title}</h1>
}

export const DashboardPage = () => <Placeholder title="Dashboard" />
export const DriverHomePage = () => <Placeholder title="Driver Home" />
export const FuelReconciliationPage = () => <Placeholder title="Fuel Reconciliation" />
export const NotFoundPage = () => <Placeholder title="Page not found" />
