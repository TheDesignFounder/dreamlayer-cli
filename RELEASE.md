# Agent readiness release

Prepared version: `0.4.0-beta.3`. Keep `latest` on `0.3.0` until a stable release is deliberately selected.

1. Pass CI, review and merge the change.
2. With npm publisher authentication, run `pnpm test` and `npm publish --tag beta`.
3. Verify `npm view dreamlayer dist-tags`, install the package in a clean directory, and run `dreamlayer --version` and `dreamlayer download --help` without credentials.
4. Update pinned documentation examples only after the version exists on npm.

No paid generation is necessary to verify installation or help output.

The package defaults to `publishConfig.tag: beta`; still pass `--tag beta` explicitly. Verify the exact published artifact and retain `latest` at `0.3.0`. The beta.2 documentation remains compatible with beta.3.
