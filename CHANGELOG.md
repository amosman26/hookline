# Changelog

All notable changes to Hookline are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-23

First release: the core path from an accepted event to a signed delivery, with every
attempt recorded.

### Added

- Project API keys (`hl_live_…`) sent as `Authorization: Bearer <key>`; only a SHA-256
  hash of each key is stored. `GET /v1/project` returns the caller's project.
- A `create-key` command that mints a project and its first API key.
- Endpoint registration under `/v1/endpoints` (create, list, fetch, update, delete),
  scoped to the caller's project. Each endpoint subscribes to exact event types and
  gets its own `whsec_…` signing secret, returned only when it is created.
- Event ingestion with `POST /v1/events`: the event and one `pending` delivery per
  enabled, subscribed endpoint are written in a single transaction and queued after
  it commits (`202 Accepted`).
- `@hookline/signing`: HMAC-SHA256 over `{id}.{timestamp}.{body}`, sent as the
  `Hookline-Id`, `Hookline-Timestamp` and `Hookline-Signature` headers, with
  constant-time verification and support for signing with more than one secret.
- A BullMQ worker that delivers queued events with a 10 s timeout, doesn't follow
  redirects, and records every attempt (status code, duration, the first 4 KB of the
  response body, any error). On start-up it re-queues deliveries still pending.
- Postgres 16 schema and Drizzle migrations for projects, API keys, endpoints, events,
  deliveries and delivery attempts.
- Root `build` and `start` scripts; the API, worker and migrations read a root `.env`.
- Docker Compose for Postgres 16 and Redis 7.
- README with a quick start, API overview, signature verification example and an
  architecture diagram.

### Build and CI

- pnpm workspace with strict TypeScript, ESLint and Prettier.
- GitHub Actions runs lint, format check, typecheck and tests on every push, against
  `postgres:16` and `redis:7` service containers.
- Conventional Commits enforced with commitlint and Husky, locally and in CI.
- End-to-end test: an event posted to the API is delivered by a real worker to a local
  receiver and its signature is verified.

### Known limitations

- No retries yet: a non-2xx response or network error marks the delivery `failed`.
- No dead-lettering, replay, idempotency keys, rate limiting or timestamp tolerance in
  the verifier. These are planned for 0.2.0.

[Unreleased]: https://github.com/amosman26/hookline/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/amosman26/hookline/releases/tag/v0.1.0
