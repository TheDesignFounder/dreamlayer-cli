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

An idempotency key is generated per run. After an uncertain response, pass the same one
back and the original result replays instead of paying twice:

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

Eligible accounts can create walk, run, or idle sprite bundles. Check `sprite_sheet` in capabilities and the returned `sprite_sheet_credits` price before starting. A bundle includes twelve transparent frame PNGs, a 2048 by 1536 sheet, atlas, preview, and import instructions. Jobs may take several minutes. Keep the execution ID to resume status or cancel.

```sh
dreamlayer sprite character.png --action walk --max-credits 20 --out walk.zip
dreamlayer status EXECUTION_ID
dreamlayer cancel EXECUTION_ID
```

Set `--max-credits` to the amount you approve after checking the current price. The CLI reconnects to existing work if an event stream closes.
