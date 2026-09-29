.PHONY: dev clean down

dev:
	docker-compose up --build

down:
	docker-compose down

clean:
	docker-compose down -v --remove-orphans
