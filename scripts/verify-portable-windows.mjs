#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parse as parseToml } from "smol-toml";
import { verifyPortableInventory } from "./lib/portable-inventory.mjs";

const { values } = parseArgs({ options: { directory: { type: "string" } } });
if (process.platform !== "win32" || !values.directory)
  throw new Error("Use --directory <extracted portable directory> on Windows.");
const directory = resolve(values.directory);
const manifest = JSON.parse(
  await readFile(join(directory, "portable.json"), "utf8"),
);
await verifyPortableInventory(directory, manifest.files);
for (const file of manifest.files) {
  const path = resolve(directory, file.path);
  const within = relative(directory, path);
  if (isAbsolute(within) || within === ".." || within.startsWith("..\\"))
    throw new Error(
      `Inventory path is outside the portable directory: ${file.path}`,
    );
  const bytes = await readFile(path);
  assert.equal(bytes.length, file.size, file.path);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    file.sha256,
    file.path,
  );
}

const workspace = await mkdtemp(join(tmpdir(), "rea-portable-verification-"));
const execute = promisify(execFile);
const node = join(directory, "runtime/node.exe");
const entry = join(directory, "app/scripts/rea.mjs");
let complete = false;
try {
  const sample = join(workspace, "sample %REA_PORTABLE_PROBE% & !NAME! 中文");
  await mkdir(sample);
  const source = 'export function greet(name) { return "Hello " + name; }\n';
  await writeFile(join(sample, "app.js"), source, "utf8");
  const guard = join(workspace, "network-guard.cjs");
  await writeFile(
    guard,
    'require("node:net").Socket.prototype.connect = function () { throw new Error("Portable verification forbids Node network connections"); };\n',
    "utf8",
  );
  // This removes package managers and host Node from PATH. The preload rejects
  // Node socket connections; it is not an OS firewall for external executables.
  const environment = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATH: join(process.env.SystemRoot, "System32"),
    HOME: workspace,
    USERPROFILE: workspace,
    APPDATA: join(workspace, "Roaming"),
    LOCALAPPDATA: join(workspace, "Local"),
    TEMP: workspace,
    TMP: workspace,
    NODE_OPTIONS: `--require "${guard.replaceAll("\\", "/")}"`,
    npm_command: "exec",
    REA_PORTABLE_PROBE: "expanded-probe",
    NO_COLOR: "1",
  };
  // Keep %NAME% paths out of cmd text and exercise a caller with delayed expansion.
  const batchLauncher = async (args) =>
    execute(
      join(process.env.SystemRoot, "System32/cmd.exe"),
      [
        "/d",
        "/v:on",
        "/s",
        "/c",
        `""rea.cmd" ${args.map((arg) => `"${arg}"`).join(" ")}"`,
      ],
      {
        cwd: directory,
        env: environment,
        windowsHide: true,
        windowsVerbatimArguments: true,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  // Invoke the full script path through inbox Windows PowerShell (including 5.1).
  // The artifact is local test output; bypass policy only in this child process.
  const powershell = async (root, args) =>
    execute(
      join(
        process.env.SystemRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(root, "rea.ps1"),
        ...args,
      ],
      {
        cwd: workspace,
        env: environment,
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  const launcher = (args) => powershell(directory, args);
  // Use the shipped launcher unchanged with a controlled child to prove argv,
  // cleared npm context and exit-code forwarding independently of REA.
  const capture = join(workspace, "argv %REA_PORTABLE_PROBE% & !NAME! 中文");
  await mkdir(join(capture, "runtime"), { recursive: true });
  await mkdir(join(capture, "app/scripts"), { recursive: true });
  await copyFile(node, join(capture, "runtime/node.exe"));
  await copyFile(join(directory, "rea.ps1"), join(capture, "rea.ps1"));
  await writeFile(
    join(capture, "app/scripts/rea.mjs"),
    "process.stdout.write(JSON.stringify({args:process.argv.slice(2),npm:process.env.npm_command??null}));process.exitCode=17;\n",
    "utf8",
  );
  const capturedArgs = [
    'text with "quotes" & ^ %REA_PORTABLE_PROBE% !',
    "C:\\has spaces\\",
    "",
    "中文",
  ];
  await assert.rejects(powershell(capture, capturedArgs), (cause) => {
    assert.equal(cause.code, 17);
    assert.deepEqual(JSON.parse(cause.stdout), {
      args: capturedArgs,
      npm: null,
    });
    assert.equal(cause.stderr, "");
    return true;
  });
  assert.match(
    (await batchLauncher(["--help"])).stdout,
    /analyze-javascript-application/u,
  );
  assert.match(
    (await launcher(["--help"])).stdout,
    /analyze-javascript-application/u,
  );
  const planned = JSON.parse(
    (await launcher(["setup", "--client", "codex", "--dry-run", "--json"]))
      .stdout,
  );
  assert.equal(planned.status, "planned");
  const setupArgs = ["setup", "--client", "codex", "--yes", "--json"];
  const setup = JSON.parse((await launcher(setupArgs)).stdout);
  assert.equal(setup.status, "ready");
  const registration = parseToml(
    await readFile(join(workspace, ".codex/config.toml"), "utf8"),
  ).mcp_servers.rea;
  assert.equal(registration.command, node);
  assert.deepEqual(registration.args, [entry, "mcp"]);
  const doctor = JSON.parse(
    (await launcher(["doctor", "--client", "codex", "--skill", "--json"]))
      .stdout,
  );
  assert.equal(doctor.healthy, true);
  assert.equal(doctor.scope.mode, "explicit");
  assert.deepEqual(doctor.scope.clients, ["codex"]);
  assert.equal(doctor.scope.skill, true);
  assert.equal(doctor.identity.skill.state, "aligned");
  assert.equal(
    `v${doctor.checks.find(({ name }) => name === "node")?.details?.version}`,
    manifest.runtime.version,
  );
  assert.equal(
    doctor.identity.registrations.find(({ client }) => client === "codex")
      ?.state,
    "aligned",
  );
  const repeated = JSON.parse((await launcher(setupArgs)).stdout);
  assert.equal(repeated.status, "ready");
  assert.deepEqual(repeated.plannedActions, []);
  assert.deepEqual(repeated.appliedActions, []);
  const cli = JSON.parse(
    (await launcher(["analyze-javascript-application", sample, "--json"]))
      .stdout,
  );
  assert.equal(cli.operation, "analyze_javascript_application");
  const client = new Client({
    name: "rea-portable-verifier",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: node,
    args: [entry, "mcp"],
    env: environment,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(
      tools.tools.some(({ name }) => name === "analyze_javascript_application"),
    );
    const result = await client.callTool({
      name: "analyze_javascript_application",
      arguments: { input_path: sample },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const payload =
      result.structuredContent ??
      JSON.parse(result.content.find(({ type }) => type === "text").text);
    assert.equal(payload.operation, "analyze_javascript_application");
    assert.deepEqual(payload.normalized_result, cli.normalized_result);
    await client.ping();
  } finally {
    await client.close();
  }
  assert.equal(await readFile(join(sample, "app.js"), "utf8"), source);
  const uninstalled = JSON.parse(
    (await launcher(["uninstall", "--json"])).stdout,
  );
  assert.equal(uninstalled.status, "complete");
  for (const name of ["codex", "skill"])
    assert.equal(
      uninstalled.items.find((item) => item.name === name)?.status,
      "removed",
      `Portable uninstall must remove ${name}`,
    );
  const config = parseToml(
    await readFile(join(workspace, ".codex/config.toml"), "utf8"),
  );
  assert.equal(config.mcp_servers?.rea, undefined);
  await assert.rejects(
    readFile(
      join(workspace, ".agents/skills/reverse-engineer-anything/SKILL.md"),
    ),
    { code: "ENOENT" },
    "Portable uninstall must remove the installed skill manifest",
  );
  complete = true;
} finally {
  if (complete) await rm(workspace, { recursive: true, force: true });
  else
    console.error(
      `Verification did not complete; retained workspace: ${workspace}`,
    );
}
console.log(
  JSON.stringify({
    ok: true,
    directory,
    files: manifest.files.length,
    cli: true,
    mcp: true,
    offlineDoctor: true,
    nodeSocketConnections: "denied",
    externalProviders: "not exercised",
  }),
);
