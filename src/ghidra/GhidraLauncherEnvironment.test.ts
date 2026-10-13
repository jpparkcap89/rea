import { afterEach, expect, it, vi } from "vitest";

import * as output from "../process/ExecFileOutput.js";
import { GhidraHeadlessLauncher } from "./GhidraLauncher.js";
import { ghidraJavaLaunch } from "./GhidraJavaLaunch.js";
import { ghidraJavaEnvironment } from "./GhidraInstallation.js";

afterEach(() => vi.restoreAllMocks());

it("preserves selected Windows environment without using ComSpec to encode paths", () => {
  const environment = {
    Path: "C:\\selected\\tools",
    ComSpec: "C:\\selected\\cmd.exe",
    SystemRoot: "C:\\selected-windows",
  };
  const launcher = new GhidraHeadlessLauncher({
    environment,
    platform: "win32",
    analyzeHeadlessPath: "C:\\ghidra\\support\\analyzeHeadless.bat",
    bridgeScriptPath: "C:\\rea\\bridge.py",
  });
  environment.ComSpec = "C:\\changed\\cmd.exe";
  expect(launcher.options.environment.COMSPEC).toBe("C:\\selected\\cmd.exe");
  expect(ghidraJavaEnvironment("C:\\jdk", environment, "win32")).toMatchObject({
    PATH: "C:\\jdk\\bin;C:\\selected\\tools",
    COMSPEC: "C:\\changed\\cmd.exe",
    SYSTEMROOT: "C:\\selected-windows",
  });
});

it("passes Windows installation, JVM and analysis paths literally through LaunchSupport and direct Java argv", async () => {
  const execute = vi
    .spyOn(output, "execFileOutput")
    .mockResolvedValueOnce({
      stdout: "GHIDRA_MAXMEM=512m\n",
      stderr: "",
    })
    .mockResolvedValueOnce({
      stdout: "-Dfile.encoding=UTF8\n",
      stderr: "",
    });
  const root = "E:\\rea %PATH% & !NAME! 中文";
  const arguments_ = [
    "-scriptPath",
    `${root}\\bridge`,
    "-postScript",
    `${root}\\bridge\\ReaGhidraBridge.java`,
  ];
  const result = await ghidraJavaLaunch({
    platform: "win32",
    analyzeHeadlessPath: `${root}\\ghidra\\support\\analyzeHeadless.bat`,
    javaHome: `${root}\\jdk`,
    homeRoot: `${root}\\home`,
    configRoot: `${root}\\config`,
    cacheRoot: `${root}\\cache`,
    tempRoot: `${root}\\tmp`,
    arguments: arguments_,
    environment: {},
    onStderr: () => {},
  });
  expect(execute).toHaveBeenCalledTimes(2);
  for (const [command, args] of execute.mock.calls) {
    expect(command).toBe(`${root}\\jdk\\bin\\java.exe`);
    expect(args).toEqual(
      expect.arrayContaining([
        `-Duser.home=${root}\\home`,
        `-Djava.io.tmpdir=${root}\\tmp`,
        "-XX:-UsePerfData",
        `${root}\\ghidra\\support\\LaunchSupport.jar`,
        `${root}\\ghidra`,
      ]),
    );
  }
  expect(result.command).toBe(`${root}\\jdk\\bin\\java.exe`);
  expect(result.arguments.slice(-arguments_.length)).toEqual(arguments_);
  expect(result.arguments).toEqual(
    expect.arrayContaining([
      `-Duser.home=${root}\\home`,
      `-Djava.io.tmpdir=${root}\\tmp`,
      "-XX:-UsePerfData",
      "-Xmx512m",
    ]),
  );
});

it.each(["win32", "linux"] as const)(
  "keeps %s release-configured application directories inside the owned runtime",
  async (platform) => {
    vi.spyOn(output, "execFileOutput")
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        // LaunchSupport emits these properties from the selected installation.
        stdout: [
          "-Dapplication.settingsdir=/shared/settings",
          "-Dapplication.cachedir=/shared/cache",
          "-Dapplication.tempdir=/shared/tmp",
          "-Dfile.encoding=UTF8",
        ].join("\n"),
        stderr: "",
      });
    const root =
      platform === "win32" ? "E:\\private runtime" : "/private runtime";
    const separator = platform === "win32" ? "\\" : "/";
    const result = await ghidraJavaLaunch({
      platform,
      analyzeHeadlessPath: `${root}${separator}ghidra${separator}support${separator}analyzeHeadless`,
      javaHome: `${root}${separator}jdk`,
      homeRoot: `${root}${separator}home`,
      configRoot: `${root}${separator}config`,
      cacheRoot: `${root}${separator}cache`,
      tempRoot: `${root}${separator}tmp`,
      arguments: [],
      environment: {},
      onStderr: () => {},
    });
    const effective = Object.fromEntries(
      result.arguments
        .filter((argument) => argument.startsWith("-D"))
        .map((argument) => {
          const separator = argument.indexOf("=");
          return [argument.slice(2, separator), argument.slice(separator + 1)];
        }),
    );
    expect(effective).toMatchObject({
      "application.settingsdir": `${root}${separator}config`,
      "application.cachedir": `${root}${separator}cache`,
      "application.tempdir": `${root}${separator}tmp`,
      "file.encoding": "UTF8",
    });
  },
);
