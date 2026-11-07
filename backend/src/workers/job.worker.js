import { acknowledgeJobEvent, consumeJobEvents } from "../queue/redis.consumer.js";
import { pool } from "../config/database.js";
import { env } from "../config/env.js";
import { handlers } from "../handlers/index.js";
import { claimJob } from "../services/job.execution.service.js";
import { completeJob } from "../services/job.completion.service.js";
import { retryJob } from "../services/job.retry.service.js";
import { heartbeatJob } from "../services/job.heartbeat.service.js";

async function getJob(jobId) {
    const result = await pool.query(
        `
        SELECT *
        FROM jobs
        WHERE id = $1
        `,
        [jobId]
    );

    return result.rows[0] || null;
}

async function processEvent(event) {
    const jobId = event.jobId;

    if (!jobId) {
        console.error("Received event without jobId");
        return;
    }

    const job = await getJob(jobId);

    if (!job) {
        console.error(
            `Job ${jobId} does not exist in PostgreSQL`
        );

        return;
    }

    try {
        const handler = handlers[job.type.toUpperCase()];
        if (!handler) {
            throw new Error(`No handler registered for job type: ${job.type}`);
        }

        // Claim the job before executing to ensure no one else is running it
        const claimedJob = await claimJob(job.id, env.WORKER_ID);
        if (!claimedJob) {
            const currentJob = await getJob(job.id);
            if (!currentJob) {
                console.log(`[${env.WORKER_ID}] Job ${job.id} disappeared before it could be claimed`);
            } else {
                console.log(
                    `[${env.WORKER_ID}] Job ${job.id} was not claimable ` +
                    `(status=${currentJob.status}, scheduled_at=${currentJob.scheduled_at}, ` +
                    `attempts=${currentJob.attempt_count}/${currentJob.max_attempts})`
                );
            }
            return;
        }

        console.log(
            `[${env.WORKER_ID}] Processing job ${job.id} (${job.type})`
        );

        // Start heartbeat timer
        const heartbeatInterval = setInterval(() => {
            heartbeatJob(job.id, env.WORKER_ID).catch(console.error);
        }, 30000); // 30 seconds

        let result;
        try {
            result = await handler(claimedJob);
            await completeJob(job.id, result);
            console.log(`[${env.WORKER_ID}] Job ${job.id} completed successfully`);
        } catch (executionError) {
            await retryJob(job.id, executionError.message);
            console.error(`[${env.WORKER_ID}] Job ${job.id} failed:`, executionError);
        } finally {
            clearInterval(heartbeatInterval);
        }

    } catch (error) {
        console.error(`[${env.WORKER_ID}] Error setting up job ${job.id}:`, error);
    }
}

async function processDueJobs() {
    const result = await pool.query(
        `
        SELECT id
        FROM jobs
        WHERE status = 'QUEUED'
          AND scheduled_at <= NOW()
          AND attempt_count < max_attempts
          AND locked_by IS NULL
        ORDER BY priority DESC, created_at
        LIMIT 10
        `
    );

    for (const job of result.rows) {
        await processEvent({ jobId: job.id });
    }
}

async function startWorker() {
    console.log(
        `[${env.WORKER_ID}] Worker started`
    );

    await import("../queue/redis.consumer.js")
        .then(({ ensureConsumerGroup }) =>
            ensureConsumerGroup()
        );

    while (true) {
        try {
            const events = await consumeJobEvents();

            for (const stream of events) {
                const messages = stream.messages || [];

                for (const message of messages) {
                    const fields = message.message || {};

                    const event = {
                        streamId: message.id,
                        eventId: fields.eventId,
                        eventType: fields.eventType,
                        jobId: fields.jobId,
                        payload: fields.payload
                    };

                    if (["JOB_CREATED", "JOB_RETRIED", "JOB_REQUEUED"].includes(event.eventType)) {
                        await processEvent(event);
                    }
                    const testPauseMs = process.env.NODE_ENV === "test"
                        ? Number(process.env.JOBMESH_TEST_PAUSE_BEFORE_ACK_MS || 0)
                        : 0;
                    const testPauseJobId = process.env.JOBMESH_TEST_PAUSE_BEFORE_ACK_JOB_ID;
                    if (
                        Number.isFinite(testPauseMs)
                        && testPauseMs > 0
                        && (!testPauseJobId || testPauseJobId === event.jobId)
                    ) {
                        await new Promise((resolve) => setTimeout(resolve, testPauseMs));
                    }
                    await acknowledgeJobEvent(event.streamId);
                }
            }

            await processDueJobs();

            if (events.length === 0) {
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        } catch (error) {
            console.error(
                `[${env.WORKER_ID}] Worker error:`,
                error
            );

            await new Promise((resolve) => {
                setTimeout(resolve, 1000);
            });
        }
    }
}

startWorker();