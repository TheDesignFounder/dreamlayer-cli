# dreamlayer

Generate and edit images from your terminal, over local files, with one API key.

This working tree also contains the **unpublished 0.5.0-beta.0 video candidate**.
The published-image installation below does not enable video. To review the
candidate, use Node >=22.12, `pnpm install --frozen-lockfile`, `pnpm build`, then
`node dist/cli.js video ...` against a video-enabled test endpoint. No registry
publication or production activation is implied.

## Video candidate

Both text-to-video and one-image-to-video use quote-first admission. Quotes cost
no generation credits and return the selected model, resolved settings and fixed
API-credit price. `pricing_pending` is not executable. Execution requires an
explicit spending ceiling and a key saved before the request; no interactive
confirmation is required for automation.

```bash
# Replace dreamlayer below with node dist/cli.js when reviewing the local candidate.
dreamlayer video quote --prompt "A 15-second silent video of a forest" --operation txt2vid
dreamlayer video quote --prompt "Show this product on a clean white background" \
  --image ./product.png --operation img2vid --duration 15 --audio off
dreamlayer video quote --prompt "A slow camera pan through a furnished room" \
  --image ./room.png --model flux-3 --duration 20
dreamlayer video execute --quote QUOTE_ID --max-credits 40 --idempotency-key SAVED_UNIQUE_KEY
dreamlayer video status EXECUTION_ID
dreamlayer video wait EXECUTION_ID --wait-timeout 120
dreamlayer video download EXECUTION_ID --output ./result.mp4
```

`--image` accepts an owned uploaded asset UUID or a regular local image file
(up to 200 MB before existing server normalization; normalized video inputs must
fit the backend's 4096px-per-side / 20 MB limits). Multiple references are not in
V1. No supplied image is dropped. Default duration is 15s, resolution is the native
720p profile, and audio is off unless requested. Text aspect defaults to 16:9;
`--aspect 16:9|9:16|1:1` is text-only. Image video preserves the source-driven
native aspect and rejects fixed-aspect requests. Use `--context product` and
`--background white|non_white|unknown` for explicit product/background context.

Automatic image routing uses Seedance for requested white backgrounds and unknown
product backgrounds, FLUX for known non-white/lifestyle scenes. Above 20s it uses
Seedance; above 30s it rejects. Explicit FLUX is limited to 5–20s and is never
silently overridden. Seedance supports 4–30s. Source pixels are not classified.
Text routing is separate and provisionally uses FLUX up to 20s (Seedance at 4s or
21–30s), not a claim about text/audio quality.

Ordinary `generate "Make a 15-second video ..."` and `edit image.png "Make a video ..."`
return a quote rather than submitting paid video. Explicit image operations retain
their old behavior. Simple numeric prompt settings are validated; prefer structured
video flags for unambiguous settings.

Wait expiry exits **7** and leaves the job running. Retain its execution ID and
resume status/wait/download. After a lost submission response, repeat the same
quote, ceiling and idempotency key—even if the quote has since expired. Do not
create a replacement job. A failed download retries delivery, not generation.
Downloads stream with size/hash checks and never overwrite an existing path.
Outputs remain available for 30 days; fresh download requests renew signed links.
There is no automatic second model/provider attempt. API credits are separate
from Studio credits; a later delivery after a restored hold is not charged again.

```bash
npm install -g dreamlayer@0.4.0-beta.4
export DREAMLAYER_API_KEY="dlr_live_your_key"

dreamlayer generate "A glass greenhouse at dusk" --out greenhouse.png
```

Get a key at [platform.dreamlayer.io](https://platform.dreamlayer.io). A new account
starts at zero credits. Ordinary image operations cost one credit each; sprite
bundles use frame-count pricing. This guide pins the sprite-capable beta;
`latest` remains `0.3.0`.

Use the CLI for raster logo concepts, product imagery, marketing visuals, print
artwork concepts and game assets. Inspect each output for its intended use.
[Installable agent workflows and engine examples](https://github.com/TheDesignFounder/dreamlayer-agent-plugin)
share the same capabilities, budget checks and recovery guidance.

## Commands

```bash
dreamlayer generate <prompt> [--aspect 16:9] [--out file.png]
dreamlayer edit <image> <prompt> [--out file.png]
dreamlayer cutout <image> [--out file.png]      # background removal
dreamlayer upscale <image> [--out file.png]     # 2x
dreamlayer answer <conversation-id> <text> [--image file.png]
dreamlayer status <execution-id>
dreamlayer download <execution-id> --out file.png
dreamlayer balance                              # spends nothing
dreamlayer capabilities                         # spends nothing
```

`cutout` and `upscale` name their operation rather than hoping a sentence is read the
way you meant, so they run a dedicated chain and never stop to ask a question.

Image inputs may be PNG, JPEG, WebP, or supported camera RAW files up to 200 MB.
DreamLayer develops RAW previews, applies camera orientation, and resizes oversized
sources on the server before any operation runs.

`upscale` doubles each side and finished images are capped at 4096 per side, so the
longest side of your input must be 2048 or less. Anything larger is refused before it
costs you a credit.

## It composes

**stdout is the result, stderr is the narration.** On success stdout is the file path
and nothing else, so this works:

```bash
open "$(dreamlayer generate 'a fox logo')"
```

**Exit codes mean something**, so a script can branch instead of grepping:

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Usage error |
| 2 | Auth or account problem |
| 3 | Out of credits |
| 4 | Non-retryable request or execution failure |
| 5 | Temporary, worth retrying |
| 6 | It asked a question instead of producing an image |

```bash
for f in shots/*.png; do dreamlayer cutout "$f" --out "cut/$(basename "$f")" || break; done
```

**`--json`** gives machine-readable success output on stdout, carrying job state,
execution ids, and the written path. Errors use the same stable `code`, `reason`,
`message`, `retryable`, and `request_id` fields as REST and are written to stderr, so
stdout stays result-only. Error envelopes deliberately exclude your prompt, images,
local filenames, and key. Successful image JSON includes the destination path you chose;
remove it before sharing if the local name is private.

Check the authenticated key's own balance without starting image work:

```bash
dreamlayer balance
dreamlayer balance --json
```

## Retries are safe if you reuse the key

Save a key before starting text generation. After an uncertain response, reuse that key
and the identical prompt/options, or check the existing execution first:

```bash
dreamlayer generate "a fox logo" --idempotency-key fox-001
```

## Continue a question from another client

The CLI's `generate`, `edit`, `cutout`, `upscale`, and `sprite` commands select their
operation explicitly. `generate "remove the background"` therefore remains a
text-to-image request; use `cutout image.png` to remove a background.

A conversational request made through the API or MCP can instead ask for missing
input. Continue that conversation from the CLI using its saved conversation ID:

```bash
dreamlayer answer <conversation-id> "Use this image" --image reference.png
```

An answer that needs an image must attach one. Exit code 6 means the returned
conversation needs input; it does not mean a generation failed.

## Requirements

Node.js 22.12 or later.

## License

MIT. See LICENSE and NOTICE.

## Sprite-sheet beta

Sprite requests accept exactly one of `options.animation_prompt` (1–4000 characters) or an `options.action` preset (`walk`, `run`, `idle`). Custom prompts can describe characters, creatures, objects, effects or 360° turntables. `animation_mode` is `loop` or `once`; presets default to loop, custom prompts to once. For a turntable, request a stationary camera and rotating subject. Broad requests do not guarantee correct motion, unseen details or successful effect transparency.

Request integer `frame_count` 7–100 (default 12) and `frame_size` 32, 64, 128, 256, 512, 720 or 1080 (default 512). These are square export canvases; a larger export does not guarantee additional detail. Aspect ratio and shared alignment are preserved with transparent padding. A bundle contains transparent PNG frames, sheet, atlas, preview and import instructions, including each frame's playback duration. Pass `--background keep` when transparency is not needed: the frames keep the generated background, plain rather than cut out, at the flat plain rate. A frame that cannot be cut out is retried at nearby moments of the same clip, and a single stubborn frame ships with its background rather than failing the sheet; `atlas.json` lists any such frame in `kept_background_frames`. Choose a repeating loop or a one-time action with a beginning and ending. If the requested number of distinct frames cannot be delivered, the job fails and held credits are returned. Translucent effects can lose detail or fail; small exports are not automatically pixel art.

Pricing is unchanged across sizes: frames 1–14 cost $0.14 each; additional frames $0.07 each. With `--background keep` every frame is a flat $0.07 with no tier, roughly half a transparent sheet (12 frames: 5 credits instead of 9.9). One credit is $0.17. Round the complete order upward once to a tenth of a credit. Check `sprite_pricing` in capabilities and approve the quote with `max_credits`. Credits are held during processing, settled after complete delivery and restored on failure/timeout. There is no customer cancellation. Keep the execution ID to resume status. Custom requests need the matching broad-animation server release; older servers reject them. New live generation quality, 100-frame duration and actual cost remain unverified.

```sh
dreamlayer sprite character.png --action walk --frames 12 --max-credits 9.9 --out walk.zip
dreamlayer sprite character.png --action walk --frames 12 --background keep --max-credits 5 --out walk-plain.zip
dreamlayer status EXECUTION_ID
```

Set `--max-credits` to the amount you approve after checking the current price. The CLI reconnects to existing work if an event stream closes.

For affordability, compare the complete rounded quote in **credits** with `available`. One tenth of a credit is $0.017. Promotional and purchased amounts are displayed rounded down separately, so their displayed sum can be 0.1 credit below `available`; stored fractions are preserved. Compare against the combined total, not that sum. The order charge rounds only once, never per frame or per tier.

## Automating recovery

Commands never prompt. `--json` sends results to stdout and structured errors to stderr,
including usage and transport errors. Exit 0 from `status` means the read succeeded;
inspect its `status` field to learn whether the execution completed.

After a lost download, recover the existing execution without generation:

```sh
dreamlayer status EXECUTION_ID --json
dreamlayer download EXECUTION_ID --out recovered.png --json
```

All output commands refuse to overwrite existing files, directories, or symlinks.
Paid commands check `--out` before uploads or `/v1/execute`: an existing destination
returns `output_exists` (exit 1) without submitting or charging a new job. A missing or
unwritable parent returns `output_unavailable` (exit 1). Re-running a batch with the
same output paths therefore stops on completed files before paid work. Choose a new
path only for intentionally new work. The final write is still exclusive: if another
process creates the destination during generation, use the saved execution ID to
recover the completed output with `download`.

`download` also refuses to overwrite a file. Use `.zip` for sprite results. Generation errors
in JSON include the available execution ID and idempotency key for recovery. Treat them
as private identifiers. For file-based commands, rerunning uploads a new asset: the same
local file is not an identical API request. Prefer `status` and `download`, or the
[execution recovery guide](https://docs.dreamlayer.io/agent-api/jobs-and-events).

[API overview](https://docs.dreamlayer.io/agent-api) ·
[CLI guide](https://docs.dreamlayer.io/cli) ·
[MCP setup](https://docs.dreamlayer.io/mcp/index)

Local client failures are separate from API generation failures. `local_output_failed`
(exit 1) means the completed output could not be written; fix the destination and run
`download` with the saved execution ID. `download_failed` or `output_not_ready` (exit 5)
also require recovery of existing work, not a new generation. `retryable: true` means
retry the indicated recovery action, never blindly repeat a paid command.
`local_input_failed` (exit 1) means no readable input was supplied; missing credentials
use `authentication_failed` (exit 2). A cancelled run uses `execution_cancelled`, exit 4,
and a JSON error on stderr. Unknown client failures use `client_error`; they do not
prove that the server-side generation failed.

## Error handling updates in beta.3

Transport failures include a safe connection category without exposing URLs or credentials. Cancelled executions recommend a status check; download authentication failures retain exit code 2. Help flags are parsed as options so a literal `-h` option value is preserved.
