# Fleet Management System (FMS)

A web-based Fleet Management System designed for Ethiopian transport operators. This repository contains the complete frontend, backend, and AI service built as a monorepo.

## 🚀 Quick Start

You only need **Docker** and **Docker Compose** installed on your machine to run the entire system.

1. Clone the repository:
   ```bash
   git clone https://github.com/ZeekJager/senior-project-fms.git
   cd senior-project-fms
   ```

2. Boot the stack:
   ```bash
   make dev
   ```
   *(If you are on Windows and don't have `make` installed, run `docker-compose up --build` instead).*

Once the boot finishes, the following services will be available:
- **Frontend (React/Vite):** [http://localhost:5173](http://localhost:5173)
- **Backend (Node.js):** [http://localhost:3000](http://localhost:3000)
- **AI Service (Python):** [http://localhost:5000](http://localhost:5000)
- **Database (PostgreSQL):** `localhost:5432`

## 🛠 Useful Commands (Makefile)

We have wrapped the complex Docker commands into simple `make` commands:

- `make dev` - Boot the stack and tail logs.
- `make dev-bg` - Boot the stack in the background.
- `make down` - Stop all services safely.
- `make clean` - Stop all services **and wipe the database**.
- `make db-shell` - Open an interactive psql terminal inside the database container.
- `make backend-shell` - Open a terminal inside the Node.js backend.

## 📚 Project Documentation

The single source of truth for the project's architecture lives in the `docs/` folder:
- **[MVP Scope & Roles](docs/fms-mvp-spec.md)** - What we are building and who uses it.
- **[Database Schema](packages/backend/migrations/README.md)** - The migrations that define every table (apply with `make migrate`).
- **[API Contract](docs/api-contract.md)** - All REST endpoints and Socket.io events.
- **[Screen Inventory](docs/screen-inventory.md)** - Every UI screen mapped to roles.
- **[Continuous Integration](docs/ci.md)** - What each CI check does, how to run it locally, and the `master` branch protection rule.

## 🤝 Contribution & Jira Workflow

We strictly tie our work to the Jira Board. Please follow these rules:

1. **Branch Naming**: Start every branch with the Jira issue key.
   ```bash
   git checkout -b feature/SE-37-database-migrations
   ```
2. **Smart Commits**: Tell Jira what to do by adding hashtags to your commit messages.
   - `git commit -m "SE-37 #in-progress Started migration script"` (Moves card to In Progress)
   - `git commit -m "SE-37 #done Finished migrations"` (Moves card to Done)
