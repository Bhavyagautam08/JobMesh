import autocannon from "autocannon";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/config/database.js";
import { redis } from "../src/config/redis.js";
import { createJob } from "../src/services/job.service.js";
import { claimJob } from "../src/services/job.execution.service.js";
import { completeJob } from "../src/services/job.completion.service.js";
import { ensureConsumerGroup } from "../src/queue/redis.consumer.js";
import { publishJobEvent } from "../src/queue/redis.producer.js";
import { JOB_STATUS } from "../src/utils/job-status.js";

const directory = dirname(fileURLToPath(import.meta.url));
const resultsDirectory = join(directory, "results");
const localBenchmark = process.argv.includes("--local");
const focusedBenchmark = process.argv.includes("--focused");
const baseUrl = process.env.BENCHMARK_BASE_URL || (localBenchmark ? "http://127.0.0.1:5000" : undefined);
const workerPoolMax = process.env.BENCHMARK_WORKER_POOL_MAX || "2";
const workerPoolMaxValue = Number(workerPoolMax);
const runId = `matrix-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 6)}`;
const postgresContainer = process.env.BENCHMARK_POSTGRES_CONTAINER
  || (localBenchmark ? "jobmesh-benchmark-postgres" : "distributed-job-postgres");
const redisContainer = process.env.BENCHMARK_REDIS_CONTAINER
  || (localBenchmark ? "jobmesh-benchmark-redis" : "redis");
const report = {
  runId,
  startedAt: new Date().toISOString(),
  environment: {
    baseUrl,
    target: process.env.BENCHMARK_TARGET,
    postgres: localBenchmark ? "local Docker PostgreSQL" : "DATABASE_URL (dedicated staging database)",
    redis: localBenchmark ? "local Docker Redis through benchmark REST adapter" : "Upstash REST (dedicated staging database)",
    workerPoolMax: workerPoolMaxValue,
    ratesPreviouslyCoveredAndSkipped: [1, 5, 10, 20],
    workerProcessesRunLocally: true,
    hostedApiAndServices: !localBenchmark,
    focusedBenchmark
  },
  scenarios: []
};

let benchmarkUserId;
let outboxProcess;
let apiProcess;
let redisAdapterProcess;
let activeWorkers = [];
let stopping = false;
let samplingTimer;
let activeResourceSamples = [];
let previousProcessSample;
let backlogSamplingTimer;
let resourceSampleInFlight = false;

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

async function saveReport() {
  await mkdir(resultsDirectory, { recursive: true });
  const reportPath = join(resultsDirectory, `${runId}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

async function saveScenarioResult(name, result) {
  await mkdir(resultsDirectory, { recursive: true });
  const path = join(resultsDirectory, `${runId}-${name}.json`);
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return path;
}

function spawnNode(script, workerId, extraEnv = {}) {
  const child = spawn(process.execPath, [script], {
    cwd: join(directory, ".."),
    env: {
      ...process.env,
      ...(workerId ? { DATABASE_POOL_MAX: workerPoolMax, WORKER_ID: workerId } : {}),
      ...extraEnv
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => process.stderr.write(`[${workerId || script}] ${chunk}`));
  child.on("error", (error) => console.error(`[${workerId || script}] process error:`, error));
  return child;
}

function waitForExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Process ${child.pid} did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForExit(child);
}

async function startOutboxPublisher(env = {}) {
  outboxProcess = spawnNode("src/queue/outbox.worker.js", "matrix-outbox", env);
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (outboxProcess.exitCode !== null) throw new Error("Outbox publisher exited during startup");
  return outboxProcess;
}

async function startRedisRestAdapter() {
  redisAdapterProcess = spawnNode("benchmarks/local-redis-rest-adapter.js", "local-redis-rest-adapter");
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    if (redisAdapterProcess.exitCode !== null) {
      throw new Error(`Local Redis REST adapter exited with code ${redisAdapterProcess.exitCode}`);
    }
    try {
      if (await redis.ping() === "PONG") return redisAdapterProcess;
      lastError = new Error("Redis REST adapter returned an unexpected PING response");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Local Redis REST adapter did not become ready within 15 seconds: ${lastError?.message || "no response"}`);
}

async function startLocalApi() {
  apiProcess = spawnNode("server.js", "local-api", {
    PORT: new URL(baseUrl).port || "5000",
    DATABASE_URL: process.env.DATABASE_URL,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    RATE_LIMIT_MAX_REQUESTS: "20000"
  });
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    if (apiProcess.exitCode !== null) {
      throw new Error(`Local API exited with code ${apiProcess.exitCode}`);
    }
    try {
      const response = await fetch(new URL("/api/ready", baseUrl));
      if (response.ok) return apiProcess;
      lastError = new Error(`API readiness endpoint returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Local API did not become ready within 30 seconds: ${lastError?.message || "no response"}`);
}

async function startWorkers(count, prefix = "matrix-worker") {
  activeWorkers = Array.from({ length: count }, (_, index) =>
    spawnNode("src/workers/job.worker.js", `${prefix}-${String(index + 1).padStart(2, "0")}`)
  );
  await new Promise((resolve) => setTimeout(resolve, 700));
  const exited = activeWorkers.filter((worker) => worker.exitCode !== null);
  if (exited.length) throw new Error(`${exited.length} worker process(es) exited during startup`);
  return activeWorkers;
}

async function stopWorkers() {
  const workers = activeWorkers;
  activeWorkers = [];
  await Promise.all(workers.map(stopProcess));
}

async function registerBenchmarkAccount() {
  const email = `${runId}@jobmesh.test`;
  const response = await fetch(new URL("/api/auth/register", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      displayName: "JobMesh Matrix",
      password: "matrix-benchmark-password"
    })
  });
  if (response.status !== 201) {
    throw new Error(`Benchmark account registration failed with HTTP ${response.status}: ${await response.text()}`);
  }
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Benchmark account registration returned no session cookie");
  const user = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
  if (!user.rows[0]) throw new Error("Registered benchmark user is missing from isolated PostgreSQL");
  benchmarkUserId = user.rows[0].id;
  return cookie;
}

function payloadFor(type, ordinal) {
  if (type === "calculate_primes") return { maxLimit: [200, 300, 400][ordinal % 3] };
  if (type === "process_json") return { data: { sequence: ordinal, batch: [{ id: ordinal, value: true }] } };
  if (type === "cpu_intensive") return { iterations: [250000, 500000, 1000000][ordinal % 3] };
  return { durationMs: [100, 250, 500][ordinal % 3] };
}

function buildRequests(count, cookie, prefix) {
  const types = ["calculate_primes", "process_json", "cpu_intensive", "long_running"];
  const ordinals = new Map(types.map((type) => [type, 0]));
  return Array.from({ length: count }, (_, index) => {
    const type = types[index % types.length];
    const ordinal = ordinals.get(type);
    ordinals.set(type, ordinal + 1);
    return {
      method: "POST",
      path: "/api/jobs",
      headers: {
        "content-type": "application/json",
        cookie,
        "Idempotency-Key": `${prefix}:${String(index).padStart(6, "0")}`
      },
      body: JSON.stringify({ type, payload: payloadFor(type, ordinal) })
    };
  });
}

function buildUniqueRequest(count, cookie, prefix) {
  const requests = buildRequests(count, cookie, prefix);
  let nextRequest = 0;
  return [{
    method: "POST",
    path: "/api/jobs",
    headers: { "content-type": "application/json", cookie },
    setupRequest(request) {
      const next = requests[nextRequest++];
      if (!next) throw new Error(`Autocannon attempted more than ${count} unique requests`);
      return {
        ...request,
        headers: { ...request.headers, ...next.headers },
        body: next.body
      };
    }
  }];
}

async function queryRunJobs(prefix) {
  return pool.query(
    `SELECT j.id, j.type, j.status, j.attempt_count, j.created_at, j.completed_at,
            MIN(a.started_at) AS first_started_at
     FROM jobs j
     LEFT JOIN job_attempts a ON a.job_id = j.id AND a.attempt_number = 1
     WHERE LEFT(j.idempotency_key, LENGTH($1)) = $1
     GROUP BY j.id`,
    [prefix]
  );
}

async function waitForCompletion(prefix, expected, timeoutMs = 300000, onSample = null) {
  const startedAt = performance.now();
  let maxDatabaseConnections = 0;
  const completionMilestones = { "50": null, "95": null, "100": null };
  let latestCount = 0;
  while (performance.now() - startedAt < timeoutMs) {
    const result = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS success,
              COUNT(*) FILTER (WHERE status IN ('FAILED', 'CANCELLED'))::int AS failed,
              COUNT(*) FILTER (WHERE status IN ('SUCCESS', 'FAILED', 'CANCELLED'))::int AS terminal
       FROM jobs WHERE LEFT(idempotency_key, LENGTH($1)) = $1`,
      [prefix]
    );
    const counts = result.rows[0];
    latestCount = counts.terminal;
    if (counts.failed > 0) throw new Error(`${counts.failed} jobs failed in scenario ${prefix}`);
    if (onSample) await onSample(counts);
    const connectionCount = await pool.query(
      "SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()"
    );
    maxDatabaseConnections = Math.max(maxDatabaseConnections, connectionCount.rows[0].count);
    const elapsedMs = performance.now() - startedAt;
    for (const threshold of [50, 95, 100]) {
      const key = String(threshold);
      if (completionMilestones[key] === null && counts.success >= Math.ceil(expected * threshold / 100)) {
        completionMilestones[key] = Number(elapsedMs.toFixed(3));
      }
    }
    if (counts.terminal === expected) {
      return {
        elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
        maxDatabaseConnections,
        completionMilestones,
        ...counts
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${latestCount}/${expected} terminal jobs in ${prefix}`);
}

async function waitForOutbox(prefix, timeoutMs = 600000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM outbox_events
       WHERE aggregate_id IN (SELECT id FROM jobs WHERE LEFT(idempotency_key, LENGTH($1)) = $1)
         AND published = FALSE`,
      [prefix]
    );
    if (result.rows[0].count === 0) {
      return { elapsedMs: Date.now() - startedAt, pendingEvents: 0 };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Outbox events for ${prefix} were not published before timeout`);
}

async function waitForOutboxEvent(eventId, timeoutMs = 120000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await pool.query(
      "SELECT published FROM outbox_events WHERE id = $1",
      [eventId]
    );
    if (result.rows[0]?.published) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Outbox event ${eventId} was not published before timeout`);
}

async function databaseMetrics(prefix) {
  const result = await queryRunJobs(prefix);
  const jobs = result.rows;
  const queueWait = jobs
    .filter((job) => job.first_started_at)
    .map((job) => new Date(job.first_started_at) - new Date(job.created_at));
  const endToEnd = jobs
    .filter((job) => job.completed_at)
    .map((job) => new Date(job.completed_at) - new Date(job.created_at));
  const firstCreated = jobs.length ? Math.min(...jobs.map((job) => new Date(job.created_at).getTime())) : null;
  const lastCompleted = jobs.length ? Math.max(...jobs.filter((job) => job.completed_at).map((job) => new Date(job.completed_at).getTime())) : null;
  return {
    jobs: jobs.length,
    succeeded: jobs.filter((job) => job.status === JOB_STATUS.SUCCESS).length,
    failed: jobs.filter((job) => job.status === JOB_STATUS.FAILED).length,
    uniqueJobIds: new Set(jobs.map((job) => job.id)).size,
    retryAttempts: jobs.reduce((total, job) => total + Math.max(0, Number(job.attempt_count) - 1), 0),
    completionThroughputJobsPerSecond: firstCreated && lastCompleted > firstCreated
      ? Number((jobs.length / ((lastCompleted - firstCreated) / 1000)).toFixed(3))
      : null,
    queueWaitMs: {
      p50: percentile(queueWait, 0.5),
      p95: percentile(queueWait, 0.95),
      p99: percentile(queueWait, 0.99)
    },
    endToEndMs: {
      p50: percentile(endToEnd, 0.5),
      p95: percentile(endToEnd, 0.95),
      p99: percentile(endToEnd, 0.99)
    }
  };
}

async function runLoadRate(rate, count, cookie, results) {
  const prefix = `benchmark:${runId}:load-${rate}:`;
  const responseLatency = [];
  const statuses = new Map();
  const start = new Date().toISOString();
  const tracker = autocannon({
    url: baseUrl,
    connections: Math.min(rate, 100),
    pipelining: 1,
    amount: count,
    overallRate: rate,
    requests: buildUniqueRequest(count, cookie, prefix)
  });
  tracker.on("response", (_client, statusCode, _responseBytes, latencyMs) => {
    responseLatency.push(latencyMs);
    statuses.set(statusCode, (statuses.get(statusCode) || 0) + 1);
  });
  const http = await tracker;
  const persisted = await pool.query(
    "SELECT COUNT(*)::int AS count FROM jobs WHERE LEFT(idempotency_key, LENGTH($1)) = $1",
    [prefix]
  );
  if (persisted.rows[0].count !== count) throw new Error(`Only ${persisted.rows[0].count}/${count} load-ramp requests persisted at ${rate} req/s`);
  const completion = await waitForCompletion(prefix, count);
  const jobMetrics = await databaseMetrics(prefix);
  const result = {
    category: "load-ramp",
    rate,
    targetRequestsPerSecond: rate,
    jobsRequested: count,
    startedAt: start,
    http: {
      requests: http.requests.total,
      achievedRequestsPerSecond: http.requests.average,
      statusCounts: Object.fromEntries(statuses),
      transportErrors: http.errors + http.timeouts,
      non2xx: http.non2xx,
      apiLatencyMs: { samples: responseLatency.length, p50: percentile(responseLatency, 0.5), p95: percentile(responseLatency, 0.95), p99: percentile(responseLatency, 0.99) }
    },
    jobMetrics,
    completionWait: completion
  };
  result.passed = http.requests.total === count
    && http.non2xx === 0
    && http.errors === 0
    && http.timeouts === 0
    && statuses.get(201) === count
    && jobMetrics.succeeded === count;
  results.push(result);
  await saveReport();
  if (!result.passed) throw new Error(`Load-ramp outcome invariant failed at ${rate} req/s`);
  return result;
}

async function runIdempotencyContention(concurrency, cookie, results) {
  const key = `benchmark:${runId}:contended:${concurrency}`;
  const gate = Promise.withResolvers();
  const requests = Array.from({ length: concurrency }, async (_, index) => {
    await gate.promise;
    const response = await fetch(new URL("/api/jobs", baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "Idempotency-Key": key
      },
      body: JSON.stringify({
        type: "process_json",
        payload: { contender: index, conflictingValue: randomUUID() }
      })
    });
    const body = await response.json();
    return { status: response.status, success: body.success, jobId: body.job?.id };
  });
  const startedAt = performance.now();
  gate.resolve();
  const responses = await Promise.all(requests);
  const elapsedMs = performance.now() - startedAt;
  const jobs = await pool.query("SELECT id, payload FROM jobs WHERE user_id = $1 AND idempotency_key = $2", [benchmarkUserId, key]);
  const outbox = jobs.rows[0]
    ? await pool.query("SELECT COUNT(*)::int AS count FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'JOB_CREATED'", [jobs.rows[0].id])
    : { rows: [{ count: 0 }] };
  const responseIds = new Set(responses.map((response) => response.jobId));
  const result = {
    category: "idempotency-contention",
    concurrency,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    responses: responses.length,
    statusCounts: Object.fromEntries([...new Set(responses.map(({ status }) => status))].map((status) => [
      status,
      responses.filter((response) => response.status === status).length
    ])),
    successfulResponses: responses.filter((response) => response.success).length,
    responseJobIds: responseIds.size,
    persistedJobs: jobs.rowCount,
    durableJobCreatedEvents: outbox.rows[0].count,
    conflictingPayloadWinnerIsOneContender: jobs.rows[0]
      ? Number.isInteger(jobs.rows[0].payload.contender) && jobs.rows[0].payload.contender >= 0 && jobs.rows[0].payload.contender < concurrency
      : false,
    invariantPassed: responses.length === concurrency
      && responses.every((response) => response.success)
      && responseIds.size === 1
      && jobs.rowCount === 1
      && outbox.rows[0].count === 1
  };
  results.push(result);
  await saveReport();
  if (!result.invariantPassed) throw new Error(`Idempotency invariant failed at ${concurrency} concurrent clients`);
  return result;
}

async function runClaimContention(concurrency, results) {
  const created = await createJob({
    userId: benchmarkUserId,
    type: "process_json",
    payload: { test: "atomic-claim-contention" },
    idempotencyKey: `benchmark:${runId}:claim-contention:${concurrency}`
  });
  const start = performance.now();
  const claims = await Promise.all(Array.from({ length: concurrency }, (_, index) =>
    claimJob(created.data.id, `claim-contender-${concurrency}-${index}`)
  ));
  const elapsedMs = performance.now() - start;
  const winners = claims.filter(Boolean);
  const attempts = await pool.query("SELECT COUNT(*)::int AS count FROM job_attempts WHERE job_id = $1", [created.data.id]);
  if (winners[0]) await completeJob(created.data.id, { benchmark: "one-winner" });
  const result = {
    category: "atomic-claim-contention",
    concurrency,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    successfulClaims: winners.length,
    attemptRows: attempts.rows[0].count,
    uniqueWinningWorkers: new Set(winners.map(({ locked_by: workerId }) => workerId)).size,
    invariantPassed: winners.length === 1 && attempts.rows[0].count === 1
  };
  results.push(result);
  await saveReport();
  if (!result.invariantPassed) throw new Error(`Atomic claim invariant failed at ${concurrency} contenders`);
  return result;
}

async function seedJobs(prefix, specs) {
  const ids = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [index, spec] of specs.entries()) {
      const idempotencyKey = `${prefix}${String(index).padStart(6, "0")}`;
      const inserted = await client.query(
        `INSERT INTO jobs (user_id, type, payload, status, idempotency_key, max_attempts)
         VALUES ($1, $2, $3, $4, $5, 3) RETURNING id`,
        [benchmarkUserId, spec.type, spec.payload, JOB_STATUS.QUEUED, idempotencyKey]
      );
      ids.push(inserted.rows[0].id);
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_id, payload)
         VALUES ('JOB_CREATED', $1, $2)`,
        [inserted.rows[0].id, { jobId: inserted.rows[0].id, type: spec.type, payload: spec.payload }]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return ids;
}

function parseDockerBytes(value) {
  const match = value.match(/([\d.]+)\s*(B|KiB|MiB|GiB)/i);
  if (!match) return null;
  const multiplier = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[match[2]];
  return Math.round(Number(match[1]) * multiplier);
}

function runCommand(executable, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      settled = true;
      reject(new Error(`${executable} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${executable} exited with code ${code} (${signal || "no signal"})`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function sampleLocalResources() {
  const processIds = [apiProcess, ...activeWorkers]
    .filter((child) => child && child.exitCode === null)
    .map(({ pid }) => pid)
    .filter(Number.isInteger);
  const sample = { timestamp: null, api: null, workers: [], postgres: null, redis: null };
  if (!processIds.length) {
    sample.timestamp = new Date().toISOString();
    sample.sampleError = "No API or worker processes were available to sample";
    return sample;
  }

  const processScript = `$pids=@(${processIds.join(",")}); Get-Process -Id $pids -ErrorAction SilentlyContinue | Select-Object Id,CPU,WorkingSet64 | ConvertTo-Json -Compress`;
  const dockerArgs = [
    "stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}",
    postgresContainer, redisContainer
  ];
  const [processOutcome, dockerOutcome] = await Promise.all([
    runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", processScript], 10000)
      .then((result) => ({ result }))
      .catch((error) => ({ error })),
    runCommand("docker", dockerArgs, 15000)
      .then((result) => ({ result }))
      .catch((error) => ({ error }))
  ]);
  if (processOutcome.error) {
    sample.processSampleError = processOutcome.error.message;
  } else if (!processOutcome.result.stdout.trim()) {
    sample.processSampleError = "PowerShell returned no process resource data";
  } else {
    try {
      const rows = JSON.parse(processOutcome.result.stdout);
      const previousTime = previousProcessSample?.timeMs;
      const elapsedSeconds = previousTime ? (Date.now() - previousTime) / 1000 : null;
      const previousByPid = new Map((previousProcessSample?.processes || []).map((item) => [item.pid, item.cpuSeconds]));
      const processes = (Array.isArray(rows) ? rows : [rows]).map((row) => {
        const pid = Number(row.Id);
        const cpuSeconds = Number(row.CPU || 0);
        const previousCpuSeconds = previousByPid.get(pid);
        return {
          pid,
          cpuSeconds,
          cpuPercentOfHost: elapsedSeconds && previousCpuSeconds !== undefined
            ? Number((((cpuSeconds - previousCpuSeconds) / elapsedSeconds / availableParallelism()) * 100).toFixed(3))
            : null,
          workingSetBytes: Number(row.WorkingSet64 || 0)
        };
      });
      previousProcessSample = {
        timeMs: Date.now(),
        processes: processes.map(({ pid, cpuSeconds }) => ({ pid, cpuSeconds }))
      };
      const apiPid = apiProcess?.pid;
      sample.api = processes.find(({ pid }) => pid === apiPid) || null;
      sample.workers = processes.filter(({ pid }) => activeWorkers.some((worker) => worker.pid === pid));
    } catch (error) {
      sample.processSampleError = `Unable to parse process resource sample: ${error.message}`;
    }
  }

  if (dockerOutcome.error) {
    sample.containerSampleError = dockerOutcome.error.message;
  } else {
    for (const line of dockerOutcome.result.stdout.trim().split(/\r?\n/).filter(Boolean)) {
      const [name, cpu, memory] = line.split("|");
      const [usedMemory, memoryLimit] = (memory || "").split("/").map((part) => part.trim());
      const containerSample = {
        cpuPercent: Number.parseFloat(cpu),
        memoryUsedBytes: usedMemory ? parseDockerBytes(usedMemory) : null,
        memoryLimitBytes: memoryLimit ? parseDockerBytes(memoryLimit) : null,
        memoryUsage: memory || null
      };
      if (name === postgresContainer || name === postgresContainer.replace(/^\//, "")) sample.postgres = containerSample;
      if (name === redisContainer || name === redisContainer.replace(/^\//, "")) sample.redis = containerSample;
    }
    if (!sample.postgres || !sample.redis) {
      sample.containerSampleError = `docker stats did not return both ${postgresContainer} and ${redisContainer}`;
    }
  }
  sample.timestamp = new Date().toISOString();
  return sample;
}

async function captureResourceSample() {
  if (resourceSampleInFlight) return;
  resourceSampleInFlight = true;
  try {
    activeResourceSamples.push(await sampleLocalResources());
  } finally {
    resourceSampleInFlight = false;
  }
}

async function startResourceSampling() {
  activeResourceSamples = [];
  previousProcessSample = undefined;
  await captureResourceSample();
  samplingTimer = setInterval(() => {
    void captureResourceSample().catch((error) =>
      console.error("Local process/container sampling failed:", error.message)
    );
  }, 1000);
}

async function stopResourceSampling(name) {
  if (samplingTimer) clearInterval(samplingTimer);
  samplingTimer = undefined;
  while (resourceSampleInFlight) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await captureResourceSample();
  const samples = activeResourceSamples;
  const path = await saveScenarioResult(`${name}-resource-samples`, samples);
  return { samples, path };
}

function summarizeResourceSampling(samples, expectedWorkerCount) {
  const intervals = samples.slice(1).map((sample, index) =>
    new Date(sample.timestamp) - new Date(samples[index].timestamp)
  );
  const errors = samples.flatMap((sample, index) => {
    const sampleErrors = [];
    if (sample.processSampleError) sampleErrors.push(`sample ${index + 1}: ${sample.processSampleError}`);
    if (sample.containerSampleError) sampleErrors.push(`sample ${index + 1}: ${sample.containerSampleError}`);
    if (!sample.api || sample.workers.length !== expectedWorkerCount) {
      sampleErrors.push(`sample ${index + 1}: expected API and ${expectedWorkerCount} worker process samples`);
    }
    if (!sample.postgres || !sample.redis) {
      sampleErrors.push(`sample ${index + 1}: expected PostgreSQL and Redis container samples`);
    }
    return sampleErrors;
  });
  const maxIntervalMs = intervals.length ? Math.max(...intervals) : null;
  return {
    targetIntervalMs: 1000,
    sampleCount: samples.length,
    maxIntervalMs,
    errors,
    passed: samples.length > 1 && errors.length === 0 && maxIntervalMs <= 2500
  };
}

async function runWorkerScaling(count, handlerType, results) {
  const prefix = `benchmark:${runId}:scale-${handlerType}-${count}:`;
  const specs = Array.from({ length: 240 }, (_, index) => handlerType === "long_running"
    ? { type: handlerType, payload: { durationMs: 100 } }
    : { type: handlerType, payload: { iterations: 400000 } });
  await seedJobs(prefix, specs);
  report.activeScenario = { category: "worker-scaling", workerCount: count, handlerType, phase: "waiting-for-outbox" };
  await saveReport();
  try {
    await waitForOutbox(prefix, 600000);
  } catch (error) {
    report.activeScenario.error = error.message;
    await saveReport();
    throw error;
  }
  report.activeScenario.phase = "running-workers";
  await saveReport();
  await ensureConsumerGroup();
  const workers = await startWorkers(count, `scale-${count}`);
  if (localBenchmark) await startResourceSampling();
  const start = performance.now();
  const completion = await waitForCompletion(prefix, specs.length, 240000);
  const executionWallMs = performance.now() - start;
  const resourceCollection = localBenchmark
    ? await stopResourceSampling(`scale-${handlerType}-${count}`)
    : { samples: [], path: null };
  const metrics = await databaseMetrics(prefix);
  await stopWorkers();
  const resourceSampling = localBenchmark
    ? summarizeResourceSampling(resourceCollection.samples, count)
    : { targetIntervalMs: null, sampleCount: 0, maxIntervalMs: null, errors: [], passed: true };
  const result = {
    category: "worker-scaling",
    workerCount: count,
    handlerType,
    workload: { totalJobs: specs.length, handlerType, payload: handlerType === "long_running" ? { durationMs: 100 } : { iterations: 400000 } },
    executionWallMs: Number(executionWallMs.toFixed(3)),
    executionThroughputJobsPerSecond: Number((specs.length / (executionWallMs / 1000)).toFixed(3)),
    jobMetrics: metrics,
    maxDatabaseConnections: completion.maxDatabaseConnections,
    resourceSamples: resourceCollection.samples,
    resourceSamplesPath: resourceCollection.path,
    resourceSampling,
    passed: metrics.jobs === specs.length
      && metrics.succeeded === specs.length
      && metrics.failed === 0
      && resourceSampling.passed
  };
  delete report.activeScenario;
  results.push(result);
  await saveScenarioResult(`scale-${handlerType}-${count}`, result);
  await saveReport();
  return result;
}

async function runSustainedLoad(cookie, results) {
  const rate = 10;
  const count = 3000;
  const prefix = `benchmark:${runId}:sustained:`;
  report.activeScenario = {
    category: "sustained-load",
    phase: "submitting",
    requestedJobs: count,
    targetRequestsPerSecond: rate
  };
  await saveReport();
  const responseLatency = [];
  const samples = [];
  const startedAt = new Date().toISOString();
  const requests = buildUniqueRequest(count, cookie, prefix);
  const pollResources = async () => {
    if (stopping) return;
    try {
      const [counts, pgConnections] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) FILTER (WHERE status = 'QUEUED')::int AS queued,
                  COUNT(*) FILTER (WHERE status = 'RUNNING')::int AS running,
                  COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS succeeded,
                  COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed
           FROM jobs WHERE LEFT(idempotency_key, LENGTH($1)) = $1`,
          [prefix]
        ),
        pool.query("SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()")
      ]);
      let apiRssBytes = null;
      if (!localBenchmark) {
        const apiResponse = await fetch(new URL("/api/metrics", baseUrl), { headers: { Cookie: cookie } });
        if (!apiResponse.ok) throw new Error(`API metrics endpoint returned HTTP ${apiResponse.status}`);
        const apiMetrics = await apiResponse.json();
        apiRssBytes = apiMetrics.metrics?.memory?.rss ?? null;
      }
      samples.push({
        timestamp: new Date().toISOString(),
        ...counts.rows[0],
        activeDatabaseConnections: pgConnections.rows[0].count,
        apiRssBytes
      });
    } catch (error) {
      console.error("Sustained-load resource sampling failed:", error.message);
      samples.push({ timestamp: new Date().toISOString(), sampleError: error.message });
    }
  };
  stopping = false;
  await pollResources();
  if (localBenchmark) await startResourceSampling();
  backlogSamplingTimer = setInterval(() => void pollResources(), 5000);
  const tracker = autocannon({
    url: baseUrl,
    connections: rate,
    pipelining: 1,
    amount: count,
    overallRate: rate,
    requests
  });
  tracker.on("response", (_client, _statusCode, _responseBytes, latencyMs) => responseLatency.push(latencyMs));
  const http = await tracker;
  clearInterval(backlogSamplingTimer);
  backlogSamplingTimer = undefined;
  await pollResources();
  const persisted = await pool.query(
    "SELECT COUNT(*)::int AS count FROM jobs WHERE LEFT(idempotency_key, LENGTH($1)) = $1",
    [prefix]
  );
  if (persisted.rows[0].count !== count) throw new Error(`Sustained run persisted ${persisted.rows[0].count}/${count} jobs`);
  const drainStartedAt = Date.now();
  report.activeScenario.phase = "waiting-for-completion";
  await saveReport();
  const drain = await waitForCompletion(prefix, count, 600000, async (counts) => {
    const completed = counts.success;
    for (const threshold of [50, 95, 100]) {
      const key = String(threshold);
      if (report.backlogDrain.milestonesMs[key] === null && completed >= Math.ceil(count * threshold / 100)) {
        report.backlogDrain.milestonesMs[key] = Date.now() - drainStartedAt;
        await saveReport();
      }
    }
  });
  const jobMetrics = await databaseMetrics(prefix);
  const handlerCountsResult = await pool.query(
    `SELECT type, COUNT(*)::int AS count
     FROM jobs WHERE LEFT(idempotency_key, LENGTH($1)) = $1
     GROUP BY type ORDER BY type`,
    [prefix]
  );
  const resourceCollection = localBenchmark
    ? await stopResourceSampling("sustained")
    : { samples: [], path: null };
  const processResourceSampling = localBenchmark
    ? summarizeResourceSampling(resourceCollection.samples, 4)
    : { targetIntervalMs: null, sampleCount: 0, maxIntervalMs: null, errors: [], passed: true };
  const submissionRate = http.duration > 0
    ? Number((http.requests.total / http.duration).toFixed(3))
    : null;
  const result = {
    category: "sustained-load",
    targetRequestsPerSecond: rate,
    durationSeconds: Number(http.duration.toFixed(3)),
    requestedJobs: count,
    submittedJobs: http.requests.total,
    submissionRateJobsPerSecond: submissionRate,
    workerCompletionRateJobsPerSecond: jobMetrics.completionThroughputJobsPerSecond,
    submissionToWorkerRateRatio: submissionRate && jobMetrics.completionThroughputJobsPerSecond
      ? Number((submissionRate / jobMetrics.completionThroughputJobsPerSecond).toFixed(3))
      : null,
    handlerType: "mixed",
    handlerCounts: Object.fromEntries(handlerCountsResult.rows.map(({ type, count: jobCount }) => [type, jobCount])),
    startedAt,
    endedAt: new Date().toISOString(),
    responseLatencyMs: {
      samples: responseLatency.length,
      p50: percentile(responseLatency, 0.5),
      p95: percentile(responseLatency, 0.95),
      p99: percentile(responseLatency, 0.99)
    },
    http: {
      sent: http.requests.total,
      achievedRequestsPerSecond: http.requests.average,
      statusCodeStats: http.statusCodeStats,
      errors: http.errors,
      timeouts: http.timeouts,
      non2xx: http.non2xx
    },
    jobMetrics,
    outboxDrain: { status: "pending" },
    backlogDrain: {
      startedAfterProducerStopped: true,
      milestonesMs: { ...report.backlogDrain.milestonesMs },
      totalDrainMs: drain.elapsedMs,
      maxDatabaseConnectionsWhileDraining: drain.maxDatabaseConnections
    },
    resourceSamples: samples,
    processAndContainerResourceSamples: resourceCollection.samples,
    processAndContainerResourceSamplesPath: resourceCollection.path,
    processAndContainerResourceSampling: processResourceSampling,
    resourceSummary: {
      samples: samples.length,
      maxApiRssBytes: Math.max(0, ...(
        localBenchmark
          ? resourceCollection.samples.map((sample) => sample.api?.workingSetBytes || 0)
          : samples.map((sample) => sample.apiRssBytes || 0)
      )),
      maxActiveDatabaseConnections: Math.max(0, ...samples.map((sample) => sample.activeDatabaseConnections || 0)),
      maxQueuedJobs: Math.max(0, ...samples.map((sample) => sample.queued || 0)),
      maxRunningJobs: Math.max(0, ...samples.map((sample) => sample.running || 0))
    }
  };
  delete report.activeScenario;
  results.push(result);
  report.backlogDrain = result.backlogDrain;
  result.passed = http.requests.total === count
    && http.non2xx === 0
    && http.errors === 0
    && http.timeouts === 0
    && jobMetrics.succeeded === count
    && samples.every((sample) => !sample.sampleError)
    && processResourceSampling.passed
    && [50, 95, 100].every((threshold) => result.backlogDrain.milestonesMs[String(threshold)] !== null);
  await saveScenarioResult("sustained", result);
  await saveReport();
  try {
    result.outboxDrain = {
      status: "complete",
      ...(await waitForOutbox(prefix, 600000))
    };
  } catch (error) {
    result.outboxDrain = { status: "timed_out", error: error.message };
    result.passed = false;
    await saveScenarioResult("sustained", result);
    await saveReport();
    throw error;
  }
  await saveScenarioResult("sustained", result);
  result.resourceSamplesPath = resourceCollection.path;
  await saveReport();
  if (!result.passed) throw new Error("Sustained-load outcome or resource-sampling invariant failed");
  return result;
}

async function runDuplicateDelivery(results) {
  await stopWorkers();
  const created = await createJob({
    userId: benchmarkUserId,
    type: "process_json",
    payload: { data: { test: "duplicate-delivery" } },
    idempotencyKey: `benchmark:${runId}:duplicate-delivery`
  });
  const jobId = created.data.id;
  const eventResult = await pool.query(
    "SELECT id, event_type, aggregate_id, payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'JOB_CREATED'",
    [jobId]
  );
  const event = eventResult.rows[0];
  if (!event) throw new Error("Duplicate-delivery fixture has no JOB_CREATED event");
  await waitForOutboxEvent(event.id);
  const duplicateStreamId = await publishJobEvent(event);
  if (!duplicateStreamId) throw new Error("Upstash did not return a stream ID for duplicate delivery");

  await startWorkers(2, "duplicate-delivery-worker");
  const completion = await waitForCompletion(`benchmark:${runId}:duplicate-delivery`, 1);
  const attempts = await pool.query("SELECT COUNT(*)::int AS count FROM job_attempts WHERE job_id = $1", [jobId]);
  const job = await pool.query("SELECT status FROM jobs WHERE id = $1", [jobId]);
  await stopWorkers();
  const result = {
    category: "duplicate-delivery",
    injectedCondition: "republished a successfully published JOB_CREATED event to the same Upstash stream",
    duplicateStreamId,
    workerAttempts: attempts.rows[0].count,
    finalStatus: job.rows[0].status,
    recoveryWaitMs: completion.elapsedMs,
    passed: job.rows[0].status === JOB_STATUS.SUCCESS
      && attempts.rows[0].count === 1
  };
  results.push(result);
  await saveReport();
  if (!result.passed) throw new Error("Duplicate-delivery/idempotent-claim invariant failed");
  return result;
}

function validateLocalBenchmarkConfig() {
  if (!process.argv.includes("--confirm-local-benchmark")) {
    throw new Error("Pass --confirm-local-benchmark to confirm that local benchmark data may be written.");
  }
  if (process.env.BENCHMARK_TARGET !== "local") {
    throw new Error("Set BENCHMARK_TARGET=local for the isolated local benchmark.");
  }
  for (const [name, value] of [
    ["BENCHMARK_BASE_URL", baseUrl],
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["UPSTASH_REDIS_REST_URL", process.env.UPSTASH_REDIS_REST_URL]
  ]) {
    if (!value) throw new Error(`${name} is required for a local benchmark.`);
  }
  const apiUrl = new URL(baseUrl);
  const databaseUrl = new URL(process.env.DATABASE_URL);
  const redisRestUrl = new URL(process.env.UPSTASH_REDIS_REST_URL);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (apiUrl.protocol !== "http:" || !localHosts.has(apiUrl.hostname) || apiUrl.port !== "5000") {
    throw new Error("Local BENCHMARK_BASE_URL must use HTTP on loopback port 5000.");
  }
  if (
    !localHosts.has(databaseUrl.hostname)
    || databaseUrl.port !== "55432"
    || databaseUrl.username !== "jobmesh_benchmark"
    || databaseUrl.pathname !== "/jobmesh_benchmark"
  ) {
    throw new Error("Local DATABASE_URL must point to the isolated benchmark PostgreSQL service on port 55432.");
  }
  if (
    redisRestUrl.protocol !== "http:"
    || !localHosts.has(redisRestUrl.hostname)
    || redisRestUrl.port !== "8079"
  ) {
    throw new Error("Local UPSTASH_REDIS_REST_URL must point to the loopback benchmark adapter on port 8079.");
  }
  const localRedisUrl = new URL(process.env.BENCHMARK_REDIS_URL || "redis://127.0.0.1:56379");
  if (!localHosts.has(localRedisUrl.hostname) || localRedisUrl.port !== "56379") {
    throw new Error("BENCHMARK_REDIS_URL must point to the isolated benchmark Redis service on port 56379.");
  }
}

async function initializeLocalDatabase() {
  const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
  await pool.query(schema);
}

function collectHostSpecs() {
  const command = "$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1; "
    + "$os=Get-CimInstance Win32_OperatingSystem; "
    + "[pscustomobject]@{CPU=$cpu.Name; Cores=$cpu.NumberOfCores; "
    + "LogicalProcessors=$cpu.NumberOfLogicalProcessors; "
    + "MemoryBytes=([int64]$os.TotalVisibleMemorySize * 1KB); "
    + "OS=$os.Caption; Version=$os.Version} | ConvertTo-Json -Compress";
  const host = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    timeout: 10000
  });
  if (host.status !== 0 || !host.stdout.trim()) {
    throw new Error(`Could not collect benchmark host information: ${host.stderr || host.status}`);
  }
  return JSON.parse(host.stdout);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Run with BENCHMARK_TARGET=staging and BENCHMARK_BASE_URL=https://<staging-api> npm run bench:matrix -- --confirm-staging-benchmark");
    console.log("DATABASE_URL and Upstash REST credentials must point to dedicated non-production staging services.");
    console.log("For a single-host run, use BENCHMARK_TARGET=local with loopback database/REST URLs and pass --local --focused --confirm-local-benchmark.");
    return;
  }
  if (localBenchmark) {
    validateLocalBenchmarkConfig();
    if (!Number.isInteger(workerPoolMaxValue) || workerPoolMaxValue < 1) {
      throw new Error("BENCHMARK_WORKER_POOL_MAX must be a positive integer");
    }
    await initializeLocalDatabase();
    await startRedisRestAdapter();
    await startLocalApi();
  } else {
    if (process.env.BENCHMARK_TARGET !== "staging" || !process.argv.includes("--confirm-staging-benchmark")) {
      throw new Error("Set BENCHMARK_TARGET=staging and pass --confirm-staging-benchmark; use dedicated, non-production PostgreSQL, Upstash Redis, and API services.");
    }
    if (!baseUrl) throw new Error("Set BENCHMARK_BASE_URL to the hosted staging API URL.");
    const apiUrl = new URL(baseUrl);
    if (apiUrl.protocol !== "https:") throw new Error("BENCHMARK_BASE_URL must use HTTPS for hosted staging.");
    const readiness = await fetch(new URL("/api/ready", baseUrl));
    if (!readiness.ok) throw new Error(`Hosted staging API is not ready: HTTP ${readiness.status}`);
  }
  if (!Number.isInteger(workerPoolMaxValue) || workerPoolMaxValue < 1) {
    throw new Error("BENCHMARK_WORKER_POOL_MAX must be a positive integer");
  }
  await ensureConsumerGroup();
  const cookie = await registerBenchmarkAccount();
  report.environment.host = collectHostSpecs();
  report.environment.sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: join(directory, "..", ".."),
    encoding: "utf8"
  }).stdout.trim();
  report.resultsPath = join(resultsDirectory, `${runId}.json`);
  await saveReport();

  if (!focusedBenchmark) await startWorkers(4, "load-ramp-worker");
  await startOutboxPublisher();

  if (!focusedBenchmark) {
    for (const rate of [25, 50]) {
      await runLoadRate(rate, 500, cookie, report.scenarios);
    }

    await stopWorkers();
    for (const concurrency of [100, 250]) {
      await runIdempotencyContention(concurrency, report.scenarios);
      await runClaimContention(concurrency, report.scenarios);
    }
  }

  for (const count of [1, 2, 4, 8, 16]) {
    for (const handlerType of ["long_running", "cpu_intensive"]) {
      await runWorkerScaling(count, handlerType, report.scenarios);
    }
  }

  await startWorkers(4, "sustained-worker");
  report.backlogDrain = { milestonesMs: { "50": null, "95": null, "100": null } };
  await runSustainedLoad(cookie, report.scenarios);

  if (!focusedBenchmark) await runDuplicateDelivery(report.scenarios);

  for (const scenario of report.scenarios.filter((item) => item.category === "worker-scaling")) {
    const singleWorkerThroughput = report.scenarios.find((item) =>
      item.category === "worker-scaling"
      && item.handlerType === scenario.handlerType
      && item.workerCount === 1
    )?.executionThroughputJobsPerSecond;
    const throughput = scenario.executionThroughputJobsPerSecond;
    scenario.speedup = singleWorkerThroughput
      ? Number((throughput / singleWorkerThroughput).toFixed(3))
      : null;
    scenario.scalingEfficiencyPct = singleWorkerThroughput
      ? Number((throughput / (scenario.workerCount * singleWorkerThroughput) * 100).toFixed(2))
      : null;
    await saveScenarioResult(`scale-${scenario.handlerType}-${scenario.workerCount}`, scenario);
  }
  report.completedAt = new Date().toISOString();
  report.passed = report.scenarios.every((scenario) => scenario.passed !== false);
  console.log(JSON.stringify({
    reportPath: await saveReport(),
    completedAt: report.completedAt,
    passed: report.passed,
    scenarios: report.scenarios.map((scenario) => ({
      category: scenario.category,
      rate: scenario.rate,
      concurrency: scenario.concurrency,
      workers: scenario.workerCount,
      passed: scenario.passed
    }))
  }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

process.on("SIGINT", () => {
  stopping = true;
  if (samplingTimer) clearInterval(samplingTimer);
  if (backlogSamplingTimer) clearInterval(backlogSamplingTimer);
  process.exitCode = 130;
});

main()
  .catch(async (error) => {
    report.error = { message: error.message, stack: error.stack };
    report.completedAt = new Date().toISOString();
    await saveReport();
    console.error("Benchmark matrix failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    stopping = true;
    if (samplingTimer) clearInterval(samplingTimer);
    if (backlogSamplingTimer) clearInterval(backlogSamplingTimer);
    await stopWorkers();
    await stopProcess(outboxProcess);
    await stopProcess(apiProcess);
    await stopProcess(redisAdapterProcess);
    await pool.end();
  });
