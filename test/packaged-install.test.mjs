import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

test("the packed CLI installs offline and its shipped binary starts", { timeout: 90_000 }, async (t) => {
  const owned = await mkdtemp(path.join(tmpdir(), "dreamlayer-cli-package-test-"));
  t.after(() => rm(owned, { recursive: true, force: true }));

  const packed = run("npm", ["pack", "--json", "--pack-destination", owned], ROOT);
  assert.equal(packed.status, 0, packed.stderr);
  const metadata = JSON.parse(packed.stdout)[0];
  assert.equal(metadata.name, "dreamlayer");
  assert.equal(metadata.version, "0.4.0-beta.2");
  assert.ok(metadata.integrity.startsWith("sha512-"));
  assert.deepEqual(
    metadata.files.map(({ path: file }) => file).sort(),
    [
      "LICENSE",
      "NOTICE",
      "README.md",
      "dist/cli.d.ts",
      "dist/cli.js",
      "dist/client.d.ts",
      "dist/client.js",
      "dist/render.d.ts",
      "dist/render.js",
      "package.json",
    ],
  );

  const [tarballName] = (await readdir(owned)).filter((name) => name.endsWith(".tgz"));
  assert.ok(tarballName, "npm pack did not create a tarball");
  const installRoot = path.join(owned, "installed");
  await mkdir(installRoot);
  const installed = run(
    "pnpm",
    ["add", "--offline", "--ignore-scripts", path.join(owned, tarballName)],
    installRoot,
  );
  assert.equal(installed.status, 0, installed.stderr);

  const packageJson = JSON.parse(
    await readFile(path.join(installRoot, "node_modules", "dreamlayer", "package.json"), "utf8"),
  );
  assert.equal(packageJson.version, "0.4.0-beta.2");
  assert.equal(packageJson.bin.dreamlayer, "./dist/cli.js");

  const env = { ...process.env, DREAMLAYER_API_KEY: "" };
  const launched = run(
    path.join(installRoot, "node_modules", ".bin", "dreamlayer"),
    ["--help"],
    installRoot,
    env,
  );
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /dreamlayer balance/);
  assert.match(launched.stdout, /--idempotency-key/);
  assert.doesNotMatch(launched.stdout + launched.stderr, /dlr_live_/);
});
