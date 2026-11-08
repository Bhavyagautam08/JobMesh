# JobMesh benchmark and test evidence

This document records the conditions and results behind the project’s
concurrency, reliability, load, and worker-scaling claims. The benchmark
artifacts were produced on October 8–10, 2026. These are historical results,
not measurements rerun as part of this documentation change.

## Resume-ready project bullets

- Built JobMesh, a fault-tolerant multi-process job queue with a Node.js/Express
  API, PostgreSQL transactional outbox, Redis Streams delivery, and independently
  running workers; added account-scoped idempotency, retry/attempt limits,
  heartbeats, and stale-job recovery.
- Verified concurrency and recovery with 250 simultaneous idempotent
  submissions, 250 competing claims on one job, worker-crash recovery, and a
  Redis outage after job commit; each contention test produced exactly one
  durable job/claim.
- On a single-host mixed-workload worker-scaling test, increased measured
  execution throughput from 12.50 jobs/s with 1 worker to 204.74 jobs/s with
  16 workers. A separate 3,000-job run reached SUCCESS for all jobs; its
  reconstructed records show 7.34 durable submissions/s and 5.90 s
  end-to-end p95.

The 3,000-job measurements are specifically qualified as **reconstructed**:
the original benchmark runner did not save its final in-memory report because
it failed while waiting for outbox events to drain. The jobs and HTTP results
were recovered from database state and request logs. Do not describe this as a
fully captured, clean benchmark report.

## At-a-glance: what the claims mean

| Claim | What was actually measured | Important qualification |
|---|---|---|
| 12.50 → 204.74 jobs/s | 240-job worker execution run at 1, 2, 4, 8, and 16 processes | Single host; throughput is 240 divided by execution wall time, not API submission throughput. |
| 3,000/3,000 jobs | 3,000 mixed jobs persisted and ultimately succeeded | Sustained-run summary reconstructed after the runner failed during outbox-drain reporting. |
| 7.34 jobs/s | 3,000 durable job submissions divided by a 408.806-second submission window | Target was 10 requests/s; this is the observed durable submission rate, not the target rate or worker completion rate. |
| 5.90 s end-to-end p95 | Database-created-to-completed time across the 3,000-job workload | Reconstructed from database records; distinct from API response latency (52.61 ms p95). |
| 250-way idempotency | 250 concurrent authenticated POST requests using one account and idempotency key | 249 HTTP 200 responses and one HTTP 201; one job and one durable outbox event. |
| 250 competing claims | 250 claim attempts against one queued job | Exactly one claim and one attempt row. |

## Test environment and methodology

### Local mixed-workload submission sweep

Source: `backend/benchmarks/results/local-load-sweep-context.json` and the
four `local-sweep-v2-*-200.json`/CSV reports.

- Windows host: 12th Gen Intel Core i5-12450H, 8 CPU cores, 12 logical
  processors.
- PostgreSQL 18.6 and Redis 8.10.1 ran in isolated, ephemeral local Docker
  containers; the API was reached at `http://localhost:5000`.
- Four worker processes; each run submitted 200 jobs: 50 each of
  `calculate_primes`, `process_json`, `cpu_intensive`, and `long_running`.
- Payload profiles varied by type: prime limits 400/600/800, JSON batches of
  16/64/128 items, CPU workloads of 250,000/500,000/1,000,000 iterations, and
  long-running durations of 100/250/500 ms.
- Autocannon sent 200 unique job-creation requests at the configured target
  rate. API latency percentiles use nearest-rank over the 200 raw response
  events. Job timing came from PostgreSQL; the report was written after all
  200 jobs reached a terminal state.
- The in-memory API rate limit was temporarily raised to 20,000 requests per
  minute for this isolated test and then restored. These short runs do not
  establish multi-host performance.

| Target submissions/s | HTTP 201 / requests | API latency p50 / p95 / p99 (ms) | Succeeded / failed | Terminal jobs/s | Queue wait p95 (ms) | End-to-end p95 (ms) | Retries | Redis stream lag at report |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 200 / 200 | 15.49 / 35.71 / 52.95 | 200 / 0 | 0.993 | 4,446.94 | 4,551.99 | 0 | 5 |
| 5 | 200 / 200 | 9.57 / 20.04 / 24.94 | 200 / 0 | 5.017 | 4,260.50 | 4,381.45 | 0 | 45 |
| 10 | 200 / 200 | 10.48 / 24.58 / 27.59 | 200 / 0 | 8.319 | 3,766.34 | 3,914.91 | 0 | 20 |
| 20 | 200 / 200 | 18.26 / 28.93 / 31.09 | 200 / 0 | 7.940 | 15,099.23 | 15,148.85 | 0 | 28 |

All four reports recorded zero HTTP errors and zero unpublished outbox events
after the run. The nonzero Redis stream lag values are report-time snapshots;
the runs should not be described as fully drained Redis streams. The 20/s
point is a 200-request burst, not a sustained-capacity result.

### Worker-process scaling

Source: `backend/benchmarks/results/matrix-recovered-summary.json`, from
`matrix-20261010222623243-33a1ee`.

- Same-host run on the 12th Gen Intel Core i5-12450H (8 cores / 12 logical
  processors), with local API and isolated Docker PostgreSQL and Redis.
- Each worker-count point used 240 jobs: 80 lightweight `process_json` jobs,
  80 `long_running` jobs with a 100 ms duration, and 80 `cpu_intensive` jobs
  with 400,000 iterations.
- Worker counts were 1, 2, 4, 8, and 16. The benchmark waited for the matching
  outbox events to publish, started the workers, then measured until all jobs
  succeeded. Throughput is 240 divided by this worker-execution wall time.
- Every point completed all 240 jobs with no failures or retry attempts.

| Workers | Jobs succeeded | Execution wall time (ms) | Execution throughput (jobs/s) | Speedup vs 1 worker | Scaling efficiency |
|---:|---:|---:|---:|---:|---:|
| 1 | 240 / 240 | 19,205.027 | 12.497 | 1.000x | 100.00% |
| 2 | 240 / 240 | 12,247.118 | 19.596 | 1.568x | 78.40% |
| 4 | 240 / 240 | 4,944.643 | 48.537 | 3.884x | 97.10% |
| 8 | 240 / 240 | 2,289.057 | 104.847 | 8.390x | 104.87% |
| 16 | 240 / 240 | 1,172.221 | 204.740 | 16.383x | 102.39% |

Values above 100% measured efficiency reflect the observed run timings and
should not be interpreted as a general scaling guarantee. The runner’s
database end-to-end timing also includes earlier time spent waiting for the
outbox publisher; the throughput column is based on the separate worker
execution window.

### Sustained 3,000-job workload

Source: sustained-load section of
`backend/benchmarks/results/matrix-recovered-summary.json`; implementation
conditions are in `backend/benchmarks/matrix-runner.js`.

- Same-host local API and isolated local Docker services; four workers.
- Target submission rate: 10 requests/s. The runner generated 3,000 unique,
  authenticated POST requests with a repeating four-type mix: 750 each of
  `calculate_primes`, `process_json`, `cpu_intensive`, and `long_running`.
  Payloads varied across prime limits 200/300/400, CPU iterations
  250,000/500,000/1,000,000, and long-running durations 100/250/500 ms; JSON
  payloads contained a small one-item batch.
- All 3,000 responses were HTTP 201; all 3,000 jobs were persisted and
  eventually reached SUCCESS, with zero failures.
- The measured submission window was 408.806 s, giving
  3,000 / 408.806 = 7.338 durable submissions/s (rounded to 7.34).
- API response latency over the 3,000 request-log samples: p50 22.18 ms,
  p95 52.61 ms, p99 72.45 ms, maximum 208.43 ms.
- End-to-end job time (creation to completion): p50 2,998.36 ms,
  p95 5,904.12 ms (5.90 s), p99 7,205.36 ms.
- Queue wait: p50 2,922.67 ms, p95 5,745.40 ms, p99 7,134.82 ms.
- The observed terminal-completion window was 412.314 s, or 7.276 completed
  jobs/s. This is separate from the durable submission rate.
- After the producer stopped, the recovered drain milestones were 50% in
  4 ms, 95% in 11 ms, and 100% in 2,541 ms.
- Worker/API resource samples were not recoverable.

**Recovery caveat:** the matrix runner timed out waiting for outbox events
during its sustained run and did not save the final in-memory report. The
3,000 persisted/successful counts and job latency metrics were reconstructed
from database state; the 3,000 HTTP 201 count and response latencies were
reconstructed from request logs. Thus, the outcome and listed metrics are
supported, but resource metrics and a complete original runner report are
unavailable.

### Rate-ramp tests

Source: `matrix-recovered-summary.json` (`loadRamp`).

The successful run used four workers and issued 500 authenticated job-creation
requests at each target rate. All requests returned HTTP 201, with no transport
errors or failed jobs:

| Target requests/s | Requests / successes | API response p50 / p95 / p99 (ms) | Completion throughput (jobs/s) | Queue wait p95 (ms) | End-to-end p95 (ms) |
|---:|---:|---:|---:|---:|---:|
| 25 | 500 / 500 | 37.31 / 164.83 / 210.39 | 8.022 | 38,359 | 38,404 |
| 50 | 500 / 500 | 83.72 / 238.25 / 258.88 | 9.331 | 43,413 | 43,542 |

An earlier, separate attempt at 25 requests/s persisted only 20 of 500
requests and failed; it is excluded from the successful table above. The
consolidated successful records are from the subsequent matrix run.

### Idempotency and atomic claim contention

Source: `matrix-recovered-summary.json` (`contention`), with implementation
in `backend/benchmarks/matrix-runner.js`.

- Idempotency: each concurrent request used the same authenticated account and
  the same key, but supplied a different contender payload. At 100 clients,
  100 responses referenced one job ID; 99 returned HTTP 200 and one HTTP 201.
  Exactly one job and one `JOB_CREATED` outbox event were persisted; elapsed
  time was 480.110 ms.
- At 250 clients, 250 responses referenced one job ID; 249 returned HTTP 200
  and one HTTP 201. Exactly one job and one `JOB_CREATED` outbox event were
  persisted; elapsed time was 656.671 ms.
- Claim contention: 100 and 250 simultaneous claim attempts were made for one
  queued job at each size. Each race produced exactly one successful claim,
  one unique winning worker, and one attempt row. Elapsed times were 179.302 ms
  at 100 contenders and 218.941 ms at 250.
- These are contention correctness tests, not sustained throughput tests.

The separate integration suite in
`backend/tests/concurrency-and-resilience.test.js` also tests 50 identical-key
submissions in waves of up to 15 and 20 workers racing to claim a job. It
expects one persisted job/outbox event and one successful claim, respectively.

### Failure and delivery-recovery scenarios

Sources: `matrix-20261010224341922-d3e236.json`,
`local-worker-crash-recovery.json`, and
`backend/tests/concurrency-and-resilience.test.js`.

| Scenario | Injected condition and observed outcome | Timing / limits |
|---|---|---|
| Redis outage after commit | Redis was paused before submission. The job remained QUEUED and its one outbox event remained durable/unpublished while Redis was unavailable. After service recovery, the job reached SUCCESS. | Reported 6.587 ms is measured after publisher/workers were restarted, not from the start of the outage. |
| Outbox publisher crash window | Terminated the publisher after Redis `XADD` succeeded but before PostgreSQL marked the outbox event published. Recovery caused a second stream copy; the worker still recorded one attempt and the job reached SUCCESS. | Process exit code 86; recorded recovery wait 27.698 ms. |
| Worker process crash | A real local worker process received SIGTERM after claiming a 3,000 ms `long_running` job. The test used a 1-second stale threshold and backdated the job by 3 seconds; production timeout is 5 minutes. Reconciliation requeued it, a replacement worker claimed attempt 2, and it succeeded. | Reconciliation 19.185 ms; reconciliation start to replacement claim 591.867 ms; to success 3,589.2 ms. |
| Integration crash-reconciliation test | The test claims a job as worker A, simulates staleness by backdating `updated_at` by 10 minutes, then runs reconciliation with the production 5-minute timeout. Worker B claims and completes it. A separate exhausted job at 3/3 attempts is marked FAILED. | This is a controlled database-state simulation, not a process-kill timing measurement. |
| Duplicate stream delivery | Republishes an already-published `JOB_CREATED` event and starts two workers. The job succeeds with one attempt. | Verifies duplicate delivery does not cause duplicate execution. |

The crash-recovery integration suite also tests maximum-attempt enforcement:
three failures with a three-attempt maximum produce a terminal FAILED job and a
fourth claim is rejected. It moves `scheduled_at` into the past between
attempts, so this test verifies retry eligibility and the attempt limit, not
real elapsed backoff timing.

### Older 399-job worker run

Source: `backend/benchmarks/results/399-jobs-workers-report.json`.

The recorded workload had 399 jobs across four types (100 each for
`calculate_primes`, `cpu_intensive`, and `process_json`; 99 `long_running`),
with 20 requested workers. All 399 succeeded, no jobs failed, and no retry
attempts were recorded. This is a separate October 8 worker-execution result;
it is not the 3,000-job sustained run and does not substantiate the
1–16-worker scaling rates.

## Interpretation and limitations

- The 12.50 and 204.74 jobs/s figures are measured for worker execution in a
  single-host mixed-workload test. They do not prove the same performance on
  multiple machines or hosted services.
- The 7.34 submissions/s figure is observed durable API submission throughput
  under a 10 requests/s target. The 5.90 s figure is end-to-end job p95, not
  API response p95.
- The 3,000-job run did complete all jobs successfully, but its final report
  was reconstructed. Do not imply that original resource samples or every
  original runner metric were captured.
- The local 1/5/10/20 sweep and matrix 25/50 load ramp are short 200/500
  request points, not long-duration saturation tests.
- All measurements are from isolated single-host setups. No multi-host
  distributed deployment benchmark is present in these artifacts.

## Source artifacts

- `backend/benchmarks/results/local-load-sweep-context.json`
- `backend/benchmarks/results/local-load-sweep-summary.csv`
- `backend/benchmarks/results/local-sweep-v2-r1-200.json`
- `backend/benchmarks/results/local-sweep-v2-r5-200.json`
- `backend/benchmarks/results/local-sweep-v2-r10-200.json`
- `backend/benchmarks/results/local-sweep-v2-r20-200.json`
- `backend/benchmarks/results/matrix-recovered-summary.json`
- `backend/benchmarks/results/matrix-20261010222623243-33a1ee.json`
- `backend/benchmarks/results/matrix-20261010224341922-d3e236.json`
- `backend/benchmarks/results/local-worker-crash-recovery.json`
- `backend/benchmarks/results/399-jobs-workers-report.json`
- `backend/benchmarks/matrix-runner.js`
- `backend/tests/concurrency-and-resilience.test.js`
