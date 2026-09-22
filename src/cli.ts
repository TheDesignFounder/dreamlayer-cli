#!/usr/bin/env node
import { spriteCreditPrice } from "./client.js";
/**
 * DreamLayer CLI.
 *
 * Generate and edit images from a terminal, over local files. The API is the same one
 * the MCP server and the web app use, and it spends from the same credit balance.
 *
 * Exit codes are meaningful, so this composes in a script:
 *   0  success
 *   1  usage error
 *   2  authentication or account problem (401, 403)
 *   3  out of credits (402)
 *   4  the request was rejected (409, 422)
 *   5  temporary, worth retrying (429, 5xx)
 *   6  the run ended asking a question instead of producing an image
 */
import { randomUUID } from "node:crypto";
import { openAsBlob, readFileSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ApiError,
  KNOWN_OPERATIONS,
  ManagedClient,
  StreamIdleError,
  UploadTimeoutError,
  terminalExecutionError,
} from "./client.js";
import type { ManagedExecuteInput, ManagedOperation } from "./client.js";
import { Progress, consume } from "./render.js";

const PACKAGE_VERSION = String(
  (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: unknown;
  }).version,
);

const USAGE = `dreamlayer - generate and edit images from your terminal

USAGE
  dreamlayer generate <prompt> [--aspect <ratio>] [--out <file>]
  dreamlayer edit <image> <prompt> [--out <file>]
  dreamlayer cutout <image> [--out <file>]
  dreamlayer upscale <image> [--out <file>]
  dreamlayer sprite <image> --action <walk|run|idle> [--frames <7–100>] --max-credits <n> [--out <zip>]
  dreamlayer answer <conversation-id> <text> [--image <file>] [--out <file>]
  dreamlayer download <execution-id> --out <file>
  dreamlayer status <execution-id>
  dreamlayer balance
  dreamlayer capabilities

OPTIONS
  --out <file>      Where to write the image. Default: dreamlayer-<n>.png
  --image <file>    Attach an image when answering a question that asks for one
  --aspect <ratio>  1:1, 16:9, 9:16, 4:3, 3:4. Default 1:1
  --action <name>  Sprite preset: walk, run, idle (walk if no custom prompt)
  --animation-prompt <text>  Custom animation; cannot combine with --action
  --animation-mode <loop|once>  Default: loop for presets, once for custom
  --frame-size <px> Square export: 32, 64, 128, 256, 512 (default), 720, 1080
  --frames <n>      Frame count: integer 7–100, default 12
  --max-credits <n> Maximum approved charge for the sprite job
  --json            JSON results on stdout; JSON errors on stderr
  --quiet           No progress on stderr
  --idempotency-key <key>  Reuse to retry safely after an uncertain response

EXIT CODES
  0 success, 1 usage/local error, 2 authentication/access, 3 credits/quota,
  4 permanent API failure, 5 temporary failure, 6 input required

AUTOMATION
  Commands never prompt. Save a unique --idempotency-key before paid work.
  After uncertainty, use status then download; do not start a replacement job.
  JSON output is documented at https://docs.dreamlayer.io/cli/automation

ENVIRONMENT
  DREAMLAYER_API_KEY   Required. Get one at https://platform.dreamlayer.io
  DREAMLAYER_API_URL   Override the endpoint. Default https://api.dreamlayer.io

Image operations cost one credit. Sprite pricing is listed in capabilities. A new account starts at zero.
`;

type Options = {
  action?: "walk" | "run" | "idle";
  animationPrompt?: string;
  animationMode?: "loop" | "once";
  frameSize?: 32 | 64 | 128 | 256 | 512 | 720 | 1080;
  maxCredits: number;
  frameCount: number;
  out: string | null;
  image: string | null;
  aspect: string;
  json: boolean;
  quiet: boolean;
  idempotencyKey: string | null;
};

class UsageError extends Error {}

function parseOptions(argv: string[]): { positional: string[]; options: Options } {
  const positional: string[] = [];
  const options: Options = {
    maxCredits: 1,
    frameCount: 12,
    out: null,
    image: null,
    aspect: "1:1",
    json: false,
    quiet: false,
    idempotencyKey: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") options.json = true;
    else if (token === "--quiet") options.quiet = true;
    else if (token === "--out" || token === "-o") {
      const value = argv[++i];
      if (!value) throw new UsageError("--out needs a file path");
      options.out = value;
    } else if (token === "--action") {
      const value = argv[++i];
      if (value !== "walk" && value !== "run" && value !== "idle") throw new UsageError("--action must be walk, run, or idle");
      options.action = value;
    } else if (token === "--animation-prompt") {
      const value = argv[++i];
      if (!value?.trim() || [...value].length > 4000) throw new UsageError("--animation-prompt needs 1–4000 characters");
      options.animationPrompt = value;
    } else if (token === "--animation-mode") {
      const value = argv[++i];
      if (value !== "loop" && value !== "once") throw new UsageError("--animation-mode must be loop or once");
      options.animationMode = value;
    } else if (token === "--frame-size") {
      const value = Number(argv[++i]);
      if (![32, 64, 128, 256, 512, 720, 1080].includes(value)) throw new UsageError("--frame-size must be 32, 64, 128, 256, 512, 720 or 1080");
      options.frameSize = value as Options["frameSize"];
    } else if (token === "--frames") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 7 || value > 100) throw new UsageError("--frames must be an integer from 7 to 100");
      options.frameCount = value;
    } else if (token === "--max-credits") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0.1 || value > 100) throw new UsageError("--max-credits must be 0.1 to 100");
      options.maxCredits = value;
    } else if (token === "--image") {
      const value = argv[++i];
      if (!value) throw new UsageError("--image needs a file path");
      options.image = value;
    } else if (token === "--aspect") {
      const value = argv[++i];
      if (!value) throw new UsageError("--aspect needs a ratio");
      options.aspect = value;
    } else if (token === "--idempotency-key") {
      const value = argv[++i];
      if (!value) throw new UsageError("--idempotency-key needs a value");
      options.idempotencyKey = value;
    } else if (token !== undefined && token.startsWith("-")) {
      throw new UsageError(`unknown option ${token}`);
    } else if (token !== undefined) {
      positional.push(token);
    }
  }
  return { positional, options };
}

function client(): ManagedClient {
  const key = (process.env.DREAMLAYER_API_KEY ?? "").trim();
  if (!key) {
    throw new UsageError(
      "DREAMLAYER_API_KEY is not set.\n" +
        "  export DREAMLAYER_API_KEY=dlr_live_...\n" +
        "  Get a key at https://platform.dreamlayer.io",
    );
  }
  return new ManagedClient(key, (process.env.DREAMLAYER_API_URL ?? "https://api.dreamlayer.io").trim());
}

const MAX_SOURCE_BYTES = 200 * 1024 * 1024;

/** Upload a local file; the server owns RAW, EXIF, alpha, and resize normalization. */
async function upload(api: ManagedClient, file: string): Promise<string> {
  const resolved = path.resolve(file);
  let fileStat;
  try {
    fileStat = await stat(resolved);
  } catch {
    throw new UsageError(`cannot read ${file}`);
  }
  if (fileStat.size > MAX_SOURCE_BYTES) {
    throw new UsageError(
      `${file} is ${Math.round(fileStat.size / 1024 / 1024)} MB; the limit is 200 MB`,
    );
  }
  const asset = await api.uploadInput(await openAsBlob(resolved), path.basename(resolved));
  return asset.input_asset_id;
}

function defaultOut(): string {
  return `dreamlayer-${Date.now()}.png`;
}

let recovery: { idempotency_key?: string; execution_id?: string | null } = {};

async function run(
  api: ManagedClient,
  input: ManagedExecuteInput,
  options: Options,
): Promise<number> {
  const progress = new Progress(!options.quiet && process.stderr.isTTY === true);
  const idempotencyKey = options.idempotencyKey ?? randomUUID();
  recovery = { idempotency_key: idempotencyKey };
  const outcome = await consume(api.follow(input, { idempotencyKey }), progress);
  recovery.execution_id = outcome.execution_id;

  if (outcome.question) {
    progress.stop();
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ...outcome, idempotency_key: idempotencyKey }, null, 2)}\n`);
    } else {
      process.stderr.write(`\nDreamLayer needs one more thing:\n  ${outcome.question.text}\n\n`);
      // The server's needs_input question always asks for an image, so point at the
      // flag that can supply one rather than the bare form that will 422.
      const wantsImage = /image/i.test(outcome.question.text);
      process.stderr.write(
        `Answer it with:\n  dreamlayer answer ${outcome.conversation_id} "your answer"` +
          `${wantsImage ? " --image <file>" : ""}\n`,
      );
    }
    return 6;
  }

  if (outcome.status !== "completed" || !outcome.asset) {
    progress.stop(options.json ? undefined : "Failed");
    if (outcome.status === "failed" && outcome.execution_id) {
      const terminal = terminalExecutionError(await api.getExecution(outcome.execution_id));
      if (terminal) throw terminal;
    }
    if (options.json) process.stdout.write(`${JSON.stringify({ ...outcome, idempotency_key: idempotencyKey }, null, 2)}\n`);
    else process.stderr.write(`Run ended as ${outcome.status}. Check the execution before retrying.\n`);
    return 5;
  }

  progress.set("Downloading");
  const bytes = await api.download(outcome.asset.download_url);
  const target = options.out ?? (input.operation === "sprite_sheet" ? `dreamlayer-${Date.now()}.zip` : defaultOut());
  await writeFile(target, bytes);
  progress.stop();

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...outcome, idempotency_key: idempotencyKey, file: path.resolve(target) }, null, 2)}\n`);
  } else {
    // The path on stdout and nothing else, so `$(dreamlayer generate ...)` is the file.
    process.stdout.write(`${target}\n`);
  }
  return 0;
}

async function imageCommand(
  operation: ManagedOperation,
  prompt: string,
  file: string,
  options: Options,
): Promise<number> {
  const api = client();
  const inputAssetId = await upload(api, file);
  return run(api, { prompt, operation, input_asset_id: inputAssetId }, options);
}

/**
 * Point a user at the job they may have paid for.
 *
 * Without this, a timed-out upscale left nothing to go on: no id, no command, and no
 * key-authenticated way to check a balance. "It might have charged you, good luck" is
 * not an acceptable end state for a paid call.
 */
function recoveryHint(error: unknown): string {
  const id =
    error !== null && typeof error === "object"
      ? (error as { partialOutcome?: { execution_id: string | null } }).partialOutcome
          ?.execution_id
      : null;
  return id ? `The job may still be running. Check it with:\n  dreamlayer status ${id}\n` : "";
}


/**
 * Say so when this build and the server disagree about what exists.
 *
 * The MCP package solves this by asking the server at startup and shaping its tool
 * schema from the answer. The CLI cannot: `ManagedOperation` is a compile-time union and
 * `cutout` / `upscale` are compile-time commands, so deriving the list at runtime would
 * buy consistency by giving up type safety at every call site.
 *
 * So it reports instead of adapting, and it does so HERE because `capabilities` is free,
 * spends nothing, and is the command people are told to run first. Both directions are
 * worth naming:
 *
 *   - the server offers something this build cannot reach -> the user is missing a
 *     feature they are paying for and would never know
 *   - this build names something the server will not run -> the failure that shipped on
 *     2026-08-21, where a call looked like a client bug rather than a version skew
 *
 * stderr, never stdout: `dreamlayer capabilities` is piped into jq.
 */
function warnIfOperationsDrifted(capabilities: unknown): void {
  const listed = (capabilities as { operations?: unknown }).operations;
  if (!Array.isArray(listed) || listed.some((o) => typeof o !== "string")) return;

  const server = new Set(listed as string[]);
  const mine = new Set<string>(KNOWN_OPERATIONS);
  const serverOnly = [...server].filter((o) => !mine.has(o));
  const clientOnly = [...mine].filter((o) => !server.has(o) && o !== "sprite_sheet");
  if (serverOnly.length === 0 && clientOnly.length === 0) return;

  process.stderr.write("\nThis CLI and the server disagree about the operation list.\n");
  if (serverOnly.length > 0) {
    process.stderr.write(
      `  The server offers, this version cannot use: ${serverOnly.join(", ")}\n` +
        "  Upgrade with: npm i -g dreamlayer\n",
    );
  }
  if (clientOnly.length > 0) {
    process.stderr.write(
      `  This version names, the server will not run: ${clientOnly.join(", ")}\n` +
        "  Those commands will fail validation until the server catches up.\n",
    );
  }
}

function exitCodeFor(error: ApiError): number {
  if (error.reason === "authentication_failed" || error.reason === "access_denied") return 2;
  if (error.reason === "insufficient_credits" || error.reason === "quota_exceeded") return 3;
  return error.retryable ? 5 : 4;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return 0;
  }

  const { positional, options } = parseOptions(rest);

  switch (command) {
    case "sprite": {
      if (options.action && options.animationPrompt) throw new UsageError("Use either --action or --animation-prompt, not both");
      const file = positional[0];
      if (!file) throw new UsageError("sprite needs a reference image");
      const api = client();
      const caps = await api.getCapabilities();
      if (!Array.isArray(caps.operations) || !caps.operations.includes("sprite_sheet")) throw new UsageError("sprite beta access is not enabled for this account");
      if (!caps.sprite_pricing) throw new UsageError("The server does not support configurable sprite pricing yet");
      const price = spriteCreditPrice(options.frameCount);
      if (options.maxCredits < price) throw new UsageError(`Sprite jobs require ${price} credits. Set --max-credits to approve that amount.`);
      return run(api, { operation: "sprite_sheet", input_asset_id: await upload(api, file), options: { ...(options.animationPrompt ? { animation_prompt: options.animationPrompt } : { action: options.action ?? "walk" }), ...(options.animationMode ? { animation_mode: options.animationMode } : {}), ...(options.frameSize ? { frame_size: options.frameSize } : {}), frame_count: options.frameCount }, max_credits: options.maxCredits }, options);
    }
    case "generate": {
      const prompt = positional[0];
      if (!prompt) throw new UsageError("generate needs a prompt");
      return run(
        client(),
        { prompt, operation: "text_to_image", aspect_ratio: options.aspect },
        options,
      );
    }
    case "edit": {
      const [file, prompt] = positional;
      if (!file || !prompt) throw new UsageError("edit needs an image and a prompt");
      return imageCommand("image_to_image", prompt, file, options);
    }
    case "cutout": {
      const file = positional[0];
      if (!file) throw new UsageError("cutout needs an image");
      return imageCommand("background_remove", "remove the background", file, options);
    }
    case "upscale": {
      const file = positional[0];
      if (!file) throw new UsageError("upscale needs an image");
      return imageCommand("upscale", "upscale this image", file, options);
    }
    case "answer": {
      const [conversationId, text] = positional;
      if (!conversationId || !text) throw new UsageError("answer needs a conversation id and text");
      const api = client();
      // A question that asks for an image cannot be answered with words alone: the
      // server refuses a reply with no asset when the pending question required one.
      // Without --image this command reached a clean 422 and the documented path
      // dead-ended, telling the user to attach an image and offering no way to do it.
      const input = options.image ? await upload(api, options.image) : undefined;
      return run(
        api,
        {
          respond: text,
          conversation_id: conversationId,
          ...(input ? { input_asset_id: input } : {}),
        },
        options,
      );
    }
    case "download": {
      const executionId = positional[0];
      if (!executionId || positional.length !== 1 || !options.out) throw new UsageError("download needs one execution id and --out <file>");
      const api = client();
      recovery = { execution_id: executionId };
      const execution = await api.getExecution(executionId);
      const assets = execution.image_job?.finished_assets;
      if (execution.status !== "completed" || !Array.isArray(assets) || assets.length !== 1 || typeof assets[0]?.download_url !== "string") throw new UsageError("The execution has no finished asset. Check status before downloading.");
      const bytes = await api.download(assets[0].download_url);
      await writeFile(options.out, bytes, { flag: "wx" });
      process.stdout.write(options.json ? `${JSON.stringify({ execution_id: executionId, file: path.resolve(options.out), bytes: bytes.length })}\n` : `${options.out}\n`);
      return 0;
    }
    case "status": {
      const executionId = positional[0];
      if (!executionId) throw new UsageError("status needs an execution id");
      const execution = await client().getExecution(executionId);
      process.stdout.write(`${JSON.stringify(execution, null, 2)}\n`);
      return 0;
    }
    case "balance": {
      if (positional.length > 0) throw new UsageError("balance takes no arguments");
      const balance = await client().getBalance();
      if (options.json) {
        process.stdout.write(`${JSON.stringify(balance, null, 2)}\n`);
      } else {
        process.stdout.write(
          `${balance.available} credits available ` +
            `(${balance.promotional} promotional, ${balance.purchased} purchased)\n`,
        );
      }
      if (!options.json && Math.round(balance.available * 10) > Math.round(balance.promotional * 10) + Math.round(balance.purchased * 10)) {
        process.stdout.write("Use the available total for affordability. Funding balances are rounded down separately; stored fractions are preserved.\n");
      }
      return 0;
    }
    case "capabilities": {
      const capabilities = await client().getCapabilities();
      process.stdout.write(`${JSON.stringify(capabilities, null, 2)}\n`);
      warnIfOperationsDrifted(capabilities);
      return 0;
    }
    default:
      throw new UsageError(`unknown command ${command}`);
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (process.argv.slice(2).includes("--json")) {
      const partial = (error as { partialOutcome?: { execution_id?: string | null } } | null)?.partialOutcome;
      const temporary = error instanceof StreamIdleError || error instanceof UploadTimeoutError;
      const envelope = error instanceof ApiError ? error.toPublicEnvelope() : {
        error: { code: error instanceof UsageError ? "VALIDATION_FAILED" : temporary ? "SERVICE_UNAVAILABLE" : "INTERNAL_ERROR",
          reason: error instanceof UsageError ? "invalid_request" : temporary ? "temporarily_unavailable" : "generation_failed",
          message: error instanceof UsageError ? "Check command arguments and local input or output files; use --help." : temporary ? "The request timed out. Check the saved execution before retrying." : "The command could not complete. Check saved execution state and local output access.",
          retryable: temporary, request_id: null },
      };
      process.stderr.write(`${JSON.stringify({ error: { ...(envelope.error as Record<string, unknown>), ...recovery, ...(partial?.execution_id ? { execution_id: partial.execution_id } : {}) } })}\n`);
      process.exitCode = error instanceof ApiError ? exitCodeFor(error) : temporary ? 5 : 1;
      return;
    }
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    if (error instanceof ApiError) {
      const hint =
        error.reason === "insufficient_credits"
          ? "Buy credits at https://platform.dreamlayer.io/console/billing"
          : error.retryable
            ? "Temporary. Retry with --idempotency-key to avoid paying twice."
            : "";
      if (process.argv.slice(2).includes("--json")) {
        process.stderr.write(`${JSON.stringify(error.toPublicEnvelope())}\n`);
      } else {
        process.stderr.write(
          `${error.message}\nReason: ${error.reason}${hint ? `\n${hint}` : ""}\n`,
        );
      }
      process.exitCode = exitCodeFor(error);
      return;
    }
    // A stream that went silent is retryable, and it is the failure MOST likely to
    // have been charged for: the server may have finished the job we stopped listening
    // to. It reached this generic branch as a bare DOMException, so it exited 1 with no
    // guidance, and the --idempotency-key advice that exists precisely to prevent
    // double payment never printed on the one case that needs it.
    if (error instanceof StreamIdleError) {
      process.stderr.write(`${error.message}\n`);
      process.stderr.write("Temporary. Retry with --idempotency-key to avoid paying twice.\n");
      process.stderr.write(recoveryHint(error));
      process.exitCode = 5;
      return;
    }
    if (error instanceof UploadTimeoutError) {
      process.stderr.write(`${error.message}\n`);
      process.stderr.write("Temporary. Retry with --idempotency-key to avoid paying twice.\n");
      process.exitCode = 5;
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(recoveryHint(error));
    process.exitCode = 1;
  });
