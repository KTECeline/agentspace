SHELL := /bin/bash
PY := packages/sdk-python
UV := cd $(PY) && VIRTUAL_ENV= uv
SCHEMA := spec/v0.1/event.schema.json

.PHONY: install gen-types lint typecheck test test-py test-ts dev demo demo-story demo-check up down check-generated record

install: ## Install all JS and Python dependencies
	pnpm install
	$(UV) sync

gen-types: ## Regenerate TS + Python types from the JSON Schema
	pnpm --filter @agentspace/spec-types gen
	$(UV) run datamodel-codegen --input ../../$(SCHEMA) --input-file-type jsonschema \
	  --output-model-type pydantic_v2.BaseModel --target-python-version 3.10 \
	  --use-annotated --use-union-operator --enum-field-as-literal all --disable-timestamp \
	  --formatters ruff-format \
	  --custom-file-header '# GENERATED from spec/v0.1/event.schema.json by `make gen-types`. Do not edit.' \
	  --output agentspace/models/_generated.py

check-generated: gen-types ## Fail if generated files are out of date
	git diff --exit-code -- packages/spec-types/src $(PY)/agentspace/models

lint:
	pnpm -r lint
	$(UV) run ruff check .
	$(UV) run ruff format --check .

typecheck:
	pnpm -r typecheck
	$(UV) run mypy

test: test-py test-ts

test-py:
	$(UV) run pytest -q

test-ts:
	pnpm -r test

dev: ## Run collector + web locally with hot reload
	pnpm --parallel --filter @agentspace/server --filter @agentspace/web dev

up: ## Start collector + web in Docker
	docker compose up -d --build

down:
	docker compose down

demo: up ## Start everything and run the example with the fake model
	cd examples/langgraph-dev-team && VIRTUAL_ENV= uv run python main.py --fake

STORY_COMPOSE = -f docker-compose.yml -f examples/langgraph-dev-team/compose.story.yml

demo-story: ## The failure story: a collector with the story policy, 5 good runs, then one that goes wrong
	docker compose $(STORY_COMPOSE) up -d --build
	cd examples/langgraph-dev-team && VIRTUAL_ENV= uv run python main.py --story

record: ## Save the latest finished run as the /demo recording (RUN=<run_id> to pick one)
	node scripts/record.mjs $(if $(RUN),--run $(RUN),)

demo-check: ## Phase 1 "done" check: kill the collector mid-run, example must still exit 0
	./scripts/demo_check.sh
