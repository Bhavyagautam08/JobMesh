import { createServer } from "node:http";
import Redis from "ioredis";

const port = Number(process.env.BENCHMARK_REDIS_REST_PORT || 8079);
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = new Redis(process.env.BENCHMARK_REDIS_URL || "redis://127.0.0.1:56379", {
  maxRetriesPerRequest: 1
});

if (!token) {
  throw new Error("UPSTASH_REDIS_REST_TOKEN is required for the local benchmark adapter");
}

function respond(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function encodeResult(value) {
  if (typeof value === "string" && value !== "OK") return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(encodeResult);
  return value;
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST") {
    respond(response, 404, { error: "Not found" });
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    respond(response, 401, { error: "Unauthorized" });
    return;
  }

  let rawBody = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    rawBody += chunk;
    if (rawBody.length > 1024 * 1024) {
      request.destroy(new Error("Request body exceeds 1 MiB"));
    }
  });
  request.on("error", (error) => {
    console.error("Local Redis REST request failed:", error.message);
  });
  request.on("end", async () => {
    try {
      const body = JSON.parse(rawBody);
      const isPipeline = Array.isArray(body[0]);
      const commands = isPipeline ? body : [body];
      if (!commands.length || commands.some((command) =>
        !Array.isArray(command) || command.length === 0
          || command.some((part) => typeof part !== "string" && typeof part !== "number")
      )) {
        respond(response, 400, { error: "Expected a Redis command or command pipeline" });
        return;
      }

      const results = await Promise.all(commands.map((command) => redis.call(...command.map(String))));
      respond(response, 200, isPipeline
        ? results.map((result) => ({ result: encodeResult(result) }))
        : { result: encodeResult(results[0]) });
    } catch (error) {
      respond(response, 400, { error: error.message });
    }
  });
});

await redis.ping();
server.listen(port, "127.0.0.1", () => {
  console.log(`Local Redis REST adapter listening on http://127.0.0.1:${port}`);
});

async function shutdown(signal) {
  console.log(`${signal} received; stopping local Redis REST adapter`);
  server.close(async () => {
    await redis.quit();
    process.exit(0);
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
