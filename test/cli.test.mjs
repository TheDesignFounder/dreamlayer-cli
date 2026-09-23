/**
 * End-to-end tests against the built binary, driven by a fake Agent API.
 *
 * The point of a CLI is that it composes with other tools, so these assert the things
 * that make that true and that a unit test would miss: what lands on stdout versus
 * stderr, and what the exit code is. A CLI that prints a friendly sentence on stdout
 * cannot be used in `$(...)`, and one that exits 0 on failure cannot be used in `&&`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, symlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const ENTRY = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

/** A stand-in Agent API. `behaviour` decides what /v1/execute streams back. */
function fakeApi(behaviour) {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push({ method: request.method, url: request.url, headers: request.headers });

    if (request.url === "/v1/capabilities") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(behaviour.capabilities ?? { api_version: "1", key_mode: "live" }));
      return;
    }
    if (request.url === "/v1/balance") {
      response.writeHead(behaviour.balanceStatus ?? 200, {
        "content-type": "application/json",
        "cache-control": "private, no-store",
      });
      response.end(
        JSON.stringify(
          behaviour.balanceBody ?? {
            promotional: 3,
            purchased: 5,
            available: 8,
            credit_usd: "0.17",
          },
        ),
      );
      return;
    }
    if (/^\/v1\/executions\/[^/]+$/.test(request.url) && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(behaviour.execution ?? {}));
      return;
    }
    if (request.url === "/v1/input-assets") {
      request.resume();
      request.on("end", () => {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            input_asset_id: "11111111-1111-4111-8111-111111111111",
            width: 8,
            height: 8,
            expires_at: "2030-01-01T00:00:00Z",
          }),
        );
      });
      return;
    }
    if (request.url === "/v1/input-assets/uploads" && request.method === "POST") {
      request.resume();
      request.on("end", () => {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            upload_id: "11111111-1111-4111-8111-111111111111",
            upload_url:
              behaviour.uploadUrl ??
              "/v1/input-assets/uploads/11111111-1111-4111-8111-111111111111/raw",
            http_method: "PUT",
            mode: "proxied",
            content_type: "application/octet-stream",
            maximum_bytes: 209715200,
            expires_at: "2030-01-01T00:00:00Z",
          }),
        );
      });
      return;
    }
    if (/^\/v1\/input-assets\/uploads\/[^/]+\/raw$/.test(request.url) && request.method === "PUT") {
      if (behaviour.stallUpload) return;
      request.resume();
      request.on("end", () => {
        if (behaviour.delayUploadMs) {
          setTimeout(() => response.writeHead(204).end(), behaviour.delayUploadMs);
        } else {
          response.writeHead(204).end();
        }
      });
      return;
    }
    if (/^\/v1\/input-assets\/uploads\/[^/]+\/finalize$/.test(request.url) && request.method === "POST") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          input_asset_id: "11111111-1111-4111-8111-111111111111",
          width: 8,
          height: 8,
          expires_at: "2030-01-01T00:00:00Z",
        }),
      );
      return;
    }
    if (request.url === "/asset.png") {
      if (behaviour.assetStatus) {
        response.writeHead(behaviour.assetStatus, { "content-type": "application/json" });
        response.end(JSON.stringify({ detail: "private upstream details" }));
        return;
      }
      response.writeHead(200, { "content-type": "image/png" });
      response.end(PNG);
      return;
    }
    if (request.url === "/v1/execute") {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        calls[calls.length - 1].body = body;
        behaviour.onExecute?.();

        // The real request model is CLOSED: an unknown key is a 422, not a field the
        // server quietly ignores. Mirror that, or a client that invents a field passes
        // every test here and 422s on every call in production.
        //
        // `operation` is on this list because it ships in the gateway build this package
        // targets. It is NOT on production yet, which is why publishing waits on that
        // deploy. Removing it here would hide a real regression later.
        const allowed = [
          "prompt",
          "respond",
          "conversation_id",
          "input_asset_id",
          "aspect_ratio",
          "operation",
          "options",
          "max_credits",
        ];
        const extra = Object.keys(body).filter((key) => !allowed.includes(key));
        if (extra.length > 0) {
          response.writeHead(422, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                code: "VALIDATION_FAILED",
                message: `Extra inputs are not permitted: ${extra.join(", ")}`,
              },
            }),
          );
          return;
        }

        if (behaviour.status && behaviour.status !== 200) {
          response.writeHead(behaviour.status, { "content-type": "application/json" });
          response.end(JSON.stringify(behaviour.body ?? { detail: behaviour.detail ?? "nope" }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const origin = `http://127.0.0.1:${server.address().port}`;
        for (const [index, block] of behaviour.events.entries()) {
          // download_url is absolute in the real API, so the fake must be too.
          const data = JSON.stringify(block.data).replace('"ASSET"', `"${origin}/asset.png"`);
          response.write(`id: ${index + 1}\nevent: ${block.event}\ndata: ${data}\n\n`);
        }
        response.end();
      });
      return;
    }
    response.writeHead(404).end();
  });
  return { server, calls };
}

async function listen(handler) {
  const { server, calls } = handler;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, calls, close: () => server.close() };
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      env: { ...process.env, DREAMLAYER_API_KEY: "dlr_live_test", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

const started = {
  event: "started",
  data: {
    execution_id: "22222222-2222-4222-8222-222222222222",
    conversation_id: "33333333-3333-4333-8333-333333333333",
  },
};

let temp;
after(() => temp);

test("a successful generate writes the file and puts ONLY its path on stdout", async () => {
  const api = await listen(
    fakeApi({
      events: [
        started,
        { event: "progress", data: { text: "Rendering" } },
        {
          event: "asset",
          data: { asset_id: "44444444-4444-4444-8444-444444444444", download_url: "ASSET" },
        },
        { event: "done", data: { status: "completed" } },
      ],
    }),
  );
  temp = await mkdtemp(path.join(tmpdir(), "dl-cli-"));
  const out = path.join(temp, "out.png");

  const events = api.calls;
  const result = await runCli(["generate", "a glass greenhouse", "--out", out, "--quiet"], {
    DREAMLAYER_API_URL: api.url,
  });
  api.close();

  assert.equal(result.code, 0, result.stderr);
  // Exactly the path, so `$(dreamlayer generate ...)` is usable directly.
  assert.equal(result.stdout.trim(), out);
  assert.ok((await readFile(out)).byteLength > 0, "the image was not written");

  const execute = events.find((call) => call.url === "/v1/execute");
  assert.equal(execute.headers["dreamlayer-version"], "1");
  assert.ok(execute.headers["idempotency-key"], "an idempotency key must always be sent");
});

test("a question exits 6 and tells you the command to answer it", async () => {
  const api = await listen(
    fakeApi({
      events: [
        started,
        {
          event: "question",
          data: {
            question_id: "55555555-5555-4555-8555-555555555555",
            conversation_id: "33333333-3333-4333-8333-333333333333",
            text: "Which product should I use?",
          },
        },
        { event: "done", data: { status: "needs_input" } },
      ],
    }),
  );

  const result = await runCli(["generate", "edit it", "--quiet"], { DREAMLAYER_API_URL: api.url });
  api.close();

  // Distinct from a failure: nothing broke, the run needs an answer.
  assert.equal(result.code, 6);
  assert.match(result.stderr, /Which product should I use\?/);
  assert.match(result.stderr, /dreamlayer answer 33333333-3333-4333-8333-333333333333/);
  assert.equal(result.stdout, "", "a question is not a result; stdout stays clean for pipes");
});

test("running out of credits exits 3 and says where to buy them", async () => {
  const api = await listen(fakeApi({ status: 402, detail: "insufficient credits" }));
  const result = await runCli(["generate", "a cat", "--quiet"], { DREAMLAYER_API_URL: api.url });
  api.close();

  assert.equal(result.code, 3, "a distinct code so a script can top up rather than retry");
  assert.match(result.stderr, /insufficient credits/);
  assert.match(result.stderr, /billing/);
});

test("balance reads only the authenticated key's balance in human and JSON modes", async () => {
  for (const args of [["balance"], ["balance", "--json"]]) {
    const api = await listen(fakeApi({ events: [] }));
    const result = await runCli(args, { DREAMLAYER_API_URL: api.url });
    const balanceCall = api.calls.find((call) => call.url === "/v1/balance");
    api.close();

    assert.equal(result.code, 0, result.stderr);
    assert.equal(balanceCall.method, "GET");
    assert.equal(balanceCall.headers.authorization, "Bearer dlr_live_test");
    assert.equal(balanceCall.headers["dreamlayer-version"], "1");
    assert.equal(balanceCall.url, "/v1/balance", "no account selector may be sent");
    if (args.includes("--json")) {
      assert.deepEqual(JSON.parse(result.stdout), {
        promotional: 3,
        purchased: 5,
        available: 8,
        credit_usd: "0.17",
      });
    } else {
      assert.equal(result.stdout, "8 credits available (3 promotional, 5 purchased)\n");
    }
  }
});

test("balance rejects inconsistent or expanded responses without echoing private fields", async () => {
  const api = await listen(
    fakeApi({
      events: [],
      balanceBody: {
        promotional: 3,
        purchased: 5,
        available: 900,
        credit_usd: "0.17",
        private_account_name: "do-not-print-this",
      },
    }),
  );
  const result = await runCli(["balance", "--json"], { DREAMLAYER_API_URL: api.url });
  api.close();

  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "INTERNAL_ERROR");
  assert.doesNotMatch(result.stderr, /do-not-print-this/);
  assert.equal(result.stdout, "");
});

test("402, 409, and 429 errors preserve the stable reason and retry contract", async () => {
  const cases = [
    [402, "insufficient_credits", false, 3],
    [409, "too_many_active_jobs", true, 5],
    [429, "rate_limited", true, 5],
  ];
  for (const [status, reason, retryable, exitCode] of cases) {
    const api = await listen(
      fakeApi({
        status,
        body: {
          error: {
            code: status === 402 ? "BUDGET_EXCEEDED" : "RATE_LIMITED",
            reason,
            message: "private-model said prompt filename.png was rejected",
            retryable,
            request_id: "99999999-9999-4999-8999-999999999999",
          },
        },
      }),
    );
    const result = await runCli(["generate", "secret prompt", "--json", "--quiet"], {
      DREAMLAYER_API_URL: api.url,
    });
    api.close();

    assert.equal(result.code, exitCode, result.stderr);
    assert.equal(result.stdout, "");
    const envelope = JSON.parse(result.stderr);
    assert.equal(envelope.error.reason, reason);
    assert.equal(envelope.error.retryable, retryable);
    assert.equal(envelope.error.request_id, "99999999-9999-4999-8999-999999999999");
    assert.doesNotMatch(result.stderr, /private-model|secret prompt|filename\.png/);
  }
});

test("a rejected request exits 4 and is not described as retryable", async () => {
  const api = await listen(fakeApi({ status: 422, detail: "invalid input asset" }));
  const result = await runCli(["generate", "a cat", "--quiet"], { DREAMLAYER_API_URL: api.url });
  api.close();

  assert.equal(result.code, 4);
  assert.doesNotMatch(result.stderr, /Retry/, "422 will fail identically forever");
});

test("a temporary failure exits 5 and points at the flag that makes retrying safe", async () => {
  const api = await listen(fakeApi({ status: 503, detail: "image service unavailable" }));
  const result = await runCli(["generate", "a cat", "--quiet"], { DREAMLAYER_API_URL: api.url });
  api.close();

  assert.equal(result.code, 5);
  assert.match(result.stderr, /--idempotency-key/, "retrying without one pays twice");
});

test("--json emits parseable output and still writes the file", async () => {
  const api = await listen(
    fakeApi({
      events: [
        started,
        {
          event: "asset",
          data: { asset_id: "44444444-4444-4444-8444-444444444444", download_url: "ASSET" },
        },
        { event: "done", data: { status: "completed" } },
      ],
    }),
  );
  const out = path.join(temp, "json.png");
  const result = await runCli(["generate", "a cat", "--out", out, "--json", "--quiet"], {
    DREAMLAYER_API_URL: api.url,
  });
  api.close();

  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "completed");
  assert.equal(payload.execution_id, "22222222-2222-4222-8222-222222222222");
  assert.equal(payload.file, out);
  // The diagnostic output must not carry the prompt or the key.
  assert.doesNotMatch(result.stdout, /dlr_live_test/);
});

test("cutout and upscale upload their source and send only fields the API accepts", async () => {
  for (const command of ["cutout", "upscale"]) {
    const api = await listen(
      fakeApi({
        events: [
          started,
          {
            event: "asset",
            data: { asset_id: "44444444-4444-4444-8444-444444444444", download_url: "ASSET" },
          },
          { event: "done", data: { status: "completed" } },
        ],
      }),
    );
    const source = path.join(temp, `${command}-source.png`);
    await (await import("node:fs/promises")).writeFile(source, PNG);
    const result = await runCli(
      [command, source, "--out", path.join(temp, `${command}.png`), "--json", "--quiet"],
      { DREAMLAYER_API_URL: api.url },
    );
    const uploaded = api.calls.some((call) => call.url === "/v1/input-assets");
    const execute = api.calls.find((call) => call.url === "/v1/execute");
    api.close();

    assert.equal(result.code, 0, result.stderr);
    assert.ok(uploaded, `${command} must upload its source image`);
    // Naming the operation is the point of these commands: it stops a weak prompt being
    // re-read and coming back as a question instead of an image.
    assert.deepEqual(
      Object.keys(execute.body).sort(),
      ["input_asset_id", "operation", "prompt"],
    );
    assert.equal(
      execute.body.operation,
      command === "cutout" ? "background_remove" : "upscale",
    );
    assert.ok(execute.body.prompt.length > 0, `${command} must send a prompt`);
  }
});

test("a RAW source uses the staged normalization boundary before execute", async () => {
  const api = await listen(
    fakeApi({
      events: [
        started,
        {
          event: "asset",
          data: { asset_id: "44444444-4444-4444-8444-444444444444", download_url: "ASSET" },
        },
        { event: "done", data: { status: "completed" } },
      ],
    }),
  );
  const source = path.join(temp, "camera-source.dng");
  await (await import("node:fs/promises")).writeFile(source, PNG);
  const result = await runCli(
    ["upscale", source, "--out", path.join(temp, "raw-upscale.png"), "--quiet"],
    { DREAMLAYER_API_URL: api.url },
  );
  const urls = api.calls.map((call) => `${call.method} ${call.url}`);
  api.close();

  assert.equal(result.code, 0, result.stderr);
  assert.ok(urls.includes("POST /v1/input-assets/uploads"));
  assert.ok(urls.some((value) => /PUT \/v1\/input-assets\/uploads\/[^/]+\/raw/.test(value)));
  assert.ok(urls.some((value) => /POST \/v1\/input-assets\/uploads\/[^/]+\/finalize/.test(value)));
  assert.ok(!urls.includes("POST /v1/input-assets"));
});

test("a 200 MB upload receives a size-scaled deadline", async () => {
  const { uploadTimeoutMs } = await import("../dist/client.js");
  assert.ok(uploadTimeoutMs(200 * 1024 * 1024) > 130_000);
});

test("a proxied upload URL cannot send the API key off origin", async () => {
  const api = await listen(fakeApi({ uploadUrl: "http://127.0.0.1:9/steal" }));
  const temp = await mkdtemp(path.join(tmpdir(), "dl-upload-origin-"));
  const source = path.join(temp, "camera.dng");
  await writeFile(source, PNG);
  const result = await runCli(["edit", source, "brighten", "--quiet"], {
    DREAMLAYER_API_URL: api.url,
  });
  api.close();
  assert.equal(result.code, 5);
  assert.match(result.stderr, /off-origin upload URL/);
});

test("a genuinely stalled staged upload is retryable", async () => {
  const api = await listen(fakeApi({ stallUpload: true }));
  const temp = await mkdtemp(path.join(tmpdir(), "dl-upload-stall-"));
  const source = path.join(temp, "camera.dng");
  await writeFile(source, PNG);
  const result = await runCli(["edit", source, "brighten", "--quiet"], {
    DREAMLAYER_API_URL: api.url,
    DREAMLAYER_UPLOAD_TIMEOUT_MS: "100",
  });
  api.close();
  assert.equal(result.code, 5);
  assert.match(result.stderr, /--idempotency-key/);
});

test("generate sends only the fields /v1/execute accepts", async () => {
  const api = await listen(
    fakeApi({
      events: [
        started,
        {
          event: "asset",
          data: { asset_id: "44444444-4444-4444-8444-444444444444", download_url: "ASSET" },
        },
        { event: "done", data: { status: "completed" } },
      ],
    }),
  );
  const result = await runCli(
    ["generate", "a glass greenhouse at dusk", "--out", path.join(temp, "gen.png"), "--quiet"],
    { DREAMLAYER_API_URL: api.url },
  );
  const execute = api.calls.find((call) => call.url === "/v1/execute");
  api.close();

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(Object.keys(execute.body).sort(), ["aspect_ratio", "operation", "prompt"]);
  assert.equal(execute.body.operation, "text_to_image");
});

test("an error in the {error:{message}} shape surfaces the reason, not a bare status", async () => {
  const api = await listen(
    fakeApi({
      status: 422,
      body: { error: { code: "VALIDATION_FAILED", message: "Request body failed validation" } },
    }),
  );
  const result = await runCli(["generate", "x", "--quiet"], { DREAMLAYER_API_URL: api.url });
  api.close();

  assert.equal(result.code, 4);
  assert.match(result.stderr, /request could not be validated/i);
  assert.match(result.stderr, /Reason: invalid_request/);
});

test("a terminal failure is read from canonical state and uses the same safe taxonomy", async () => {
  const api = await listen(
    fakeApi({
      events: [started, { event: "done", data: { status: "failed" } }],
      execution: {
        execution_id: started.data.execution_id,
        conversation_id: started.data.conversation_id,
        status: "failed",
        image_job: {
          sanitized_error: {
            code: "generation_failed",
            reason: "temporarily_unavailable",
            message: "private-model raw response and secret prompt",
            retryable: true,
            request_id: "88888888-8888-4888-8888-888888888888",
          },
        },
      },
    }),
  );
  const result = await runCli(["generate", "secret prompt", "--json", "--quiet"], {
    DREAMLAYER_API_URL: api.url,
  });
  const canonicalRead = api.calls.some(
    (call) => call.url === `/v1/executions/${started.data.execution_id}`,
  );
  api.close();

  assert.equal(result.code, 5, result.stderr);
  assert.equal(result.stdout, "");
  const envelope = JSON.parse(result.stderr);
  assert.equal(envelope.error.reason, "temporarily_unavailable");
  assert.equal(envelope.error.retryable, true);
  assert.equal(envelope.error.request_id, "88888888-8888-4888-8888-888888888888");
  assert.equal(canonicalRead, true);
  assert.doesNotMatch(result.stderr, /private-model|raw response|secret prompt/);
});

test("a bad file is rejected locally, before anything is uploaded or charged", async () => {
  const api = await listen(fakeApi({ events: [] }));
  const result = await runCli(["cutout", "/nonexistent/nope.png", "--quiet"], {
    DREAMLAYER_API_URL: api.url,
  });
  const touched = api.calls.length;
  api.close();

  assert.equal(result.code, 1);
  assert.match(result.stderr, /local input file could not be read/);
  assert.equal(touched, 0, "an unreadable file must never reach the API");
});

test("refuses to send the key to a host that is not DreamLayer", async () => {
  // In August a build pointed the endpoint at the bare marketing apex and every request
  // carried Authorization there for two days. The origin passed every cleanliness check
  // because those check a URL's SHAPE, never which host it names.
  const result = await runCli(["capabilities"], {
    DREAMLAYER_API_URL: "https://dreamlayer.io",
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Refusing to send an API key to dreamlayer\.io/);
  assert.match(result.stderr, /Expected api\.dreamlayer\.io/);
});

test("the override exists, so a real alternate deployment is still reachable", async () => {
  const api = await listen(fakeApi({ events: [] }));
  const result = await runCli(["capabilities"], {
    DREAMLAYER_API_URL: api.url,
    DREAMLAYER_ALLOW_ANY_HOST: "1",
  });
  api.close();
  assert.equal(result.code, 0, result.stderr);
});

test("never sends the key to an off-origin download_url", async () => {
  // download_url arrives in the event stream and is validated only as text. Node strips
  // Authorization across a cross-origin REDIRECT, but the first request goes wherever
  // the field says, so the header has to be gated on the origin instead.
  const seen = [];
  const thief = createServer((request, response) => {
    seen.push(request.headers.authorization ?? null);
    response.writeHead(200, { "content-type": "image/png" }).end(PNG);
  });
  await new Promise((resolve) => thief.listen(0, "127.0.0.1", resolve));
  const thiefUrl = `http://127.0.0.1:${thief.address().port}/stolen.png`;

  const api = await listen(
    fakeApi({
      events: [
        started,
        {
          event: "asset",
          data: { asset_id: "44444444-4444-4444-8444-444444444444", download_url: thiefUrl },
        },
        { event: "done", data: { status: "completed" } },
      ],
    }),
  );
  const result = await runCli(
    ["generate", "a cat", "--out", path.join(temp, "off.png"), "--quiet"],
    { DREAMLAYER_API_URL: api.url },
  );
  api.close();
  thief.close();

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(seen, [null], `the key was sent off-origin: ${JSON.stringify(seen)}`);
});

test("an edit instruction with no image asks for one, and exit 6 stays reachable", async () => {
  // Naming an operation suppresses the CLASSIFIER's clarifying questions, which was
  // confirmed live: every CLI command names one, and none of them came back as a
  // question. That made `answer` and exit 6 look like dead surface.
  //
  // They are not. The server computes needs_input SEPARATELY from operation:
  //   needs_input   = _needs_input(message, input_asset_id)
  //   route_prepared = needs_input or body.operation is not None
  // So an edit-shaped prompt with no attached image still asks "Which image should I
  // use?", which is the useful case: someone typed an edit into `generate` and gets
  // asked for the picture instead of a nonsense image.
  //
  // This pins that path deterministically and for free, so it cannot quietly become
  // unreachable and leave the CLI advertising an outcome it can no longer produce.
  const api = await listen(
    fakeApi({
      events: [
        started,
        {
          event: "question",
          data: {
            question_id: "55555555-5555-4555-8555-555555555555",
            conversation_id: "33333333-3333-4333-8333-333333333333",
            text: "Which image should I use? Upload or attach one, then respond.",
          },
        },
        { event: "done", data: { status: "needs_input" } },
      ],
    }),
  );

  const result = await runCli(["generate", "remove the background", "--quiet"], {
    DREAMLAYER_API_URL: api.url,
  });
  api.close();

  assert.equal(result.code, 6, "a question is its own outcome, not a failure");
  assert.match(result.stderr, /Which image should I use/);
  assert.match(result.stderr, /dreamlayer answer 33333333-3333-4333-8333-333333333333/);
  // The question asks for an image, so the suggested command has to be able to supply
  // one. Without this the documented path dead-ends on "an input asset is required".
  assert.match(result.stderr, /--image <file>/);
  assert.equal(result.stdout, "", "no result means stdout stays clean for pipes");
});

test("answer sends respond and conversation_id, and names no operation", async () => {
  // The reply to a question must NOT name an operation: the conversation already
  // carries that decision, and re-asserting it here would be the client overriding
  // state the server owns.
  const api = await listen(
    fakeApi({
      events: [
        started,
        {
          event: "asset",
          data: { asset_id: "44444444-4444-4444-8444-444444444444", download_url: "ASSET" },
        },
        { event: "done", data: { status: "completed" } },
      ],
    }),
  );

  const result = await runCli(
    [
      "answer",
      "33333333-3333-4333-8333-333333333333",
      "use the product shot",
      "--out",
      path.join(temp, "answered.png"),
      "--quiet",
    ],
    { DREAMLAYER_API_URL: api.url },
  );
  const execute = api.calls.find((call) => call.url === "/v1/execute");
  api.close();

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(Object.keys(execute.body).sort(), ["conversation_id", "respond"]);
});

test("answer --image uploads the file and completes the question it was asked", async () => {
  // The other half of the path. Answering a needs_input question with words alone is
  // refused server-side: `pending_requires_asset and input_asset_id is None` is a 422.
  // This guards against the dead end returning.
  const api = await listen(
    fakeApi({
      events: [
        started,
        {
          event: "asset",
          data: { asset_id: "44444444-4444-4444-8444-444444444444", download_url: "ASSET" },
        },
        { event: "done", data: { status: "completed" } },
      ],
    }),
  );
  const source = path.join(temp, "answer-source.png");
  await (await import("node:fs/promises")).writeFile(source, PNG);
  const out = path.join(temp, "answered-with-image.png");

  const result = await runCli(
    [
      "answer",
      "33333333-3333-4333-8333-333333333333",
      "use this one",
      "--image",
      source,
      "--out",
      out,
      "--quiet",
    ],
    { DREAMLAYER_API_URL: api.url },
  );
  const uploaded = api.calls.some((call) => call.url === "/v1/input-assets");
  const execute = api.calls.find((call) => call.url === "/v1/execute");
  api.close();

  assert.equal(result.code, 0, result.stderr);
  assert.ok(uploaded, "--image must upload before answering");
  assert.deepEqual(
    Object.keys(execute.body).sort(),
    ["conversation_id", "input_asset_id", "respond"],
    "the reply carries the asset, and still names no operation",
  );
  assert.equal(result.stdout.trim(), out);
});

test("every operation the client can name is reachable from a command", async () => {
  // Coverage, derived from source rather than restated. The sibling test above loops
  // over a hand-written ["cutout", "upscale"], which proves those two work and says
  // nothing about a third. Adding a case to ManagedOperation without wiring a command
  // ships a client that can describe work no user can ask for, and every existing test
  // stays green because none of them knows the operation exists.
  //
  // The type is erased at runtime, so this reads the source. That is the point: it is
  // the only place the full set is written down once.
  const clientSrc = await readFile(new URL("../src/client.ts", import.meta.url), "utf8");
  const cliSrc = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");

  // Reads KNOWN_OPERATIONS, which is now the single definition: ManagedOperation is
  // derived from it rather than written out a second time.
  const block = clientSrc.match(/export const KNOWN_OPERATIONS = \[([\s\S]*?)\] as const;/);
  assert.ok(block, "KNOWN_OPERATIONS is no longer declared the way this test reads it");
  const operations = [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(operations.length >= 4, `parsed too few operations: ${operations}`);

  const unreachable = operations.filter(
    (op) => !cliSrc.includes(`operation: "${op}"`) && !cliSrc.includes(`imageCommand("${op}"`),
  );
  assert.deepEqual(unreachable, [], `no CLI command dispatches these: ${unreachable}`);
});

test("a slow job is not a dead connection, and a dead one names the job", async () => {
  // The shipped bug, reproduced. REQUEST_TIMEOUT_MS was a TOTAL cap of 130s applied to
  // the stream, and an upscale of a 2048px image takes about 150s server-side. So
  // `dreamlayer upscale` failed 100% of the time on a normal input, after the server had
  // already done the work and charged for it.
  //
  // Two halves, and the first is why raising the constant is not the fix:
  //   1. a job that takes longer than any fixed cap, but keeps the line warm, SUCCEEDS
  //   2. a connection that genuinely dies is still caught, exits 5, and names the job
  //
  // A total-duration timeout cannot tell these apart. An idle timeout can, which is
  // exactly what the server's `: keepalive` comments are for.
  // Half 1: dribble keepalives past any plausible fixed cap, then finish.
  const slow = createServer((request, response) => {
    if (request.url === "/asset.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(PNG);
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`id: 1\nevent: started\ndata: ${JSON.stringify(started.data)}\n\n`);
    const origin = `http://127.0.0.1:${slow.address().port}`;
    let ticks = 0;
    // Dribble keepalives well past the idle window this run is configured with, so the
    // ONLY thing keeping the stream alive is the resetting-on-bytes behaviour.
    const beat = setInterval(() => {
      ticks += 1;
      response.write(": keepalive\n\n");
      if (ticks >= 8) {
        clearInterval(beat);
        const asset = { asset_id: "44444444-4444-4444-8444-444444444444", download_url: `${origin}/asset.png` };
        response.write(`id: 2\nevent: asset\ndata: ${JSON.stringify(asset)}\n\n`);
        response.write(`id: 3\nevent: done\ndata: ${JSON.stringify({ status: "completed" })}\n\n`);
        response.end();
      }
    }, 120);
  });
  await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));
  const temp = await mkdtemp(path.join(tmpdir(), "dl-idle-"));
  const slowResult = await runCli(
    ["generate", "a greenhouse", "--out", path.join(temp, "o.png"), "--quiet"],
    {
      DREAMLAYER_API_URL: `http://127.0.0.1:${slow.address().port}`,
      // 400ms idle window, 8 beats at 120ms = ~960ms of stream. A total-duration cap of
      // 400ms would kill this; an idle one must not.
      DREAMLAYER_STREAM_IDLE_MS: "400",
    },
  );
  slow.close();
  assert.equal(slowResult.code, 0, `a live-but-slow stream must succeed: ${slowResult.stderr}`);

  // Half 2: send `started`, then never speak again.
  const dead = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`id: 1\nevent: started\ndata: ${JSON.stringify(started.data)}\n\n`);
    // deliberately no end(), no further bytes
  });
  await new Promise((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const deadResult = await runCli(["generate", "a greenhouse", "--quiet"], {
    DREAMLAYER_API_URL: `http://127.0.0.1:${dead.address().port}`,
    DREAMLAYER_STREAM_IDLE_MS: "400",
  });
  dead.close();

  assert.equal(deadResult.code, 5, `a dead stream is retryable, not a generic crash: ${deadResult.stderr}`);
  assert.match(deadResult.stderr, /--idempotency-key/, "the double-charge guard must print");
  assert.match(
    deadResult.stderr,
    /dreamlayer status 22222222-2222-4222-8222-222222222222/,
    "the execution id arrived in `started` and must not be discarded",
  );
});

test("capabilities says so when this build and the server disagree", async () => {
  // The CLI cannot do what the MCP does. ManagedOperation is a compile-time union and
  // `cutout` / `upscale` are compile-time commands, so deriving the list at runtime
  // would buy consistency by giving up type safety at every call site. It reports
  // instead of adapting, and it reports HERE because `capabilities` is free, spends
  // nothing, and is the command people are told to run first.
  //
  // Both directions matter. A server that offers more means the user is missing a
  // feature they are paying for. A client that names more is the failure that shipped
  // on 2026-08-21, where a doomed call looked like a client bug rather than version skew.
  const api = await listen(
    fakeApi({ capabilities: { api_version: "1", key_mode: "live", operations: ["text_to_image", "colorize"] } }),
  );
  const result = await runCli(["capabilities"], { DREAMLAYER_API_URL: api.url });
  api.close();

  assert.equal(result.code, 0, "drift is a warning, not a failure");
  // stdout stays clean JSON: this command gets piped into jq.
  JSON.parse(result.stdout);
  assert.match(result.stderr, /server offers, this version cannot use: colorize/);
  assert.match(result.stderr, /npm i -g dreamlayer/);
  assert.match(
    result.stderr,
    /this version names, the server will not run: .*upscale/i,
    "must also name what this build offers that the server will not run",
  );
});

test("capabilities stays quiet when the lists agree", async () => {
  const api = await listen(
    fakeApi({
      capabilities: {
        api_version: "1",
        key_mode: "live",
        operations: ["text_to_image", "image_to_image", "background_remove", "upscale"],
      },
    }),
  );
  const result = await runCli(["capabilities"], { DREAMLAYER_API_URL: api.url });
  api.close();

  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stderr, /disagree/, "no warning when there is nothing to warn about");
});

for (const [count, credits] of [[7,5.8],[14,11.6],[15,12],[99,46.6],[100,47]]) {
 test(`sprite CLI passes ${count} frames and its fractional approved limit`, async()=>{
  const api=await listen(fakeApi({capabilities:{api_version:'1',operations:['sprite_sheet'],sprite_pricing:{minimum_frames:7,maximum_frames:100}},events:[started,{event:'asset',data:{asset_id:'44444444-4444-4444-8444-444444444444',download_url:'ASSET'}},{event:'done',data:{status:'completed'}}]}));
  const dir=await mkdtemp(path.join(tmpdir(),'sprite-count-'));
  const input=path.join(dir,'reference.png');await writeFile(input,PNG);
  try {
   const result=await runCli(['sprite',input,'--frames',String(count),'--max-credits',String(credits),'--out',path.join(dir,'sheet.zip'),'--quiet'],{DREAMLAYER_API_URL:api.url});
   assert.equal(result.code,0,result.stderr);
   const body=api.calls.find(c=>c.url==='/v1/execute').body;
   assert.equal(body.options.frame_count,count);assert.equal(body.max_credits,credits);
  } finally {api.close();}
 });
}
for (const size of [32,64,128,256,512,720,1080]) {
 test(`custom sprite CLI forwards prompt, mode and ${size}px export`, async()=>{
  const api=await listen(fakeApi({capabilities:{api_version:'1',operations:['sprite_sheet'],sprite_pricing:{minimum_frames:7,maximum_frames:100}},events:[started,{event:'asset',data:{asset_id:'44444444-4444-4444-8444-444444444444',download_url:'ASSET'}},{event:'done',data:{status:'completed'}}]}));
  const dir=await mkdtemp(path.join(tmpdir(),'sprite-custom-'));
  const input=path.join(dir,'reference.png');await writeFile(input,PNG);
  try {
   const result=await runCli(['sprite',input,'--animation-prompt','Rotate this character 360 degrees','--animation-mode','loop','--frame-size',String(size),'--frames','7','--max-credits','5.8','--out',path.join(dir,'sheet.zip'),'--quiet'],{DREAMLAYER_API_URL:api.url});
   assert.equal(result.code,0,result.stderr);
   assert.deepEqual(api.calls.find(c=>c.url==='/v1/execute').body.options,{animation_prompt:'Rotate this character 360 degrees',animation_mode:'loop',frame_size:size,frame_count:7});
  } finally {api.close();}
 });
}
for (const args of [['--action','walk','--animation-prompt','spin'],['--frame-size','33'],['--animation-prompt',' '],['--animation-mode','maybe']]) {
 test(`invalid sprite options rejected before upload: ${args}`,async()=>{
  const api=await listen(fakeApi({events:[]}));
  try {const result=await runCli(['sprite','missing.png',...args,'--max-credits','100'],{DREAMLAYER_API_URL:api.url});assert.notEqual(result.code,0);assert.equal(api.calls.length,0);}finally{api.close();}
 });
}
for (const count of [6,101,7.5]) {
 test(`sprite CLI rejects ${count} frames before a network call`,async()=>{
  const api=await listen(fakeApi({events:[]}));
  try {const result=await runCli(['sprite','missing.png','--frames',String(count),'--max-credits','100'],{DREAMLAYER_API_URL:api.url});assert.notEqual(result.code,0);assert.match(result.stderr,/7 to 100/);assert.equal(api.calls.length,0);}finally{api.close();}
 });
}


test("fractional funding explains affordability without changing JSON balances", async () => {
  const body = { promotional: 0, purchased: 5.7, available: 5.8, credit_usd: "0.17" };
  const api = await listen(fakeApi({ events: [], balanceBody: body }));
  try {
    const human = await runCli(["balance"], { DREAMLAYER_API_URL: api.url });
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /5.8 credits available/);
    assert.match(human.stdout, /Use the available total for affordability/);
    const json = await runCli(["balance", "--json"], { DREAMLAYER_API_URL: api.url });
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), body);
  } finally { api.close(); }
});


test("JSON usage errors remain parseable and do not leak local arguments", async () => {
  const result = await runCli(["edit", "/private/customer-photo.png", "--json"], {});
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error.reason, "invalid_request");
  assert.doesNotMatch(result.stderr, /customer-photo/);
});

test("subcommand help requires no credentials or network", async () => {
  const result = await runCli(["sprite", "--help"], { DREAMLAYER_API_KEY: "" });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /EXIT CODES/);
});

test("download recovers existing assets using GET only and refuses overwrite", async () => {
  const handler = fakeApi({});
  const api = await listen(handler);
  const directory = await mkdtemp(path.join(tmpdir(), "dreamlayer-download-"));
  const destination = path.join(directory, "result.png");
  handler.server.removeAllListeners('request');
  handler.server.on('request', (request, response) => {
    handler.calls.push({ method: request.method, url: request.url });
    if (request.url === '/asset.png') return response.end(PNG);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'completed', image_job: { finished_assets: [{ download_url: api.url + '/asset.png' }] } }));
  });
  try {
    const result = await runCli(['download', 'owned', '--out', destination, '--json'], { DREAMLAYER_API_URL: api.url });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).execution_id, 'owned');
    assert.deepEqual(await readFile(destination), PNG);
    assert.ok(handler.calls.every(call => call.method === 'GET'));
    const duplicate = await runCli(['download', 'owned', '--out', destination, '--json'], { DREAMLAYER_API_URL: api.url });
    assert.equal(duplicate.code, 1);
    const failure = JSON.parse(duplicate.stderr).error;
    assert.equal(failure.reason, 'local_output_failed');
    assert.equal(failure.execution_id, 'owned');
    assert.equal(failure.retryable, true);
    assert.match(failure.guidance, /dreamlayer download/);
    assert.deepEqual(await readFile(destination), PNG);
  } finally { api.close(); }
});

for (const json of [false, true]) {
  test(`destination appearing during generation preserves download recovery (json=${json})`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dl-output-failed-"));
    const destination = path.join(directory, "result.png");
    const api = await listen(fakeApi({ onExecute: () => writeFileSync(destination, 'another process'), events: [started,
      { event: 'asset', data: {asset_id: '44444444-4444-4444-8444-444444444444', download_url: 'ASSET'} },
      { event: 'done', data: { status: 'completed' } }] }));
    try {
      const result = await runCli(['generate', 'a tree', '--out', destination, '--idempotency-key', 'saved-request', ...(json ? ['--json'] : [])], {DREAMLAYER_API_URL: api.url});
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      if (json) {
        const error = JSON.parse(result.stderr).error;
        assert.equal(error.reason, 'local_output_failed');
        assert.equal(error.retryable, true);
        assert.equal(error.execution_id, started.data.execution_id);
        assert.equal(error.idempotency_key, 'saved-request');
        assert.equal(await readFile(destination, 'utf8'), 'another process');
      } else {
        assert.match(result.stderr, /dreamlayer download/);
        assert.ok(result.stderr.includes(started.data.execution_id));
      }
      assert.equal(api.calls.filter(c => c.method === 'POST' && c.url === '/v1/execute').length, 1);
    } finally { api.close(); }
  });
}

test('missing key and unreadable input have distinct sanitized errors before network work', async () => {
  const api = await listen(fakeApi({events: []}));
  try {
    const auth = await runCli(['balance', '--json'], {DREAMLAYER_API_KEY: '', DREAMLAYER_API_URL: api.url});
    assert.equal(auth.code, 2);
    assert.equal(JSON.parse(auth.stderr).error.reason, 'authentication_failed');
    const file = await runCli(['edit', '/private/customer-secret-photo.png', 'a real prompt', '--json'], {DREAMLAYER_API_URL: api.url});
    assert.equal(file.code, 1);
    assert.equal(JSON.parse(file.stderr).error.reason, 'local_input_failed');
    assert.doesNotMatch(file.stderr, /customer-secret-photo/);
    assert.equal(api.calls.length, 0);
  } finally { api.close(); }
});

for (const state of [{status: 'running'}, {status: 'completed', image_job: {finished_assets: [{download_url: 'one'}, {download_url: 'two'}]}}]) {
  test(`download refuses ${state.status} without one output, and does not generate`, async () => {
    const api = await listen(fakeApi({events: [], execution: state}));
    try {
      const result = await runCli(['download', 'owned', '--out', 'unused.png', '--json'], {DREAMLAYER_API_URL: api.url});
      assert.equal(result.code, 5);
      assert.equal(JSON.parse(result.stderr).error.reason, 'output_not_ready');
      assert.deepEqual(api.calls.map(c => c.method), ['GET']);
    } finally { api.close(); }
  });
}

test('cancelled execution is a nonretryable stderr result', async () => {
  const api = await listen(fakeApi({events: [started, {event: 'done', data: {status: 'cancelled'}}]}));
  try {
    const result = await runCli(['generate', 'a tree', '--json'], {DREAMLAYER_API_URL: api.url});
    assert.equal(result.code, 4);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.reason, 'execution_cancelled');
    assert.equal(JSON.parse(result.stderr).error.retryable, false);
  } finally { api.close(); }
});

test('stream without an identifier is uncertain rather than a failed generation', async () => {
  const api = await listen(fakeApi({events: []}));
  try {
    const result = await runCli(['generate', 'a tree', '--idempotency-key', 'saved-request', '--json'], {DREAMLAYER_API_URL: api.url});
    assert.equal(result.code, 5);
    const error = JSON.parse(result.stderr).error;
    assert.equal(error.reason, 'temporarily_unavailable');
    assert.equal(error.idempotency_key, 'saved-request');
    assert.equal(api.calls.filter(c => c.method === 'POST').length, 1);
  } finally { api.close(); }
});

for (const command of [
  ['generate', 'a tree'], ['edit', 'missing.png', 'make it blue'],
  ['cutout', 'missing.png'], ['upscale', 'missing.png'],
  ['sprite', 'missing.png', '--max-credits', '100'], ['answer', 'conversation', 'yes']
]) {
  test(`${command[0]} refuses an existing output before any network request`, async () => {
    const api = await listen(fakeApi({events: []}));
    const dir = await mkdtemp(path.join(tmpdir(), 'dl-preflight-'));
    const out = path.join(dir, 'existing.png'); await writeFile(out, 'completed');
    try {
      const result = await runCli([...command, '--out', out, '--json'], {DREAMLAYER_API_URL: api.url});
      assert.equal(result.code, 1);
      const error = JSON.parse(result.stderr).error;
      assert.equal(error.reason, 'output_exists');
      assert.equal(error.retryable, false);
      assert.match(error.message, /no generation was submitted/i);
      assert.equal(api.calls.length, 0);
      assert.equal(await readFile(out, 'utf8'), 'completed');
    } finally { api.close(); }
  });
}

for (const kind of ['directory', 'dangling symlink', 'missing parent']) {
  test(`paid output preflight refuses ${kind} before submission`, async () => {
    const api = await listen(fakeApi({events: []}));
    const dir = await mkdtemp(path.join(tmpdir(), 'dl-preflight-kind-'));
    let out = dir;
    if (kind === 'dangling symlink') { out = path.join(dir, 'link'); await symlink(path.join(dir, 'missing'), out); }
    if (kind === 'missing parent') out = path.join(dir, 'missing', 'out.png');
    try {
      const result = await runCli(['generate', 'a tree', '--out', out, '--json'], {DREAMLAYER_API_URL: api.url});
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stderr).error.reason, kind === 'missing parent' ? 'output_unavailable' : 'output_exists');
      assert.equal(api.calls.length, 0);
    } finally { api.close(); }
  });
}

test('repeating a successful command with the same output does not submit a second paid job', async () => {
  const api = await listen(fakeApi({events: [started,
    {event:'asset',data:{asset_id:'44444444-4444-4444-8444-444444444444',download_url:'ASSET'}},
    {event:'done',data:{status:'completed'}}]}));
  const dir = await mkdtemp(path.join(tmpdir(), 'dl-repeat-'));
  const out = path.join(dir, 'same.png');
  try {
    const args = ['generate', 'a tree', '--out', out, '--json'];
    const first = await runCli(args, {DREAMLAYER_API_URL: api.url});
    assert.equal(first.code, 0, first.stderr);
    const second = await runCli(args, {DREAMLAYER_API_URL: api.url});
    assert.equal(second.code, 1);
    assert.equal(JSON.parse(second.stderr).error.reason, 'output_exists');
    assert.equal(api.calls.filter(c => c.method === 'POST' && c.url === '/v1/execute').length, 1);
    assert.deepEqual(await readFile(out), PNG);
    const help = await runCli(['--help'], {});
    assert.match(help.stdout, /Existing destinations are refused before paid submission/);
  } finally { api.close(); }
});

for (const json of [false, true]) {
  test(`transport diagnostics retain a safe cause and request key (json=${json})`, async () => {
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${probe.address().port}`;
    await new Promise(resolve => probe.close(resolve));
    const result = await runCli(['generate', 'PRIVATE PROMPT', '--idempotency-key', 'saved', '--quiet', ...(json ? ['--json'] : [])], {DREAMLAYER_API_URL: url});
    assert.equal(result.code, 5);
    assert.match(result.stderr, /Connection refused.*ECONNREFUSED/);
    assert.match(result.stderr, /saved/);
    assert.doesNotMatch(result.stderr, /PRIVATE PROMPT|127\.0\.0\.1|dlr_live_test/);
  });
  for (const status of [401, 403]) {
    test(`asset HTTP ${status} remains an access error (json=${json})`, async () => {
      const api = await listen(fakeApi({assetStatus: status, events: [started, {event:'asset',data:{asset_id:'44444444-4444-4444-8444-444444444444',download_url:'ASSET'}}, {event:'done',data:{status:'completed'}}]}));
      try {
        const result = await runCli(['generate','a tree','--quiet', ...(json ? ['--json'] : [])], {DREAMLAYER_API_URL:api.url});
        assert.equal(result.code, 2, result.stderr);
        assert.match(result.stderr, status === 401 ? /authentication_failed/ : /access_denied/);
        assert.doesNotMatch(result.stderr, /download_failed|private upstream details/);
        assert.equal(api.calls.filter(c=>c.method==='POST').length, 1);
        if(json) assert.equal(JSON.parse(result.stderr).error.execution_id, started.data.execution_id);
      } finally {api.close();}
    });
  }
}
test('cancelled text output recommends status without download or blank guidance', async () => {
  const api = await listen(fakeApi({events:[started,{event:'done',data:{status:'cancelled'}}]}));
  try {
    const result=await runCli(['generate','a tree','--quiet'],{DREAMLAYER_API_URL:api.url});
    assert.equal(result.code,4); assert.match(result.stderr,/dreamlayer status/);
    assert.doesNotMatch(result.stderr,/dreamlayer download|\n\n/);
  } finally {api.close();}
});
test('help-like option values do not short-circuit a command', async () => {
  const api=await listen(fakeApi({events:[started,{event:'done',data:{status:'cancelled'}}]}));
  try {
    const result=await runCli(['generate','a tree','--idempotency-key','-h','--quiet'],{DREAMLAYER_API_URL:api.url});
    assert.equal(result.code,4); assert.equal(api.calls.find(c=>c.method==='POST').headers['idempotency-key'],'-h');
    assert.doesNotMatch(result.stdout,/USAGE/);
  } finally {api.close();}
});

test('help after positional arguments requires no key or network', async () => {
  const result = await runCli(['generate', 'a tree', '--help'], {DREAMLAYER_API_KEY:'', DREAMLAYER_API_URL:'http://127.0.0.1:1'});
  assert.equal(result.code,0); assert.match(result.stdout,/USAGE/);
});
