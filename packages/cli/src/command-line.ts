import { parseArgs } from "node:util";

import type { AcceptedFix, VerifiedFixOptions } from "./fix-command";
import { FAIL_ON_VALUES, type FailOn } from "./pr-comment";

/** One `--name` option of a command, as `util.parseArgs` reads it and the usage line shows it. */
type OptionSpec =
  | { readonly type: "boolean" }
  | {
      readonly type: "string";
      /** What the usage line shows for the value, such as `<dir>`; `choices` shows itself. */
      readonly value?: string;
      readonly choices?: readonly string[];
      readonly default?: string;
      readonly multiple?: true;
      readonly required?: true;
    };

/**
 * One command's arguments: the usage line is written from it and its arguments are read with it,
 * so the two cannot drift apart.
 */
interface CommandSpec<Options extends Readonly<Record<string, OptionSpec>>> {
  readonly name: string;
  /** In order; a last one ending in `...` takes one or more. */
  readonly positionals: readonly string[];
  readonly options: Options;
}

function command<const Options extends Readonly<Record<string, OptionSpec>>>(
  spec: CommandSpec<Options>
): CommandSpec<Options> {
  return spec;
}

export const COMMANDS = {
  plan: command({
    name: "plan",
    positionals: ["<scenario.yml>"],
    options: { json: { type: "boolean" } }
  }),
  run: command({
    name: "run",
    positionals: ["<scenario.yml>"],
    options: {
      open: { type: "boolean" },
      ci: { type: "boolean" },
      output: { type: "string", value: "<dir>" }
    }
  }),
  runConfig: command({ name: "run", positionals: ["<config.json>"], options: {} }),
  comment: command({
    name: "comment",
    positionals: ["<folder>..."],
    options: {
      "fail-on": { type: "string", choices: FAIL_ON_VALUES, default: "blocking" },
      post: { type: "boolean" },
      images: { type: "boolean" }
    }
  }),
  fix: command({
    name: "fix",
    positionals: ["<scenario.yml>", "<assessment-folder>"],
    options: {
      accept: { type: "string", value: '"<#id>[=<name>]"', multiple: true, required: true },
      source: { type: "string", value: "<file>", required: true },
      start: { type: "string", value: "<command>", required: true },
      output: { type: "string", value: "<dir>" }
    }
  })
};

/** `aee <command> <positionals> --required <value> [--optional]`, written from the command's spec. */
export function usage(spec: CommandSpec<Readonly<Record<string, OptionSpec>>>): string {
  const options = Object.entries(spec.options).map(([name, option]) => {
    const text =
      option.type === "boolean"
        ? `--${name}`
        : `--${name} ${option.choices?.join("|") ?? option.value ?? "<value>"}${option.multiple ? "..." : ""}`;
    return option.type === "string" && option.required ? text : `[${text}]`;
  });
  return ["aee", spec.name, ...spec.positionals, ...options].join(" ");
}

/** Every command's usage, for `aee` on its own. */
export const ALL_USAGE = Object.values(COMMANDS).map(usage).join(" | ");

type OptionValue<Option extends OptionSpec> = Option extends { type: "boolean" }
  ? boolean
  : Option extends { multiple: true }
    ? string[]
    : | (Option extends { choices: readonly (infer Choice extends string)[] } ? Choice : string)
      | (Option extends { required: true } | { default: string } ? never : undefined);

type OptionValues<Options extends Readonly<Record<string, OptionSpec>>> = {
  -readonly [Name in keyof Options]: OptionValue<Options[Name]>;
};

/** A command line `util.parseArgs` refused, such as an unknown option or a missing value. */
function isParseArgsError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS_")
  );
}

/**
 * Reads one command's arguments with `util.parseArgs` in strict mode, then checks what it leaves
 * to the caller: how many positionals, required options and allowed values. Every refusal names
 * the command and ends with its usage line.
 */
export function parseCommand<const Options extends Readonly<Record<string, OptionSpec>>>(
  spec: CommandSpec<Options>,
  args: readonly string[]
): { positionals: string[]; values: OptionValues<Options> } {
  const refuse = (problem: string, cause?: unknown): never => {
    throw new Error(`aee ${spec.name}: ${problem}\nUsage: ${usage(spec)}`, { cause });
  };
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...args],
      options: spec.options,
      strict: true,
      allowPositionals: true
    });
  } catch (error) {
    if (isParseArgsError(error)) return refuse(error.message, error);
    throw error;
  }

  const { positionals } = parsed;
  const variadic = spec.positionals.at(-1)?.endsWith("...") ?? false;
  if (positionals.length < spec.positionals.length) {
    refuse(`${spec.positionals[positionals.length]!.replace(/\.\.\.$/, "")} is missing.`);
  }
  if (!variadic && positionals.length > spec.positionals.length) {
    refuse(`Unexpected argument "${positionals[spec.positionals.length]}".`);
  }

  const values: Record<string, string | string[] | boolean | undefined> = {};
  for (const [name, option] of Object.entries(spec.options)) {
    const value = parsed.values[name];
    if (option.type === "boolean") {
      values[name] = value === true;
      continue;
    }
    if (option.required && (value === undefined || (Array.isArray(value) && !value.length))) {
      refuse(`--${name} is missing.`);
    }
    if (value === "" || (Array.isArray(value) && value.includes(""))) {
      refuse(`--${name} needs a value.`);
    }
    if (option.choices && typeof value === "string" && !option.choices.includes(value)) {
      refuse(`--${name} must be one of ${option.choices.join(", ")}.`);
    }
    values[name] = Array.isArray(value) ? value.map(String) : value;
  }
  // Each value was read and checked against its option's spec just above.
  return { positionals, values: values as OptionValues<Options> };
}

/** What `aee` was asked to do, with every argument read and checked. */
export type CommandLine =
  | { command: "plan"; scenarioPath: string; json: boolean }
  | { command: "run"; scenarioPath: string; open: boolean; ci: boolean; outputDir?: string }
  | { command: "run-config"; configPath: string }
  | {
      command: "comment";
      folders: string[];
      failOn: FailOn;
      post: boolean;
      images: boolean;
    }
  | ({ command: "fix" } & Omit<VerifiedFixOptions, "browser" | "aiProvider">);

/** `#id` or `#id=name`: the name may itself hold `=`. */
function acceptedFix(value: string): AcceptedFix {
  const [selector = "", ...name] = value.split("=");
  return name.length ? { selector, name: name.join("=") } : { selector };
}

/**
 * Reads `aee`'s command line. A path in place of a command runs it, as `aee run` does: a `.yml`
 * or `.yaml` scenario, or else a JSON fixture config, which takes no options.
 */
export function parseCommandLine(argv: readonly string[]): CommandLine {
  const [name, ...args] = argv;
  if (name === undefined || name.startsWith("-")) throw new Error(`Usage: ${ALL_USAGE}`);

  if (name === "plan") {
    const { positionals, values } = parseCommand(COMMANDS.plan, args);
    return { command: "plan", scenarioPath: positionals[0]!, json: values.json };
  }

  if (name === "comment") {
    const { positionals, values } = parseCommand(COMMANDS.comment, args);
    if (values.images && !values.post) {
      throw new Error(
        "--images needs --post: the pictures are uploaded to the repository the comment is posted on."
      );
    }
    return {
      command: "comment",
      folders: positionals,
      failOn: values["fail-on"],
      post: values.post,
      images: values.images
    };
  }

  if (name === "fix") {
    const { positionals, values } = parseCommand(COMMANDS.fix, args);
    return {
      command: "fix",
      scenarioPath: positionals[0]!,
      assessmentDir: positionals[1]!,
      accept: values.accept.map(acceptedFix),
      sourceFile: values.source,
      startCommand: values.start,
      ...(values.output === undefined ? {} : { outputDir: values.output })
    };
  }

  const runArgs = name === "run" ? args : argv;
  const { positionals, values } = parseCommand(COMMANDS.run, runArgs);
  const path = positionals[0]!;
  if (!/\.ya?ml$/i.test(path)) {
    parseCommand(COMMANDS.runConfig, runArgs);
    return { command: "run-config", configPath: path };
  }
  return {
    command: "run",
    scenarioPath: path,
    open: values.open,
    ci: values.ci,
    ...(values.output === undefined ? {} : { outputDir: values.output })
  };
}
