# syntax=docker/dockerfile:1
# Production image of the predictive maintenance service (FMS-105, docs/production-images.md).
# Build with the service's folder as the context:
#   docker build -t fms-ai-service:<commit> packages/ai-service
# Dependencies are installed in a build stage into a virtualenv; the model is trained at build time
# from the seeded dataset (the same data every build), so the image starts with a model and needs
# only ML_SERVICE_TOKEN at run time. Runs as an unprivileged user, uvicorn with 2 workers.

ARG PYTHON_IMAGE=python:3.12-slim

FROM ${PYTHON_IMAGE} AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /src
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
RUN python scripts/generate_training_data.py --out /tmp/training_data.csv \
 && python scripts/train.py --data /tmp/training_data.csv --out /opt/models

FROM ${PYTHON_IMAGE} AS runtime
ENV PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 ML_MODELS_DIR=/opt/models
RUN useradd --system --uid 10001 --no-create-home ml
WORKDIR /app
COPY --from=build /opt/venv /opt/venv
COPY --from=build /opt/models /opt/models
COPY app.py feature_spec.json ./
COPY ml ./ml
USER ml
EXPOSE 5000
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/health', timeout=3)"]
CMD ["uvicorn", "app:create_app", "--factory", "--host", "0.0.0.0", "--port", "5000", "--workers", "2"]
