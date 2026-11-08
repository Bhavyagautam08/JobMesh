# JobMesh: Fault-Tolerant Job Queue

**JobMesh is a multi-process job queue built on Node.js, PostgreSQL, and Redis Streams using a transactional outbox, with at-least-once delivery.** Its Node.js API
accepts authenticated job requests and persists each job together with a
transactional outbox event in PostgreSQL. An outbox publisher delivers those
events through Redis Streams, where independently running workers compete to
claim and execute eligible jobs. PostgreSQL remains the durable source of
truth; the React dashboard provides a live view of job progress, worker
activity, queue health, and system metrics.

The project brings the control plane and execution plane together: a
browser-based operations console, a session-protected REST API, persistent
queue and attempt history, and background services for delivery, retries, and
recovery.

## How it works

```mermaid
flowchart LR
    UI[React dashboard] -->|Authenticated REST requests| API[Node.js API]
    API -->|Job and outbox event in one transaction| DB[(PostgreSQL)]
    DB -->|Unpublished events| OUTBOX[Outbox publisher]
    OUTBOX -->|Job events| REDIS[(Redis Streams)]
    REDIS --> WORKERS[Worker processes]
    WORKERS -->|Claim, execute, record result| DB
    RETRIES[Retry scheduler] --> DB
    RECOVERY[Reconciliation] --> DB
    API -->|Dashboard data and live metrics| UI
```

1. A client submits a job with a type, JSON payload, and idempotency key.
2. The API stores the `QUEUED` job and its `JOB_CREATED` outbox event in one
   PostgreSQL transaction, so a committed job cannot be separated from its
   delivery record.
3. The outbox publisher forwards pending events to a Redis Stream. Workers
   consume events and atomically claim due jobs in PostgreSQL before execution.
4. Each attempt is recorded. Successful results are persisted; failures can be
   retried with a delay up to the configured attempt limit.
5. Reconciliation identifies stale running jobs and requeues or fails them
   according to their remaining attempts.
6. The dashboard reads durable job and queue state from PostgreSQL and streams
   request metrics from the API.

## Capabilities

- **Asynchronous job execution:** submit work without tying up the API request
  while it runs.
- **Transactional event delivery:** persist a job and its outbox event together,
  then publish events to Redis Streams for worker consumption.
- **Safe concurrent claims:** workers use conditional PostgreSQL updates so a
  job is claimed by only one worker at a time.
- **Idempotent submissions:** scope idempotency keys to the authenticated user
  to avoid duplicate jobs from repeated requests.
- **Attempt history and retries:** record execution attempts, errors, results,
  and retry scheduling; enforce a configurable maximum attempt count.
- **Stuck-job recovery:** periodically inspect stale running jobs and make
  remaining work eligible for another attempt.
- **Account-scoped API access:** authenticate with password-based accounts and
  revocable, expiring sessions; restrict job data to its owner.
- **Operational visibility:** inspect job details, results, attempts, outbox
  delivery, queue health, worker leases, and API metrics from the dashboard.
- **Built-in workload types:** calculate primes, process JSON, run CPU-intensive
  work, and execute duration-based long-running jobs.

## Scope and limitations

- **Single-host evaluation:** All benchmarks and verification suites were run on a single host. Multi-host operation has not been tested.
- **At-least-once delivery:** Event delivery through Redis Streams provides at-least-once delivery, not exactly-once delivery. The atomic job claim in PostgreSQL absorbs duplicate deliveries to prevent duplicate job executions.
- **Backlog latency under sustained load:** The sustained 3,000-job benchmark's p95 latency reflects queue backlog because job submissions outpaced worker completion rates during the test.
- **Benchmark evidence:** Detailed test methodology, historical run parameters, and qualification notes are documented in [`test.md`](test.md), with raw result files archived in [`backend/benchmarks/results/`](backend/benchmarks/results/).

## Screenshots

### Command center

![JobMesh command center](docs/screenshots/dashboard-overview.png)

### Activity and outbox health

![Recent job activity, outbox events, and system health](docs/screenshots/dashboard-activity.png)

### Job details

![Job status and execution lifecycle](docs/screenshots/job-details.png)

### Execution details

![Execution attempts, payload, result, and queue state](docs/screenshots/job-execution.png)

Account details have been removed from the screenshots.

## Components

- **Frontend:** React, TypeScript, and Vite operations dashboard.
- **Backend:** Node.js and Express REST API, job handlers, and worker services.
- **Persistence:** PostgreSQL stores users, sessions, jobs, attempts, and
  transactional outbox events.
- **Delivery:** Redis Streams carries asynchronous events from the outbox to
  worker consumer groups.
- **Runtime configuration:** environment variables configure PostgreSQL,
  Upstash Redis, API limits, session expiry, retry policy, and worker identity.
- **CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) builds the
  frontend and runs backend tests against PostgreSQL.

## Local development

Use Node.js 22 or later, PostgreSQL, and an Upstash Redis REST database. Copy
[`backend/.env.example`](backend/.env.example) to `backend/.env` and configure
the database and Redis credentials.

Start each process in a separate terminal:

```sh
cd backend
npm ci
npm run dev
```

```sh
cd backend
npm run worker
```

```sh
cd frontend
npm ci
npm run dev
```

The backend test suite can be run with:

```sh
npm test --prefix backend
```

## Benchmarks and verification

Performance benchmarks, concurrency tests, and crash-recovery scenarios are documented with full methodology and qualification in [`test.md`](test.md). Historical raw evidence files (JSON, CSV) are preserved in [`backend/benchmarks/results/`](backend/benchmarks/results/). Additional benchmark instructions can be found in [`backend/benchmarks/README.md`](backend/benchmarks/README.md).
