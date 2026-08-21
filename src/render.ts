/**
 * Terminal rendering of an execution.
 *
 * Two modes, decided by whether stdout is a TTY and whether --json was passed. A CLI
 * that only prints prose cannot be piped into anything, and one that only prints JSON
 * is miserable to watch. Progress goes to stderr so `dreamlayer generate ... | jq`
 * works without the spinner corrupting the pipe.
 */
import type { ManagedEvent } from "./client.js";

export type Outcome = {
  execution_id: string | null;
  conversation_id: string | null;
  status: string;
  asset: { asset_id: string; download_url: string } | null;
  question: { question_id: string; text: string } | null;
  last_event_id: string | null;
};

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Progress {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private label = "";

  constructor(private readonly enabled: boolean) {}

  set(label: string): void {
    this.label = label;
    if (!this.enabled) return;
    if (this.timer === null) {
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % FRAMES.length;
        process.stderr.write(`\r${FRAMES[this.frame]} ${this.label}[K`);
      }, 90);
      this.timer.unref();
    }
  }

  stop(final?: string): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.enabled) {
      if (final) process.stderr.write(`${final}\n`);
      return;
    }
    process.stderr.write(`\r[K`);
    if (final) process.stderr.write(`${final}\n`);
  }
}

/** Human wording for each event. `thinking` carries no text by contract. */
function describe(event: ManagedEvent): string | null {
  switch (event.event) {
    case "started":
      return "Starting";
    case "thinking":
      return "Working";
    case "progress":
      return String(event.data.text ?? "Working");
    case "job":
      return `Job ${String(event.data.status)}`;
    case "question":
      return null;
    case "asset":
      return "Downloading";
    case "done":
      return null;
  }
}

export async function consume(
  stream: AsyncGenerator<ManagedEvent>,
  progress: Progress,
  onEvent?: (event: ManagedEvent) => void,
): Promise<Outcome> {
  const outcome: Outcome = {
    execution_id: null,
    conversation_id: null,
    status: "unknown",
    asset: null,
    question: null,
    last_event_id: null,
  };

  try {
    for await (const event of stream) {
      onEvent?.(event);
      outcome.last_event_id = event.id;
      const label = describe(event);
      if (label) progress.set(label);

      if (event.event === "started") {
        outcome.execution_id = String(event.data.execution_id);
        outcome.conversation_id = String(event.data.conversation_id);
      } else if (event.event === "asset") {
        outcome.asset = {
          asset_id: String(event.data.asset_id),
          download_url: String(event.data.download_url),
        };
      } else if (event.event === "question") {
        outcome.question = {
          question_id: String(event.data.question_id),
          text: String(event.data.text),
        };
        if (event.data.conversation_id) {
          outcome.conversation_id = String(event.data.conversation_id);
        }
      } else if (event.event === "done") {
        outcome.status = String(event.data.status);
        if (event.data.conversation_id) {
          outcome.conversation_id = String(event.data.conversation_id);
        }
      }
    }
  } catch (error) {
    // `started` arrives within seconds and carries the execution id. When the stream
    // later dies, that id is the only way a user can find a job they may already have
    // paid for, and it was being discarded along with the exception.
    //
    // Attached to the error rather than wrapped in a new one: the top-level handler
    // branches on `instanceof ApiError`, and a wrapper would silently defeat that
    // while looking tidier.
    if (error !== null && typeof error === "object") {
      (error as { partialOutcome?: Outcome }).partialOutcome = outcome;
    }
    throw error;
  }
  return outcome;
}
