.PHONY: dev dev-bg env down clean logs db-shell backend-shell frontend-shell ai-shell migrate

# Create .env from .env.example with generated secrets (keeps an existing .env).
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
dev: .env
	docker-compose up --build --renew-anon-volumes

# Run in detached mode (background)
dev-bg: .env
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
