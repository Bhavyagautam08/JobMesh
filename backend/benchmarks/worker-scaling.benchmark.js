import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pool } from "../src/config/database.js";
import { publishJobEvent } from "../src/queue/redis.producer.js";
import { ensureConsumerGroup } from "../src/queue/redis.consumer.js";
import { JOB_STATUS } from "../src/utils/job-status.js";

const WORKLOAD_SIZE = 24; // 24 jobs per benchmark run
const CPU_ITERATIONS = 400_000; // tuned to take ~60-80ms per job on single core
const WORKER_COUNTS = [1, 2, 4];

async function getOrCreateBenchmarkUser() {
    const res = await pool.query(
        `INSERT INTO users (email, display_name, password_hash)
         VALUES ($1, 'Scaling Benchmark', 'scaling-pass')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [`benchmark-scale-${randomUUID()}@example.test`]
    );
    if (res.rows.length > 0) return res.rows[0].id;
    const existing = await pool.query(`SELECT id FROM users LIMIT 1`);
    return existing.rows[0].id;
}

async function prepareWorkload(userId, runTag) {
    const jobIds = [];
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        for (let i = 0; i < WORKLOAD_SIZE; i++) {
            const idempotencyKey = `scale-${runTag}-${i}-${randomUUID()}`;
            const insertRes = await client.query(
                `INSERT INTO jobs (user_id, type, payload, status, idempotency_key, max_attempts)
                 VALUES ($1, $2, $3, $4, $5, 3)
                 RETURNING id, type, payload`,
                [
                    userId,
                    "cpu_intensive",
                    JSON.stringify({ iterations: CPU_ITERATIONS, benchmarkIndex: i }),
                    JOB_STATUS.QUEUED,
                    idempotencyKey
                ]
            );
            const job = insertRes.rows[0];
            jobIds.push(job.id);

            await client.query(
                `INSERT INTO outbox_events (event_type, aggregate_id, payload, published, published_at)
                 VALUES ($1, $2, $3, true, NOW())`,
                ["JOB_CREATED", job.id, JSON.stringify({ jobId: job.id, type: job.type, payload: job.payload })]
            );
        }
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }

    // Publish to Redis Stream
    for (const id of jobIds) {
        await publishJobEvent({
            event_type: "JOB_CREATED",
            aggregate_id: id,
            payload: { jobId: id, type: "cpu_intensive", payload: { iterations: CPU_ITERATIONS } }
        });
    }

    return jobIds;
}

async function waitForCompletion(jobIds, timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const res = await pool.query(
            `SELECT COUNT(*) as completed_count
             FROM jobs
             WHERE id = ANY($1::uuid[]) AND status = $2`,
            [jobIds, JOB_STATUS.SUCCESS]
        );
        const count = Number(res.rows[0].completed_count);
        if (count >= jobIds.length) {
            return count;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for jobs to complete (${jobIds.length} expected)`);
}

function spawnWorkers(count, runTag) {
    const processes = [];
    for (let i = 1; i <= count; i++) {
        const workerId = `scale-${runTag}-w${i}`;
        const child = spawn(
            process.execPath,
            ["src/workers/job.worker.js"],
            {
                cwd: process.cwd(),
                env: { ...process.env, WORKER_ID: workerId },
                stdio: ["ignore", "pipe", "pipe"]
            }
        );
        processes.push(child);
    }
    return processes;
}

async function cleanupBenchmarkJobs(jobIds, userId) {
    if (jobIds.length > 0) {
        await pool.query(`DELETE FROM job_attempts WHERE job_id = ANY($1::uuid[])`, [jobIds]);
        await pool.query(`DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])`, [jobIds]);
        await pool.query(`DELETE FROM jobs WHERE id = ANY($1::uuid[])`, [jobIds]);
    }
    if (userId) {
        await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
}

async function runScalingBenchmark() {
    console.log("========================================================================");
    console.log("             WORKER SCALING BENCHMARK (1 vs 2 vs 4 WORKERS)             ");
    console.log("========================================================================");
    console.log(`Workload per run: ${WORKLOAD_SIZE} cpu_intensive jobs (${CPU_ITERATIONS.toLocaleString()} iterations each)\n`);

    await ensureConsumerGroup();
    const userId = await getOrCreateBenchmarkUser();
    const allBenchmarkJobs = [];
    const results = [];

    for (const workerCount of WORKER_COUNTS) {
        const runTag = `p${workerCount}`;
        console.log(`>>> Preparing workload for ${workerCount} worker(s)...`);
        const jobIds = await prepareWorkload(userId, runTag);
        allBenchmarkJobs.push(...jobIds);

        console.log(`>>> Spawning ${workerCount} worker process(es)...`);
        const workers = spawnWorkers(workerCount, runTag);

        // Allow workers ~500ms to initialize and establish Redis/PG connections
        await new Promise((r) => setTimeout(r, 500));

        console.log(`>>> Measuring execution...`);
        const startTime = performance.now();
        await waitForCompletion(jobIds);
        const durationMs = performance.now() - startTime;
        const durationSec = durationMs / 1000;
        const throughput = WORKLOAD_SIZE / durationSec;

        console.log(`✔ Completed in ${durationMs.toFixed(1)} ms (${throughput.toFixed(2)} jobs/sec)\n`);

        results.push({
            workerCount,
            durationMs,
            durationSec,
            throughput
        });

        // Terminate workers
        for (const child of workers) {
            child.kill();
        }
        await new Promise((r) => setTimeout(r, 1000));
    }

    // Clean up DB records
    await cleanupBenchmarkJobs(allBenchmarkJobs, userId);

    // Compute speedup and scaling efficiency
    const baseThroughput = results[0].throughput;
    const baseDuration = results[0].durationMs;

    console.log("========================================================================");
    console.log("                          SCALING RESULTS SUMMARY                       ");
    console.log("========================================================================");
    console.log("| Workers | Duration (s) | Throughput (jobs/s) | Speedup | Throughput Gain | Efficiency |");
    console.log("|---------|--------------|---------------------|---------|-----------------|------------|");

    for (const r of results) {
        const speedup = r.throughput / baseThroughput;
        const gainPercent = ((r.throughput - baseThroughput) / baseThroughput) * 100;
        const efficiency = (speedup / r.workerCount) * 100;

        console.log(
            `|    ${r.workerCount}    |    ${r.durationSec.toFixed(2)}s     |       ${r.throughput.toFixed(2)}        |  ${speedup.toFixed(2)}x  |     +${gainPercent.toFixed(1)}%     |   ${efficiency.toFixed(1)}%   |`
        );
    }
    console.log("========================================================================\n");

    const fourWorkerGain = ((results[2].throughput - baseThroughput) / baseThroughput) * 100;
    console.log("🎯 Resume Bullet Metric Target:");
    console.log(`"Scaled multi-process worker pool across 1, 2, and 4 concurrent processes, achieving a ${fourWorkerGain.toFixed(0)}% throughput increase (${baseThroughput.toFixed(1)} → ${results[2].throughput.toFixed(1)} jobs/sec) under sustained compute workload."\n`);

    await pool.end();
}

runScalingBenchmark().catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
});
