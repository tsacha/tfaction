import {
  buildInspectCommand,
  buildModuleToCallers,
  getInspector,
  getModuleCalls,
  supportsShowModule,
} from "./";
import type * as aqua from "../../../../aqua";
import { expect, describe, it, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
}));

describe("buildModuleToCallers", () => {
  // Input (moduleCalls):
  //   key: relative path from git_root_dir to module caller (working directory)
  //   value: relative paths from git_root_dir to modules (modules being called)
  // Output (ModuleToCallers):
  //   key: relative path from git_root_dir to module
  //   value: relative paths from git_root_dir to module callers

  it("creates a map from callee to its direct callers and transitive callers", () => {
    const actual = buildModuleToCallers({
      // These are working directories or modules that call other modules
      // All paths are relative from git_root_dir (already normalized)
      "modules/a": ["modules/b/v2", "modules/c", "d"],
      "modules/c": ["modules/e"],
      "modules/e": ["modules/f"],
      d: ["modules/g"],
      "modules/x": ["modules/b/v2", "modules/e"],
    });
    expect(actual).toEqual({
      // module : [callers...]
      "modules/b/v2": ["modules/a", "modules/x"],
      "modules/c": ["modules/a"],
      d: ["modules/a"],
      "modules/e": [
        "modules/c",
        "modules/a", // e <- c <- a
        "modules/x", // e <- x
      ],
      "modules/f": [
        "modules/e",
        "modules/c",
        "modules/a", // f <- e <- c <- a
        "modules/x", // f <- e <- x
      ],
      "modules/g": [
        "d",
        "modules/a", // g <- d <- a
      ],
    });
  });

  it("handles empty input", () => {
    const actual = buildModuleToCallers({});
    expect(actual).toEqual({});
  });

  it("handles single working directory calling a module", () => {
    // terraform/dev (working directory) calls modules/vpc (module)
    const actual = buildModuleToCallers({
      "terraform/dev": ["modules/vpc"],
    });
    expect(actual).toEqual({
      // modules/vpc is called by terraform/dev
      "modules/vpc": ["terraform/dev"],
    });
  });

  it("handles multiple working directories calling same module", () => {
    // Multiple working directories call the same module
    const actual = buildModuleToCallers({
      "terraform/dev": ["modules/vpc"],
      "terraform/prod": ["modules/vpc"],
      "terraform/staging": ["modules/vpc"],
    });
    expect(actual).toEqual({
      "modules/vpc": ["terraform/dev", "terraform/prod", "terraform/staging"],
    });
  });

  it("handles working directory with no module calls", () => {
    const actual = buildModuleToCallers({
      "terraform/dev": [],
    });
    expect(actual).toEqual({});
  });

  it("handles chain of module calls (module calling another module)", () => {
    // modules/app calls modules/shared, modules/shared calls modules/base
    // terraform/infra (working directory) calls modules/app
    const actual = buildModuleToCallers({
      "terraform/infra": ["modules/app"],
      "modules/app": ["modules/shared"],
      "modules/shared": ["modules/base"],
    });
    expect(actual).toEqual({
      "modules/app": ["terraform/infra"],
      "modules/shared": ["modules/app", "terraform/infra"],
      "modules/base": ["modules/shared", "modules/app", "terraform/infra"],
    });
  });

  it("handles diamond dependency pattern", () => {
    // terraform/app calls both modules/vpc and modules/iam
    // Both modules/vpc and modules/iam call modules/base
    // Note: duplicates are included when multiple paths lead to the same caller
    const actual = buildModuleToCallers({
      "terraform/app": ["modules/vpc", "modules/iam"],
      "modules/vpc": ["modules/base"],
      "modules/iam": ["modules/base"],
    });
    expect(actual).toEqual({
      "modules/vpc": ["terraform/app"],
      "modules/iam": ["terraform/app"],
      // modules/base is called by both vpc and iam, both of which are called by terraform/app
      "modules/base": [
        "modules/vpc",
        "terraform/app",
        "modules/iam",
        "terraform/app", // appears twice: via vpc and via iam
      ],
    });
  });

  it("handles working directory calling multiple modules", () => {
    // terraform/app (working directory) calls three modules
    const actual = buildModuleToCallers({
      "terraform/app": ["modules/vpc", "modules/iam", "modules/rds"],
    });
    expect(actual).toEqual({
      "modules/vpc": ["terraform/app"],
      "modules/iam": ["terraform/app"],
      "modules/rds": ["terraform/app"],
    });
  });

  it("handles module calling another module with working directory caller", () => {
    // terraform/app (working directory) calls modules/shared
    // modules/shared calls modules/base
    // terraform/infra (working directory) also calls modules/base directly
    const actual = buildModuleToCallers({
      "terraform/app": ["modules/shared"],
      "modules/shared": ["modules/base"],
      "terraform/infra": ["modules/base"],
    });
    expect(actual).toEqual({
      "modules/shared": ["terraform/app"],
      "modules/base": [
        "modules/shared",
        "terraform/app", // base <- shared <- app
        "terraform/infra",
      ],
    });
  });

  it("handles multiple working directories with different modules", () => {
    // Different working directories call different modules
    const actual = buildModuleToCallers({
      "terraform/aws/dev": ["modules/vpc"],
      "terraform/aws/prod": ["modules/vpc"],
      "terraform/gcp/dev": ["modules/network"],
    });
    expect(actual).toEqual({
      "modules/vpc": ["terraform/aws/dev", "terraform/aws/prod"],
      "modules/network": ["terraform/gcp/dev"],
    });
  });
});

describe("supportsShowModule", () => {
  it.each([
    ["1.10.7", false],
    ["1.11.0", true],
    ["1.11.0-beta1", true],
    ["1.12.6", true],
    ["2.0.0", true],
  ])("tofu %s => %s", (version, expected) => {
    expect(
      supportsShowModule(
        JSON.stringify({ terraform_version: version, platform: "linux_amd64" }),
      ),
    ).toBe(expected);
  });

  it("returns false if the output isn't JSON", () => {
    expect(supportsShowModule("OpenTofu v1.11.0")).toBe(false);
  });
});

describe("getInspector", () => {
  const createMockExecutor = (result: { exitCode: number; stdout: string }) =>
    ({
      getExecOutput: vi.fn().mockResolvedValue({ ...result, stderr: "" }),
    }) as unknown as aqua.Executor & {
      getExecOutput: ReturnType<typeof vi.fn>;
    };
  const version = (v: string) =>
    JSON.stringify({ terraform_version: v, platform: "linux_amd64" });

  it("uses terraform-config-inspect without running terraform", async () => {
    const executor = createMockExecutor({ exitCode: 0, stdout: "" });
    expect(await getInspector("/repo", "terraform", executor)).toEqual({
      command: "terraform-config-inspect",
      tofu: false,
    });
    expect(executor.getExecOutput).not.toHaveBeenCalled();
  });

  it.each(["tofu", "/usr/local/bin/tofu", "tofu.exe"])(
    "uses %s show -module with OpenTofu 1.11",
    async (command) => {
      const executor = createMockExecutor({
        exitCode: 0,
        stdout: version("1.11.0"),
      });
      expect(await getInspector("/repo", command, executor)).toEqual({
        command,
        tofu: true,
      });
      expect(executor.getExecOutput).toHaveBeenCalledWith(
        command,
        ["version", "-json"],
        expect.objectContaining({ cwd: "/repo", ignoreReturnCode: true }),
      );
    },
  );

  it("uses terraform-config-inspect with OpenTofu 1.10", async () => {
    const executor = createMockExecutor({
      exitCode: 0,
      stdout: version("1.10.7"),
    });
    expect(await getInspector("/repo", "tofu", executor)).toEqual({
      command: "terraform-config-inspect",
      tofu: false,
    });
  });

  it("uses terraform-config-inspect if tofu version fails", async () => {
    const executor = createMockExecutor({ exitCode: 1, stdout: "" });
    expect(await getInspector("/repo", "tofu", executor)).toEqual({
      command: "terraform-config-inspect",
      tofu: false,
    });
  });
});

describe("buildInspectCommand", () => {
  it("runs terraform-config-inspect in the working directory", () => {
    expect(
      buildInspectCommand(
        { command: "terraform-config-inspect", tofu: false },
        "/repo",
        "aws/foo",
      ),
    ).toEqual({ args: ["--json"], cwd: "/repo/aws/foo" });
  });

  it("runs tofu show -module in the git root directory", () => {
    expect(
      buildInspectCommand({ command: "tofu", tofu: true }, "/repo", "aws/foo"),
    ).toEqual({ args: ["show", "-module=aws/foo", "-json"], cwd: "/repo" });
  });
});

describe("getModuleCalls", () => {
  const tci = { command: "terraform-config-inspect", tofu: false };
  const tofu = { command: "tofu", tofu: true };
  it("reads module_calls of terraform-config-inspect", () => {
    expect(
      getModuleCalls(
        tci,
        JSON.stringify({ module_calls: { vpc: { source: "../modules/vpc" } } }),
      ),
    ).toEqual({ vpc: { source: "../modules/vpc" } });
  });

  it("reads root_module.module_calls of tofu show -module", () => {
    expect(
      getModuleCalls(
        tofu,
        JSON.stringify({
          format_version: "1.0",
          root_module: { module_calls: { vpc: { source: "../modules/vpc" } } },
        }),
      ),
    ).toEqual({ vpc: { source: "../modules/vpc" } });
  });

  it("returns no module call when tofu show omits module_calls", () => {
    expect(
      getModuleCalls(
        tofu,
        JSON.stringify({
          format_version: "1.0",
          root_module: { resources: [] },
        }),
      ),
    ).toEqual({});
  });
});
