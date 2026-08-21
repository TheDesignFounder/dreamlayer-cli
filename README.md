# dreamlayer

Generate and edit images from your terminal, over local files, with one API key.

```bash
npm install -g dreamlayer
export DREAMLAYER_API_KEY="dlr_live_your_key"

dreamlayer generate "A glass greenhouse at dusk" --out greenhouse.png
```

Get a key at [platform.dreamlayer.io](https://platform.dreamlayer.io). A new account
starts at zero credits, and each finished image costs one.

> **Not yet publishable.** This package sends an `operation` field that requires
> the gateway build adding it to `ExecuteRequest`. Against the currently deployed
> API every call returns `422 extra_forbidden`. Deploy that build first.

## Commands

```bash
dreamlayer generate <prompt> [--aspect 16:9] [--out file.png]
dreamlayer edit <image> <prompt> [--out file.png]
dreamlayer cutout <image> [--out file.png]      # background removal
dreamlayer upscale <image> [--out file.png]     # 2x
dreamlayer answer <conversation-id> <text>
dreamlayer status <execution-id>
dreamlayer capabilities                         # spends nothing
```

`cutout` and `upscale` name their operation rather than hoping a sentence is read the
way you meant, so they run a dedicated chain and never stop to ask a question.

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
| 4 | Request rejected, will fail identically until you change it |
| 5 | Temporary, worth retrying |
| 6 | It asked a question instead of producing an image |

```bash
for f in shots/*.png; do dreamlayer cutout "$f" --out "cut/$(basename "$f")" || break; done
```

**`--json`** gives machine-readable output on stdout, carrying job state, execution ids,
and the written path. It deliberately excludes your prompt, your images, and your key,
so it is safe to paste into a bug report.

## Retries are safe if you reuse the key

An idempotency key is generated per run. After an uncertain response, pass the same one
back and the original result replays instead of paying twice:

```bash
dreamlayer generate "a fox logo" --idempotency-key fox-001
```

## A question is not a failure

An ambiguous prompt exits 6 and prints the command to answer it. Naming an operation
avoids the round trip entirely.

## Requirements

Node.js 22.12 or later.

## License

MIT. See LICENSE and NOTICE.
