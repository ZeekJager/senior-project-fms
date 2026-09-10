# Fleet Management System (FMS) - Implementation Guide

This guide maps out the entire development lifecycle for the FMS, breaking the project down into sequential "Waves". Each wave builds on the dependencies of the last, taking you from an empty repository to a polished, AI-driven platform.

## 🏗️ Wave 0: Foundation & Scaffolding
**Goal**: Establish the project infrastructure, database schemas, and core access control. Nothing works without this layer.

*   **Task 0.1: Project Initialization**
    *   Set up the Git repository.
    *   Initialize the Node.js/Express backend and React/Tailwind frontend.
    *   Configure Docker and `docker-compose` for consistent local development.
*   **Task 0.2: Database Architecture (with Audit & Soft Deletes)**
    *   Design and provision the MySQL database (3NF normalized).
    *   Create base tables: `Users`, `Vehicles`, `Drivers`, `Depots`, `Roles`.
    *   *Implementation Details*: Enforce "Soft Deletes" (`is_active` boolean) on all tables to preserve historical integrity, and implement a global Audit Log table to track all edits and state changes.
*   **Task 0.3: Authentication & RBAC (Role-Based Access Control)**
    *   Implement JWT-based authentication.
    *   Configure roles (Admin, Fleet Manager, Dispatcher, Driver, Technician, etc.) and restrict API endpoints accordingly.
*   **Dependencies**: None.

---

## 🚙 Wave 1: Core Entities (MVP Part 1)
**Goal**: Build the CRUD (Create, Read, Update, Delete) interfaces for the system's foundational entities so users can start populating the database.

*   **Task 1.1: Driver & Vehicle Profiles**
    *   Build forms to manage vehicles (specs, plate numbers) and drivers (licenses, qualifications).
    *   Implement document upload with expiry date tracking.
*   **Task 1.2: HR & Attendance Module**
    *   Create the Depot Admin interface for logging daily driver attendance.
*   **Task 1.3: Maintenance & Workshop Basics**
    *   Build forms for technicians to log repairs, labor, and parts used.
    *   Set up simple inventory tracking for spare parts (stock in/out).
*   **Dependencies**: Requires Wave 0 (Auth and Database).

---

## 🛣️ Wave 2: Operations & Tracking (MVP Part 2)
**Goal**: Enable real-time dispatching, route tracking, and field reporting for daily operations.

*   **Task 2.1: Trip & Route Management**
    *   Build the Dispatcher UI to assign drivers and vehicles to specific routes.
    *   **Enforce Business Rules**: Prevent assigning drivers to overlapping trips or dispatching vehicles currently flagged for maintenance.
*   **Task 2.2: Driver Mobile Interface (Offline-First PWA)**
    *   Create a Progressive Web App (PWA) tailored for drivers on mobile.
    *   *Implementation Details*: Utilize `IndexedDB` or service workers so drivers can submit DVIRs (Daily Vehicle Inspection Reports), incident reports, and fuel logs even when completely offline, queuing the data to sync automatically when internet is restored.
*   **Task 2.3: Fuel Logging & Reconciliation**
    *   Build a quick-entry form for drivers to log fuel purchases.
    *   Create a Finance Clerk UI to reconcile fuel entries against vehicle mileage to detect theft or leakage.
*   **Dependencies**: Requires Wave 1 (Need Drivers and Vehicles to assign Trips).

---

## 🧠 Wave 3: Advanced Features & AI (Phase 2)
**Goal**: Bring the system to life with live maps, automated alerts, and predictive analytics.

*   **Task 3.1: Fleet Command Center (Live HTML5 Map)**
    *   Integrate Leaflet.js with OpenStreetMap.
    *   *Implementation Details*: Instead of relying purely on simulated data, implement the **HTML5 Geolocation API** in the Driver PWA to stream their actual live smartphone coordinates to the backend via Socket.io, creating a genuine real-time tracking experience for dispatchers.
*   **Task 3.2: Centralized Alerts Engine**
    *   Set up cron jobs to trigger alerts for upcoming maintenance and expiring documents.
    *   Create real-time triggers for speeding or excessive idling based on telemetry data.
*   **Task 3.3: Analytics Dashboard**
    *   Integrate Chart.js to visualize fleet utilization, cost trends, and driver rankings.
*   **Task 3.4: AI Predictive Maintenance (Python Service)**
    *   Train a `scikit-learn` model on synthetic vehicle health data (mileage, engine hours, fault history).
    *   Expose an internal Python API that the Node.js backend queries to assign a "Health Score" and predict failures.
*   **Dependencies**: Requires Wave 2 (Need Trip and Fuel data for Analytics and AI).

---

## ✨ Wave 4: Polishing & Testing by Metrics
**Goal**: Ensure the system is robust, secure, and ready for your academic defense and production use.

*   **Task 4.1: Performance & Load Testing**
    *   Optimize database queries to ensure the dashboard loads in `< 3 seconds` (NFR-1).
    *   Ensure standard API responses return in `< 500ms` (NFR-2).
    *   Stress-test the Socket.io server with a script simulating 500 concurrent vehicles.
*   **Task 4.2: Security & Edge Cases**
    *   Audit all API endpoints to ensure RBAC cannot be bypassed via direct API calls.
    *   Implement conflict resolution (e.g., if two dispatchers edit a trip at the exact same time).
    *   Test "Data Stale" UI states when the GPS feed disconnects.
*   **Task 4.3: User Acceptance & Bug Bashing**
    *   Run end-to-end workflow tests (e.g., *Driver logs fault -> Tech receives alert -> Tech fixes vehicle -> Dispatcher assigns vehicle to new trip*).
    *   Finalize the User Guide and Defense Presentation scripts.
*   **Dependencies**: Requires Wave 3.
