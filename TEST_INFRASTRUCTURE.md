# Test Infrastructure

This repo uses isolated Docker test services to avoid conflicts with running dev/prod stacks.

**Production** uses `docker-compose.yml` + `docker-compose.production.yml` and `/etc/veralux/voice-runtime.env` (see **PRODUCTION_TOPOLOGY.md**) — do **not** point production at `docker-compose.test.yml` unless you are explicitly testing.

## Services and Ports

- Postgres test: `127.0.0.1:55432`
- Redis test: `127.0.0.1:56379`
- Compose file: `docker-compose.test.yml`

## Quick Start

```bash
cp .env.test.example .env.test
./scripts/test-infra.sh up
./scripts/test-infra.sh wait
./scripts/test-infra.sh reset
```

## Run Readiness Tests

```bash
npm run test:production-readiness
```

Or run by service:

```bash
cd control-plane && npm run test:production-readiness
cd ../veralux-voice-runtime && npm run test:production-readiness
```

## Status and Logs

```bash
./scripts/test-infra.sh status
./scripts/test-infra.sh logs
```

## Cleanup

```bash
./scripts/test-infra.sh down
```

## Troubleshooting

- Port conflict:
  - `ss -ltnp | rg "55432|56379"`
  - update `DATABASE_URL` / `REDIS_URL` and rerun tests
- Health check failures:
  - `./scripts/test-infra.sh logs`
  - verify Docker daemon is running
- Compose conflicts with existing stacks:
  - this test stack uses separate project and container names; if stale containers remain, run `./scripts/test-infra.sh down` and retry.
