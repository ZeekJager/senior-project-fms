.PHONY: dev dev-bg env down clean logs db-shell backend-shell frontend-shell ai-shell migrate seed routing demo demo-sim demo-sim-stop demo-web

# Create .env from .env.example with generated secrets. An existing .env keeps
# its values and gains any key added to .env.example since (e.g. REDIS_PASSWORD).
# Uses local Node if present, otherwise a throwaway Node container.
env:
	@if command -v node >/dev/null 2>&1; then node scripts/init-env.mjs; \
	else docker run --rm -v "$(CURDIR):/w" -w /w node:22-alpine node scripts/init-env.mjs; fi

.env:
	@$(MAKE) --no-print-directory env

# Boot the entire application (rebuilds images if changed).
# --renew-anon-volumes: each container's node_modules lives in an anonymous
# volume, which Compose otherwise carries over from the old container, so
# packages added since the last run would be missing ("Cannot find module").
dev: env
	docker-compose up --build --renew-anon-volumes

# Run in detached mode (background)
dev-bg: env
	docker-compose up -d --build --renew-anon-volumes

# Stop the application
down:
	docker-compose down

# Stop the application AND wipe the database / persistent volumes
clean:
	docker-compose down -v --remove-orphans

# View logs for all services
logs:
	docker-compose logs -f

# --- HELPER SHELLS ---

# Open a psql terminal inside the database container
db-shell:
	docker exec -it fms_postgres psql -U fms_app -d fms_db

# Open a shell inside the Node.js backend
backend-shell:
	docker exec -it fms_backend sh

# Open a shell inside the React frontend
frontend-shell:
	docker exec -it fms_frontend sh

# Open a shell inside the Python AI service
ai-shell:
	docker exec -it fms_ai_service bash

# Run all pending database migrations
migrate:
	docker exec fms_backend npm run migrate

# Rebuild the database and fill it with demo data (docs/seed-data.md).
# Deletes everything in the dev database first. SIZE=small|budget|fleet500, SEED=<n>.
SIZE ?= small
SEED ?= 20261007
seed:
	docker exec -e FMS_SEED_PASSWORD fms_backend npm run seed -- --reset --size=$(SIZE) --seed=$(SEED)

# The presentation (docs/DEMO.md): rebuild the dev database with the demo fleet (50 vehicles, 60 drivers, 160 trips, 3 depots) where
# every account signs in with the password below, then drive all 50 vehicles with a ping every 2 s. Deletes everything in the dev
# database first. DEMO_PASSWORD is for demos only: the seed refuses to run when NODE_ENV=production.
DEMO_PASSWORD ?= password1234
demo:
	docker exec -e FMS_SEED_PASSWORD=$(DEMO_PASSWORD) fms_backend npm run seed -- --reset --size=demo

# Start the 50 vehicles (in the background, inside the backend container) and stop them again.
demo-sim:
	docker exec -d fms_backend npm run simulate:gps -- --vehicles 50 --interval 2 --duration 0

demo-sim-stop:
	-docker exec fms_backend pkill -f simulate-gps

# The web app as production serves it (built and served by nginx), on http://localhost:8081: the page loads in milliseconds, where
# the development server on :5173 takes seconds. Rebuilds the image each time, so it carries the current code.
demo-web:
	docker build -f packages/frontend/Dockerfile -t fms-frontend:demo .
	-docker rm -f fms_frontend_prod
	docker run -d --name fms_frontend_prod --network senior-project-fms_default -p 8081:8080 -e API_UPSTREAM=http://backend:3000 fms-frontend:demo

# Road routing (FMS-84, docs/routing.md): download Ethiopia's OpenStreetMap
# extract and build OSRM's road graph once (kept in the fms_osrm_data volume),
# then start OSRM. Steps already done are skipped.
routing: env
	docker volume create fms_osrm_data >/dev/null
	docker-compose --profile routing-setup run --rm osrm-download
	docker-compose --profile routing-setup run --rm osrm-prepare
	docker-compose --profile routing up -d osrm
