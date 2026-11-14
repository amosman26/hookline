# Hookline

Reliable webhook delivery for your app: signed, retried and replayable.

> Work in progress. The first release (v0.1.0) covers endpoint registration,
> event ingestion and signed delivery. Progress is tracked in the commit history.

## Planned

- Register endpoints and subscribe them to event types
- HMAC-SHA256 signed payloads with replay protection
- Retries with exponential backoff and jitter, dead-lettering and manual replay
- Idempotency keys and per-key rate limiting
- A dashboard for endpoints, delivery attempts and response bodies

## Licence

MIT
