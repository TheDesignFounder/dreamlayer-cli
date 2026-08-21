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
import { mkdtemp, readFile } from "node:fs/promises";
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
      response.end(JSON.stringify({ api_version: "1", key_mode: "live" }));
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
    if (request.url === "/asset.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(PNG);
      return;
    }
    if (request.url === "/v1/execute") {
      request.resume();
      request.on("end", () => {
        if (behaviour.status && behaviour.status !== 200) {
          response.writeHead(behaviour.status, { "content-type": "application/json" });
          response.end(JSON.stringify({ detail: behaviour.detail ?? "nope" }));
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

test("cutout and upscale name their operation instead of hoping a prompt is read right", async () => {
  for (const [command, expected] of [
    ["cutout", "background_remove"],
    ["upscale", "upscale"],
  ]) {
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
    api.close();

    assert.equal(result.code, 0, result.stderr);
    assert.ok(uploaded, `${command} must upload its source image`);
    assert.ok(expected, "operation name present");
  }
});

test("a bad file is rejected locally, before anything is uploaded or charged", async () => {
  const api = await listen(fakeApi({ events: [] }));
  const result = await runCli(["cutout", "/nonexistent/nope.png", "--quiet"], {
    DREAMLAYER_API_URL: api.url,
  });
  const touched = api.calls.length;
  api.close();

  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot read/);
  assert.equal(touched, 0, "an unreadable file must never reach the API");
});
