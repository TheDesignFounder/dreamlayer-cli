# dreamlayer

Generate and edit images from your terminal, over local files, with one API key.

```bash
npm install -g dreamlayer
export DREAMLAYER_API_KEY="dlr_live_your_key"

dreamlayer generate "A glass greenhouse at dusk" --out greenhouse.png
```

Get a key at [platform.dreamlayer.io](https://platform.dreamlayer.io). A new account
starts at zero credits, and each finished image costs one.

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

## A question is not a failure

An edit-shaped prompt with no image exits 6 and asks for one:

```bash
dreamlayer generate "remove the background"
# Which image should I use? Upload or attach one, then respond.
#   dreamlayer answer <id> "your answer" --image <file>
```

Answer it with the image attached. Words alone are refused, because the question is
asking for a picture, not a clarification.

Naming an operation avoids the round trip entirely, which is why `cutout`, `upscale`,
`edit`, and `generate` all do.

## Requirements

Node.js 22.12 or later.

## License

MIT. See LICENSE and NOTICE.

## Sprite-sheet beta

Sprite requests accept exactly one of `options.animation_prompt` (1–4000 characters) or an `options.action` preset (`walk`, `run`, `idle`). Custom prompts can describe characters, creatures, objects, effects or 360° turntables. `animation_mode` is `loop` or `once`; presets default to loop, custom prompts to once. For a turntable, request a stationary camera and rotating subject. Broad requests do not guarantee correct motion, unseen details or successful effect transparency.

Request integer `frame_count` 7–100 (default 12) and `frame_size` 32, 64, 128, 256, 512, 720 or 1080 (default 512). These are square export canvases; a larger export does not guarantee additional detail. Aspect ratio and shared alignment are preserved with transparent padding. A bundle contains transparent PNG frames, sheet, atlas, preview and import instructions, including each frame's playback duration. Choose a repeating loop or a one-time action with a beginning and ending. If the requested number of distinct frames cannot be delivered, the job fails and held credits are returned. Translucent effects can lose detail or fail; small exports are not automatically pixel art.

Pricing is unchanged across sizes: frames 1–14 cost $0.14 each; additional frames $0.07 each. One credit is $0.17. Round the complete order upward once to a tenth of a credit. Check `sprite_pricing` in capabilities and approve the quote with `max_credits`. Credits are held during processing, settled after complete delivery and restored on failure/timeout. There is no customer cancellation. Keep the execution ID to resume status. Custom requests need the matching broad-animation server release; older servers reject them. New live generation quality, 100-frame duration and actual cost remain unverified.

```sh
dreamlayer sprite character.png --action walk --frames 12 --max-credits 9.9 --out walk.zip
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

`download` refuses to overwrite a file. Use `.zip` for sprite results. Generation errors
in JSON include the available execution ID and idempotency key for recovery. Treat them
as private identifiers. For file-based commands, rerunning uploads a new asset: the same
local file is not an identical API request. Prefer `status` and `download`, or the
[journaled API examples](https://docs.dreamlayer.io/agent-api/examples).

[API overview](https://docs.dreamlayer.io/agent-api) ·
[Limits](https://docs.dreamlayer.io/agent-api/limits) ·
[Automation](https://docs.dreamlayer.io/cli/automation) ·
[MCP tools](https://docs.dreamlayer.io/mcp/tools)
