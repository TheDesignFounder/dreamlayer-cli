import { createHash, randomUUID } from "node:crypto";
import { open, link, unlink, lstat } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import path from "node:path";
import { ManagedClient, ApiError, InputValidationError, RecoveryRequiredError } from "./client.js";

export async function downloadVideo(client: ManagedClient, id: string, target: string): Promise<number> {
  const state = await client.getExecution(id);
  if (state.status !== "completed" || !state.video_job) throw new InputValidationError("Video is not ready; retain the execution ID");
  const metadata = state.video_job.metadata as { sha256?: string; bytes?: number } | undefined;
  if (!metadata?.sha256 || !metadata.bytes) throw new InputValidationError("Video metadata is missing");
  try { await lstat(target); throw new InputValidationError("Destination exists; choose a new path"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temp = path.join(path.dirname(target), `.dreamlayer-video-${randomUUID()}.part`);
  const file = await open(temp, "wx", 0o600);
  let bytes = 0;
  try {
    const response = await client.videoDownloadResponse(id);
    if (!response.body) throw new RecoveryRequiredError("Missing video body; retry the same download");
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 256 * 1024 * 1024 || bytes > metadata.bytes) throw new InputValidationError("Video exceeds declared size");
        hash.update(chunk.value);
        await file.writeFile(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (bytes !== metadata.bytes || hash.digest("hex") !== metadata.sha256) throw new RecoveryRequiredError("Download checksum mismatch; retry delivery only");
    await file.sync();
    await file.close();
    await link(temp, target); // Atomic publish without overwriting an existing destination.
    return bytes;
  } finally { await file.close().catch(() => {}); await unlink(temp).catch(() => {}); }
}

export async function videoMain(argv: string[]): Promise<number> {
  const action = argv[0];
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") continue;
    if (arg.startsWith("--")) {
      if (!["prompt","image","operation","model","duration","resolution","audio","aspect","context","background","quote","max-credits","idempotency-key","wait-timeout","output"].includes(arg.slice(2))) throw new InputValidationError(`Unknown video flag ${arg}`);
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new InputValidationError(`Missing ${arg} value`);
      if (arg.slice(2) in flags) throw new InputValidationError(`Duplicate video flag ${arg}`);
      flags[arg.slice(2)] = value;
    } else positional.push(arg);
  }
  const allowed: Record<string, string[]> = {
    quote: ["prompt","image","operation","model","duration","resolution","audio","aspect","context","background"],
    execute: ["quote","max-credits","idempotency-key"],
    status: [], wait: ["wait-timeout"], download: ["output"],
  };
  if (!action || !allowed[action]) throw new InputValidationError("Use video quote|execute|status|wait|download");
  for (const key of Object.keys(flags)) if (!allowed[action]!.includes(key)) throw new InputValidationError(`--${key} is not valid for video ${action}`);
  if (positional.length > (["status","wait","download"].includes(action) ? 1 : 0)) throw new InputValidationError("Unexpected positional video arguments");
  const client = new ManagedClient(process.env.DREAMLAYER_API_KEY ?? "", process.env.DREAMLAYER_API_URL);
  let result: unknown;
  if (action === "quote") {
    if (!flags.prompt) throw new InputValidationError("--prompt is required");
    if (flags.audio && !["on","off"].includes(flags.audio)) throw new InputValidationError("--audio must be on or off");
    const options: Record<string, unknown> = {};
    if (flags.model) options.model = flags.model;
    if (flags.duration) {
      if (!Number.isInteger(Number(flags.duration))) throw new InputValidationError("--duration must be whole seconds");
      options.duration_seconds = Number(flags.duration);
    }
    if (flags.resolution) options.resolution = flags.resolution;
    if (flags.aspect) options.aspect_ratio = flags.aspect;
    if (flags.audio) options.generate_audio = flags.audio === "on";
    const context: Record<string, unknown> = {};
    if (flags.context) context.use_case = flags.context === "product" ? "product_showcase" : flags.context;
    if (flags.background) context.requested_background = flags.background === "white" ? "clean_white" : flags.background;
    const operation = flags.operation === "txt2vid" ? "text_to_video" : flags.operation === "img2vid" ? "image_to_video" : flags.operation;
    let image = flags.image;
    if (image && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(image)) {
      const source = path.resolve(image);
      const info = await lstat(source);
      if (!info.isFile() || info.size > 200 * 1024 * 1024) throw new InputValidationError("--image must be an owned asset UUID or a regular image file up to 200 MB");
      image = (await client.uploadInput(await openAsBlob(source), path.basename(source))).input_asset_id;
    }
    result = await client.quoteVideo({ prompt: flags.prompt, ...(image ? {input_asset_id: image} : {}), ...(operation ? {operation} : {}), options, context });
  } else if (action === "execute") {
    try {
      result = await client.executeVideo(flags.quote ?? "", Number(flags["max-credits"]), flags["idempotency-key"] ?? "");
    } catch (error) {
      if (error instanceof ApiError || error instanceof InputValidationError) throw error;
      process.stderr.write(JSON.stringify({error: "submission_outcome_unknown", quote_id: flags.quote, idempotency_key: flags["idempotency-key"], guidance: "Repeat the same execute command, quote and key to recover. Do not request replacement generation."}) + "\n");
      return 5;
    }
  } else if (action === "download") {
    if (!positional[0] || !flags.output) throw new InputValidationError("execution ID and --output are required");
    result = {execution_id: positional[0], path: flags.output, bytes: await downloadVideo(client, positional[0], flags.output)};
  } else if (action === "wait" || action === "status") {
    if (!positional[0]) throw new InputValidationError("execution ID is required");
    const seconds = Number(flags["wait-timeout"] ?? 120);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) throw new InputValidationError("wait timeout must be between 0 and 3600 seconds");
    const end = Date.now() + seconds * 1000;
    while (true) {
      const state = await client.getExecution(positional[0]);
      result = state;
      if (["failed","cancelled","expired"].includes(state.status)) {
        process.stdout.write(JSON.stringify(state) + "\n");
        return 1;
      }
      if (action === "status" || state.status === "completed") break;
      if (Date.now() >= end) {
        process.stdout.write(JSON.stringify({...state, wait_expired: true, resume: `dreamlayer video wait ${positional[0]}`}) + "\n");
        return 7;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(2000, end-Date.now())));
    }
  } else throw new InputValidationError("Use video quote|execute|status|wait|download");
  process.stdout.write(JSON.stringify(result) + "\n");
  return 0;
}
