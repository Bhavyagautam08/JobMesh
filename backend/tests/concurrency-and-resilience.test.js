import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test, after, before } from "node:test";
import { pool } from "../src/config/database.js";
import { acknowledgeJobEvent, ensureConsumerGroup } from "../src/queue/redis.consumer.js";
import { publishJobEvent } from "../src/queue/redis.producer.js";
import { redis } from "../src/config/redis.js";
import { createJob } from "../src/services/job.service.js";
import { claimJob } from "../src/services/job.execution.service.js";
import { completeJob } from "../src/services/job.completion.service.js";
import { failJob } from "../src/services/job.failure.service.js";
import { retryJob } from "../src/services/job.retry.service.js";
import { reconcileStuckJobs } from "../src/services/job.reconciliation.service.js";
import { JOB_STATUS } from "../src/utils/job-status.js";

let testUserId;
const createdJobIds = [];
let ackRaceWorker;
let ackRaceStreamId;

before(async () => {
    const userRes = await pool.query(
        `INSERT INTO users (email, display_name, password_hash)
         VALUES ($1, 'Concurrency Test Suite', 'test-pass')
         RETURNING id`,
        [`concurrency-suite-${randomUUID()}@example.test`]
    );
    testUserId = userRes.rows[0].id;
});

async function cleanupJob(jobId) {
    if (!jobId) return;
    await pool.query(`DELETE FROM job_attempts WHERE job_id = $1`, [jobId]);
    await pool.query(`DELETE FROM outbox_events WHERE aggregate_id = $1`, [jobId]);
    await pool.query(`DELETE FROM jobs WHERE id = $1`, [jobId]);
}

after(async () => {
    if (ackRaceWorker && ackRaceWorker.exitCode === null && ackRaceWorker.signalCode === null) {
        ackRaceWorker.kill("SIGTERM");
        await once(ackRaceWorker, "exit");
    }
    if (ackRaceStreamId) {
        await acknowledgeJobEvent(ackRaceStreamId);
    }
    for (const jobId of createdJobIds) {
        await cleanupJob(jobId);
    }
    if (testUserId) {
        await pool.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
    }
    await pool.end();
});

// =========================================================================
// TEST 1: 50-way Concurrent Idempotency
// =========================================================================
test("Test 1: 50 concurrent submissions with identical Idempotency-Key create exactly 1 job and 1 outbox event", async () => {
    const concurrency = 50;
    const batchSize = 15; // stay within Neon free-tier pool limit (~20 connections)
    const idempotencyKey = `concurrency-50-${randomUUID()}`;

    console.log(`\n--- [Test 1] Launching ${concurrency} submissions in waves of ${batchSize} with same idempotency key ---`);
    const startTime = performance.now();

    // Submit in concurrent waves — still proves atomicity under contention
    const allResults = [];
    for (let start = 0; start < concurrency; start += batchSize) {
        const wave = Array.from(
            { length: Math.min(batchSize, concurrency - start) },
            (_, i) => createJob({
                userId: testUserId,
                type: "process_json",
                payload: { submissionIndex: start + i, test: "concurrent_idempotency" },
                idempotencyKey
            })
        );
        const waveResults = await Promise.all(wave);
        allResults.push(...waveResults);
    }

    const elapsedMs = (performance.now() - startTime).toFixed(2);
    const results = allResults;

    const createdResults = results.filter((r) => r.created === true);
    const deduplicatedResults = results.filter((r) => r.created === false);

    assert.equal(createdResults.length, 1, "Exactly one request must report created = true");
    assert.equal(deduplicatedResults.length, concurrency - 1, `${concurrency - 1} requests must report created = false (deduplicated)`);

    const primaryJobId = createdResults[0].data.id;
    createdJobIds.push(primaryJobId);

    for (const res of results) {
        assert.equal(res.data.id, primaryJobId, `All ${concurrency} responses must reference the identical job ID`);
        assert.equal(res.data.idempotency_key, idempotencyKey, "Idempotency key must match");
    }

    // Verify DB state: exactly 1 record in jobs table
    const jobsCountRes = await pool.query(
        `SELECT COUNT(*) as count FROM jobs WHERE user_id = $1 AND idempotency_key = $2`,
        [testUserId, idempotencyKey]
    );
    assert.equal(Number(jobsCountRes.rows[0].count), 1, "Database must persist exactly 1 job record");

    // Verify outbox events: exactly 1 JOB_CREATED event
    const outboxEventsRes = await pool.query(
        `SELECT id, event_type, aggregate_id FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'JOB_CREATED'`,
        [primaryJobId]
    );
    assert.equal(outboxEventsRes.rows.length, 1, "Exactly 1 JOB_CREATED outbox event must be emitted");

    console.log(`✔ [Test 1 PASSED] ${concurrency}-way concurrent idempotency validated in ${elapsedMs}ms:`);
    console.log(`  - 1 created, ${concurrency - 1} deduplicated, single job ID: ${primaryJobId}`);
    console.log(`  - DB record count: 1, Outbox event count: 1`);
});

// =========================================================================
// TEST 2: 20-way Atomic Worker Claiming
// =========================================================================
test("Test 2: 20 concurrent workers claiming the same queued job results in exactly 1 successful claim", async () => {
    const workerCount = 20;
    const idempotencyKey = `atomic-claim-${randomUUID()}`;

    const created = await createJob({
        userId: testUserId,
        type: "cpu_intensive",
        payload: { iterations: 1000 },
        idempotencyKey
    });
    const jobId = created.data.id;
    createdJobIds.push(jobId);

    console.log(`\n--- [Test 2] Launching 20 workers competing simultaneously to claim job ${jobId} ---`);
    const startTime = performance.now();

    const claimPromises = Array.from({ length: workerCount }, (_, i) =>
        claimJob(jobId, `worker-${String(i + 1).padStart(2, "0")}`)
    );

    const claimResults = await Promise.all(claimPromises);
    const elapsedMs = (performance.now() - startTime).toFixed(2);

    const successfulClaims = claimResults.filter(Boolean);
    const failedClaims = claimResults.filter((r) => r === null);

    assert.equal(successfulClaims.length, 1, "Exactly one worker must succeed in claiming the job");
    assert.equal(failedClaims.length, workerCount - 1, "19 competing workers must be atomically rejected");

    const winnerWorker = successfulClaims[0].locked_by;
    assert.ok(winnerWorker, "Winning claim must record the claiming worker ID");

    // Verify in database: status = RUNNING, attempt_count = 1
    const dbJobRes = await pool.query(`SELECT status, attempt_count, locked_by FROM jobs WHERE id = $1`, [jobId]);
    const dbJob = dbJobRes.rows[0];
    assert.equal(dbJob.status, JOB_STATUS.RUNNING, "Job status must be updated to RUNNING");
    assert.equal(dbJob.attempt_count, 1, "Job attempt count must be exactly 1");
    assert.equal(dbJob.locked_by, winnerWorker, "Locked worker must match winner");

    // Verify job_attempts table has exactly 1 attempt
    const attemptsRes = await pool.query(`SELECT * FROM job_attempts WHERE job_id = $1`, [jobId]);
    assert.equal(attemptsRes.rows.length, 1, "Exactly 1 attempt record must exist in job_attempts");
    assert.equal(attemptsRes.rows[0].status, JOB_STATUS.RUNNING, "Attempt record status must be RUNNING");

    console.log(`✔ [Test 2 PASSED] 20-way atomic claim validated in ${elapsedMs}ms:`);
    console.log(`  - Winner: ${winnerWorker}, Rejections: 19`);
    console.log(`  - Database attempt count: 1, attempts recorded: 1`);
});

// =========================================================================
// TEST 4: Retry and Maximum-Attempt Enforcement (3 attempts max)
// =========================================================================
test("Test 4: Job failure enforces maximum attempts (3), records attempt history, and marks job FAILED", async () => {
    const idempotencyKey = `retry-enforcement-${randomUUID()}`;
    const maxAttempts = 3;

    // Create job with max_attempts = 3
    const created = await createJob({
        userId: testUserId,
        type: "calculate_primes",
        payload: { limit: 500 },
        idempotencyKey
    });
    const jobId = created.data.id;
    createdJobIds.push(jobId);

    console.log(`\n--- [Test 4] Verifying retry & max attempt enforcement (limit = ${maxAttempts}) ---`);

    // Iteration 1: Claim -> Fail
    const claim1 = await claimJob(jobId, "worker-retry-1");
    assert.ok(claim1, "Claim 1 should succeed");
    assert.equal(claim1.attempt_count, 1);
    const fail1 = await failJob({ jobId, workerId: "worker-retry-1", error: "Simulated failure 1" });
    assert.equal(fail1.status, JOB_STATUS.QUEUED, "After failure 1, status should return to QUEUED for retry");
    assert.equal(fail1.retry, true, "Should allow retry");

    // Manually ensure scheduled_at is in past for immediate next claim
    await pool.query(`UPDATE jobs SET scheduled_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [jobId]);

    // Iteration 2: Claim -> Fail
    const claim2 = await claimJob(jobId, "worker-retry-2");
    assert.ok(claim2, "Claim 2 should succeed");
    assert.equal(claim2.attempt_count, 2);
    const fail2 = await failJob({ jobId, workerId: "worker-retry-2", error: "Simulated failure 2" });
    assert.equal(fail2.status, JOB_STATUS.QUEUED, "After failure 2, status should return to QUEUED");
    assert.equal(fail2.retry, true, "Should allow retry");

    await pool.query(`UPDATE jobs SET scheduled_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [jobId]);

    // Iteration 3: Claim -> Fail (Terminal attempt)
    const claim3 = await claimJob(jobId, "worker-retry-3");
    assert.ok(claim3, "Claim 3 should succeed");
    assert.equal(claim3.attempt_count, 3);
    const fail3 = await failJob({ jobId, workerId: "worker-retry-3", error: "Simulated failure 3 (terminal)" });
    assert.equal(fail3.status, JOB_STATUS.FAILED, "After failure 3 (max reached), status must be FAILED");
    assert.equal(fail3.retry, false, "Should NOT allow further retry");

    // Verify 4th claim is impossible
    const claim4 = await claimJob(jobId, "worker-retry-4");
    assert.equal(claim4, null, "Claiming a terminally failed job must return null");

    // Verify database record
    const finalJobRes = await pool.query(`SELECT status, attempt_count, max_attempts, error FROM jobs WHERE id = $1`, [jobId]);
    const finalJob = finalJobRes.rows[0];
    assert.equal(finalJob.status, JOB_STATUS.FAILED, "Final job status must be FAILED");
    assert.equal(finalJob.attempt_count, 3, "Final attempt count must be 3");

    // Verify attempt history in job_attempts
    const attemptsRes = await pool.query(
        `SELECT attempt_number, status, error FROM job_attempts WHERE job_id = $1 ORDER BY attempt_number ASC`,
        [jobId]
    );
    assert.equal(attemptsRes.rows.length, 3, "Exactly 3 attempt records must exist in attempt history");
    assert.deepEqual(
        attemptsRes.rows.map((r) => r.attempt_number),
        [1, 2, 3],
        "Attempt numbers must be sequential [1, 2, 3]"
    );
    for (const att of attemptsRes.rows) {
        assert.equal(att.status, JOB_STATUS.FAILED, "Each attempt must record FAILED status");
        assert.ok(att.error.includes("Simulated failure"), "Attempt must record error reason");
    }

    // Now separately verify that a job CAN succeed on a subsequent retry
    const retrySucceedKey = `retry-success-${randomUUID()}`;
    const retryJobObj = await createJob({
        userId: testUserId,
        type: "process_json",
        payload: { successTest: true },
        idempotencyKey: retrySucceedKey
    });
    const successJobId = retryJobObj.data.id;
    createdJobIds.push(successJobId);

    // Fail attempt 1
    await claimJob(successJobId, "worker-try-1");
    await failJob({ jobId: successJobId, workerId: "worker-try-1", error: "Transient network timeout" });
    await pool.query(`UPDATE jobs SET scheduled_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [successJobId]);

    // Claim attempt 2 and succeed!
    const claimRetry2 = await claimJob(successJobId, "worker-try-2");
    assert.ok(claimRetry2, "Second claim must succeed");
    assert.equal(claimRetry2.attempt_count, 2);
    await completeJob(successJobId, { processed: true, items: 42 });

    const recoveredJobRes = await pool.query(`SELECT status, attempt_count, result FROM jobs WHERE id = $1`, [successJobId]);
    const recoveredJob = recoveredJobRes.rows[0];
    assert.equal(recoveredJob.status, JOB_STATUS.SUCCESS, "Job must complete successfully on retry 2");
    assert.equal(recoveredJob.attempt_count, 2, "Attempt count must be 2");
    assert.deepEqual(recoveredJob.result, { processed: true, items: 42 });

    console.log(`✔ [Test 4 PASSED] Max-attempts (3) and retry enforcement validated:`);
    console.log(`  - Terminal failure verified at attempt 3/3, exactly 3 attempt records in history`);
    console.log(`  - 4th claim blocked`);
    console.log(`  - Separate job succeeded on retry attempt 2`);
});

// =========================================================================
// TEST 5: Worker Crash Recovery (Controlled Failure Injection)
// =========================================================================
test("Test 5: Worker crash injection is recovered by reconciliation and reassigned to replacement worker", async () => {
    const idempotencyKey = `crash-recovery-${randomUUID()}`;

    const created = await createJob({
        userId: testUserId,
        type: "long_running",
        payload: { durationMs: 10000 },
        idempotencyKey
    });
    const jobId = created.data.id;
    createdJobIds.push(jobId);

    console.log(`\n--- [Test 5] Injecting worker crash for job ${jobId} ---`);

    // Worker A claims the job
    const claimedByWorkerA = await claimJob(jobId, "worker-crashed-pid-9999");
    assert.ok(claimedByWorkerA, "Worker A must claim the job");
    assert.equal(claimedByWorkerA.locked_by, "worker-crashed-pid-9999");
    assert.equal(claimedByWorkerA.status, JOB_STATUS.RUNNING);

    // Simulate worker crash: worker process dies abruptly without releasing lock or completing
    // Simulate elapsed timeout by backdating updated_at by 10 minutes
    await pool.query(`UPDATE jobs SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [jobId]);

    // Trigger reconciliation
    const reconStart = performance.now();
    const reconciledCount = await reconcileStuckJobs({ timeoutMinutes: 5 });
    const reconDurationMs = (performance.now() - reconStart).toFixed(2);

    assert.ok(reconciledCount >= 1, "Reconciliation must identify and recover the orphaned job");

    // Verify job was restored to QUEUED state and lock cleared
    const recoveredJobRes = await pool.query(`SELECT status, locked_by, locked_at, attempt_count FROM jobs WHERE id = $1`, [jobId]);
    const recoveredJob = recoveredJobRes.rows[0];
    assert.equal(recoveredJob.status, JOB_STATUS.QUEUED, "Reconciled job must be restored to QUEUED status");
    assert.equal(recoveredJob.locked_by, null, "Worker lock must be cleared");
    assert.equal(recoveredJob.attempt_count, 1, "Attempt count from first claim remains recorded");

    // Verify outbox has JOB_REQUEUED event
    const requeueEventRes = await pool.query(
        `SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'JOB_REQUEUED'`,
        [jobId]
    );
    assert.ok(requeueEventRes.rows.length >= 1, "JOB_REQUEUED outbox event must be emitted");

    // Replacement delivery: Worker B picks up the recovered job
    const claimedByWorkerB = await claimJob(jobId, "worker-replacement-pid-10000");
    assert.ok(claimedByWorkerB, "Replacement worker B must successfully claim the recovered job");
    assert.equal(claimedByWorkerB.locked_by, "worker-replacement-pid-10000");
    assert.equal(claimedByWorkerB.attempt_count, 2, "Attempt count must increment to 2");

    // Worker B completes the job
    await completeJob(jobId, { status: "recovered_and_completed" });
    const finalJobRes = await pool.query(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
    assert.equal(finalJobRes.rows[0].status, JOB_STATUS.SUCCESS, "Recovered job must reach SUCCESS status");

    // Test attempt limit enforcement on crash recovery:
    // If a job crashed on its final attempt (attempt_count = 3, max_attempts = 3)
    const exhaustedCrashKey = `crash-max-attempts-${randomUUID()}`;
    const exhaustedJobObj = await createJob({
        userId: testUserId,
        type: "long_running",
        payload: { durationMs: 5000 },
        idempotencyKey: exhaustedCrashKey
    });
    const exhaustedJobId = exhaustedJobObj.data.id;
    createdJobIds.push(exhaustedJobId);

    // Simulate that it already had 3 attempts and crashed while RUNNING
    await pool.query(
        `UPDATE jobs SET status = 'RUNNING', attempt_count = 3, max_attempts = 3, locked_by = 'worker-exhausted', updated_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`,
        [exhaustedJobId]
    );

    await reconcileStuckJobs({ timeoutMinutes: 5 });

    const postReconRes = await pool.query(`SELECT status, error FROM jobs WHERE id = $1`, [exhaustedJobId]);
    assert.equal(postReconRes.rows[0].status, JOB_STATUS.FAILED, "Stuck job exceeding max attempts must be marked FAILED");
    assert.ok(postReconRes.rows[0].error.includes("max attempts exceeded"), "Failure error should note max attempts exceeded");

    console.log(`✔ [Test 5 PASSED] Worker crash recovery validated:`);
    console.log(`  - Orphaned job reconciled in ${reconDurationMs}ms`);
    console.log(`  - Lock cleared and JOB_REQUEUED event emitted`);
    console.log(`  - Replacement worker claimed and completed job (attempt 2)`);
    console.log(`  - Crash at max attempts correctly marked FAILED (attempt limit respected)`);
});

test("Worker killed after completing a job but before stream acknowledgment leaves one successful attempt", async () => {
    await ensureConsumerGroup();
    const workerId = `worker-ack-race-${randomUUID()}`;
    const created = await createJob({
        userId: testUserId,
        type: "process_json",
        payload: { ackRace: true },
        idempotencyKey: `ack-race-${randomUUID()}`
    });
    const jobId = created.data.id;
    createdJobIds.push(jobId);

    ackRaceWorker = spawn(process.execPath, ["src/workers/job.worker.js"], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            NODE_ENV: "test",
            WORKER_ID: workerId,
            JOBMESH_TEST_PAUSE_BEFORE_ACK_MS: "30000",
            JOBMESH_TEST_PAUSE_BEFORE_ACK_JOB_ID: jobId
        },
        stdio: ["ignore", "ignore", "pipe"]
    });
    ackRaceWorker.stderr.on("data", (chunk) => process.stderr.write(chunk));

    ackRaceStreamId = await publishJobEvent({
        id: randomUUID(),
        event_type: "JOB_CREATED",
        aggregate_id: jobId,
        payload: { jobId, type: created.data.type, payload: created.data.payload }
    });

    const deadline = Date.now() + 20000;
    let pendingEntry;
    while (Date.now() < deadline) {
        const job = await pool.query(
            "SELECT status, attempt_count FROM jobs WHERE id = $1",
            [jobId]
        );
        if (job.rows[0]?.status === JOB_STATUS.SUCCESS) {
            const pending = await redis.xpending("job-events", "job-workers", "-", "+", 1000);
            pendingEntry = pending.find(([streamId]) => streamId === ackRaceStreamId);
            if (pendingEntry) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.ok(pendingEntry, "The completed job's stream message must still be pending before the worker is killed");
    assert.equal(ackRaceWorker.exitCode, null, "The worker must still be alive in the post-completion, pre-ack pause");
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Worker did not exit after SIGTERM")), 5000);
        ackRaceWorker.once("exit", () => {
            clearTimeout(timer);
            resolve();
        });
        ackRaceWorker.kill("SIGTERM");
    });

    const finalJob = await pool.query(
        "SELECT status, attempt_count FROM jobs WHERE id = $1",
        [jobId]
    );
    const attempts = await pool.query(
        "SELECT attempt_number, status FROM job_attempts WHERE job_id = $1 ORDER BY attempt_number",
        [jobId]
    );
    const pendingAfterKill = await redis.xpending("job-events", "job-workers", "-", "+", 1000);

    assert.equal(finalJob.rows[0].status, JOB_STATUS.SUCCESS);
    assert.equal(finalJob.rows[0].attempt_count, 1);
    assert.equal(attempts.rowCount, 1);
    assert.equal(attempts.rows[0].attempt_number, 1);
    assert.equal(attempts.rows[0].status, JOB_STATUS.SUCCESS);
    assert.ok(
        pendingAfterKill.some(([streamId]) => streamId === ackRaceStreamId),
        "The stream entry must remain unacknowledged after the worker is killed"
    );
});
