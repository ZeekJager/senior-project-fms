# FMS Screen Inventory

All screens must handle 5 states: Loading (Skeleton), Empty, Error (Boundary), Success, and Skeleton-on-filter.

| ID   | Name | Route | Allowed Roles | Description |
|---|---|---|---|---|
| S-01 | Login | `/login` | All | Single entry point. Displays generic auth errors. |
| S-04 | Vehicle Dashboard | `/vehicles` | Admin, Fleet Mgr, Dispatcher, Depot Admin | Data table with status badges and inline decommissioning. |
| S-05 | Driver Dashboard | `/drivers` | Admin, Fleet Mgr, Dispatcher, Depot Admin | Displays driver license status. Red 'EXPIRED' badges. |
| S-06 | Attendance UI | `/attendance` | Admin, Depot Admin, Fleet Mgr | Grid toggle (present/absent/on_leave) per driver. |
| S-07 | Dispatcher Trip Console | `/dispatch` | Admin, Dispatcher | Split view: scheduled trips on left, available drivers/vehicles on right. |
| S-08 | Technician Repair Log | `/maintenance` | Admin, Tech | Form to log repairs, deduct stock, and clear maintenance flags. |
| S-09 | Spare Parts Console | `/inventory` | Admin, Depot Admin, Tech | Live stock counts with 'OUT OF STOCK' / 'LOW' highlights. |
| S-10 | Audit Log UI | `/audit` | Admin, Fleet Owner, Compliance | Read-only diff view of system mutations. |
| S-11 | Driver Mobile Home | `/driver` | Driver | Mobile PWA shell. Shows today's assigned trip with START/END toggle. |
| S-12 | Driver DVIR Form | `/driver/dvir` | Driver | Offline-first pre/post trip inspection checklist (IndexedDB synced). |
| S-13 | Driver Incident Form | `/driver/incident` | Driver | Quick-report form for breakdowns/accidents. |
| S-14 | Driver Fuel Entry | `/driver/fuel` | Driver | Offline-first form taking integer litres/cost and odometer. |
| S-15 | Fuel Reconciliation | `/finance/fuel` | Admin, Finance Clerk | Shows variance % between actual and expected fuel consumption. |
| S-16 | Fleet Command Center | `/command-center` | Admin, Fleet Mgr, Dispatcher | 70% Live Map (Socket.io/Leaflet), 30% sidebar of active trips. |
| S-17 | Notification Inbox | `(Global Panel)` | All | Bell icon drop-down showing real-time alerts. |
| S-18 | Analytics Dashboard | `/analytics` | Admin, Fleet Owner, Fleet Mgr | KPI bands and charts for fleet health/costs (cached data). |
| S-19 | Predictive Maintenance UI | `/maintenance/ai-health` | Admin, Fleet Mgr, Tech | Shows AI health score (0-100) and top contributing risk factors. |
