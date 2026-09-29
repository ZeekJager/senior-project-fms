.PHONY: dev down clean logs db-shell backend-shell frontend-shell ai-shell

# Boot the entire application (rebuilds images if changed)
dev:
	docker-compose up --build

# Run in detached mode (background)
dev-bg:
	docker-compose up -d --build

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

# Open a MySQL terminal inside the database container
db-shell:
	docker exec -it fms_mysql mysql -u fms_app -papppassword fms_db

# Open a shell inside the Node.js backend
backend-shell:
	docker exec -it fms_backend sh

# Open a shell inside the React frontend
frontend-shell:
	docker exec -it fms_frontend sh

# Open a shell inside the Python AI service
ai-shell:
	docker exec -it fms_ai_service bash
