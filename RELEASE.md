# Agent readiness release

## Video candidate — not published

`0.5.0-beta.0` adds `video quote/execute/status/wait/download` and ordinary
video-prompt routing into the quote flow. Quotes do not spend; execution requires
an explicit ceiling and persisted idempotency key. A client wait timeout does not
cancel or replace the job.

Do not publish until the compatible backend is live and the exact tested tarball
has release approval. The backend `VIDEO_V1_RELEASE.md` lists paid qualification,
protected migration, cloud verification and rollback gates. README install pins
remain on the previously published version; this candidate is a local build only.

## Previous image/sprite release record

Prepared version: `0.4.0-beta.4`. Keep `latest` on `0.3.0` until a stable release is deliberately selected.

beta.4 adds `--background keep`: sprite frames that keep their generated background, priced at the flat
`sprite_pricing.plain_frame_cents` with no tier (5 credits for twelve frames instead of 9.9). It refuses the flag
against a server whose capabilities do not advertise that rate, and normalises a spelled-out `--background remove`
off the wire so it stays the same job as an omitted one.

1. Pass CI, review and merge the change.
2. With npm publisher authentication, run `pnpm test` and `npm publish --tag beta`.
3. Verify `npm view dreamlayer dist-tags`, install the package in a clean directory, and run `dreamlayer --version` and `dreamlayer download --help` without credentials.
4. Update pinned documentation examples only after the version exists on npm.

No paid generation is necessary to verify installation or help output.

The package defaults to `publishConfig.tag: beta`; still pass `--tag beta` explicitly. Verify the exact published artifact and retain `latest` at `0.3.0`. The beta.2 documentation remains compatible with beta.3.
