import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { RealReaderCommand, RealReaderRunDetail } from "@aee/schemas";

/**
 * How a real screen reader ran, read from where each value is recorded: the runner image's own
 * variables, Playwright's browser, Guidepup's reader and its settings. A value that cannot be read
 * is recorded as unknown, with why; it is never guessed or left blank.
 */

/** `value` from `source`, or unknown for `missing` when there is no value. */
export function detail(value: unknown, source: string, missing: string): RealReaderRunDetail {
  const text = value === undefined || value === null ? "" : String(value).trim();
  return text ? { value: text, source } : { unknown: missing };
}

const unknown = (reason: string): RealReaderRunDetail => ({ unknown: reason });

/**
 * The GitHub runner image, from the variables the image sets for every job: `ImageOS` and
 * `ImageVersion`. actions/runner-images sets both when it builds each image
 * (images/windows/scripts/build/Configure-SystemEnvironment.ps1 on Windows,
 * images/macos/scripts/build/configure-preimagedata.sh on macOS).
 */
export function runnerImage(env: NodeJS.ProcessEnv = process.env) {
  const notSet = (name: string) =>
    `${name} is not set: this is not one of GitHub's hosted runners, whose images set it`;
  return {
    osImage: detail(env.ImageOS, "the runner image's ImageOS variable", notSet("ImageOS")),
    osImageVersion: detail(
      env.ImageVersion,
      "the runner image's ImageVersion variable",
      notSet("ImageVersion")
    )
  };
}

/** The operating system's locale: ECMA-402's default locale, which Node takes from the system. */
export function osLocale(locale = Intl.DateTimeFormat().resolvedOptions().locale) {
  return detail(
    locale,
    "Node's default locale (Intl), from the operating system",
    "Node reports no default locale"
  );
}

/** What a command sent to the reader returns as text; `execFile` by default. */
export type RunCommand = (file: string, args: string[]) => Promise<string>;

const execFileText: RunCommand = async (file, args) =>
  (await promisify(execFile)(file, args, { encoding: "utf8" })).stdout;

const VOICEOVER_APP = "/System/Library/CoreServices/VoiceOver.app/Contents/Info.plist";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The version the reader itself reports, which is not always the one Guidepup names
 * (`readerBuild`): for VoiceOver, Guidepup's version is that of the settings it installs.
 * - NVDA: the product version of the running `nvda.exe`, as Windows reads it from the file's
 *   version resource (PowerShell's `Get-Process` gives it as `ProductVersion`).
 * - VoiceOver: its app bundle's version (`CFBundleShortVersionString`) and build
 *   (`CFBundleVersion`), read with macOS's `plutil`, as Guidepup reads VoiceOver's settings.
 */
export async function readerVersion(
  reader: string,
  run: RunCommand = execFileText
): Promise<RealReaderRunDetail> {
  try {
    if (reader === "NVDA") {
      const version = await run("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Process -Name nvda | Select-Object -First 1).ProductVersion"
      ]);
      return detail(
        version,
        "the product version of the running nvda.exe (Get-Process)",
        "the running nvda.exe reports no product version"
      );
    }
    if (reader === "VoiceOver") {
      const key = (name: string) => run("plutil", ["-extract", name, "raw", VOICEOVER_APP]);
      const [version, build] = (await Promise.all([
        key("CFBundleShortVersionString"),
        key("CFBundleVersion")
      ])) as [string, string];
      return detail(
        version.trim() && `${version.trim()} (build ${build.trim()})`,
        "VoiceOver's app bundle (CFBundleShortVersionString and CFBundleVersion)",
        "VoiceOver's app bundle reports no version"
      );
    }
  } catch (error) {
    return unknown(`${reader}'s version could not be read: ${message(error)}`);
  }
  return unknown(`AEE reads the version of NVDA and VoiceOver only, not of ${reader}`);
}

/** Guidepup's own name for the reader's version: the build it installed, from its manifest. */
export function readerBuild(version: string | undefined) {
  return detail(
    version,
    "Guidepup's screenReader.version, from its manifest of reader builds",
    "Guidepup names no version for this reader"
  );
}

/** The reader settings a result records. */
export interface ReaderSettings {
  language: RealReaderRunDetail;
  voice: RealReaderRunDetail;
  rate: RealReaderRunDetail;
  verbosity: RealReaderRunDetail;
  punctuation: RealReaderRunDetail;
}

/** The setting at `path` in nested settings, or undefined. */
function at(settings: unknown, path: string[]): unknown {
  return path.reduce<unknown>(
    (value, key) =>
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined,
    settings
  );
}

/**
 * NVDA's punctuation/symbol levels by the names its user guide gives them (characterProcessing's
 * `SymbolLevel` in NVDA's source).
 */
const NVDA_SYMBOL_LEVELS: Record<number, string> = {
  0: "none",
  100: "some",
  200: "most",
  300: "all",
  1000: "character"
};

/**
 * NVDA's settings, as Guidepup's `getSettings()` gives them: its nvda.ini, parsed. NVDA writes a
 * setting there only when it differs from NVDA's own default, so a setting that is not there is
 * NVDA's default for its version, which nvda.ini does not say.
 */
function nvdaSettings(settings: unknown): ReaderSettings {
  const ini = (path: string[]) => `NVDA's ${path.join(".")} setting (nvda.ini)`;
  const notSet = (path: string[]) =>
    `nvda.ini does not set ${path.join(".")}, so NVDA uses its own default, which nvda.ini does not record`;
  const setting = (path: string[], source = ini(path)) =>
    detail(at(settings, path), source, notSet(path));
  const synth = at(settings, ["speech", "synth"]);
  const synthPath = (key: string) => ["speech", String(synth), key];
  const noSynth = unknown(notSet(["speech", "synth"]));
  const rate = at(settings, synthPath("rate"));
  const rateBoost = at(settings, synthPath("rateBoost"));
  const symbolLevel = at(settings, ["speech", "symbolLevel"]);
  return {
    language: setting(
      ["general", "language"],
      `${ini(["general", "language"])}; "Windows" means NVDA follows Windows' language`
    ),
    voice: synth
      ? detail(
          at(settings, synthPath("voice")),
          `${ini(synthPath("voice"))}, for NVDA's ${String(synth)} synthesizer`,
          notSet(synthPath("voice"))
        )
      : noSynth,
    rate: synth
      ? detail(
          rate === undefined
            ? undefined
            : `${String(rate)}${rateBoost === true ? ", rate boost on" : ""}`,
          `${ini(synthPath("rate"))} and ${synthPath("rateBoost").join(".")}`,
          notSet(synthPath("rate"))
        )
      : noSynth,
    verbosity: setting(
      ["math", "speech", "verbosity"],
      `${ini(["math", "speech", "verbosity"])}: for maths only, as NVDA has no verbosity setting for other content`
    ),
    punctuation: detail(
      typeof symbolLevel === "number"
        ? `${NVDA_SYMBOL_LEVELS[symbolLevel] ?? "unnamed level"} (${symbolLevel})`
        : symbolLevel,
      `${ini(["speech", "symbolLevel"])}, NVDA's punctuation/symbol level`,
      notSet(["speech", "symbolLevel"])
    )
  };
}

/** The prefix of VoiceOver's settings for its default voice. */
const VOICEOVER_SPEECH =
  "SCRCategories_SCRCategorySystemWide_SCRSpeechLanguages_default_SCRSpeechComponentSettings_";

/**
 * VoiceOver's settings, as Guidepup's `getSettings()` gives them: the property list of the
 * VoiceOver settings Guidepup installs (guidepup/voiceover's VoiceOver4.portable/default.plist).
 */
function voiceOverSettings(settings: unknown): ReaderSettings {
  const setting = (key: string, format = (value: unknown) => value) => {
    const value = at(settings, [key]);
    return detail(
      value === undefined ? undefined : format(value),
      `VoiceOver's ${key} setting`,
      `Guidepup's VoiceOver settings do not set ${key}`
    );
  };
  return {
    language: unknown("Guidepup's VoiceOver settings hold no language setting"),
    voice: setting(`${VOICEOVER_SPEECH}SCRVoiceIdentifier`),
    rate: setting(`${VOICEOVER_SPEECH}SCRRateAsPercent`, (value) => `${String(value)}%`),
    verbosity: setting("SCRVerbosity_SCRVerbosityLevel"),
    punctuation: setting("SCRCategories_SCRCategorySystemWide_SCRPunctuationVerbosenessLevel")
  };
}

const READER_SETTINGS: Record<string, (settings: unknown) => ReaderSettings> = {
  NVDA: nvdaSettings,
  VoiceOver: voiceOverSettings
};

/**
 * The reader's language, voice, rate, verbosity and punctuation, from the settings Guidepup reads
 * (`screenReader.getSettings()`). Where Guidepup cannot read them, or AEE does not know where a
 * reader keeps them, each is unknown with why.
 */
export function readerSettings(reader: string, getSettings: () => unknown): ReaderSettings {
  const all = (reason: string): ReaderSettings => ({
    language: unknown(reason),
    voice: unknown(reason),
    rate: unknown(reason),
    verbosity: unknown(reason),
    punctuation: unknown(reason)
  });
  const read = READER_SETTINGS[reader];
  if (!read) return all(`AEE reads the settings of NVDA and VoiceOver only, not of ${reader}`);
  try {
    return read(getSettings());
  } catch (error) {
    return all(`Guidepup could not read ${reader}'s settings: ${message(error)}`);
  }
}

/**
 * Every Guidepup command sent to the reader, with how many times, in the order each was first
 * sent. A command counts when it is sent, whether or not the reader then answers.
 */
export class CommandLog {
  readonly #counts = new Map<string, number>();

  /** Counts `command` (its name and options), sent by someone else, such as Guidepup's fixture. */
  sent(command: string) {
    this.#counts.set(command, (this.#counts.get(command) ?? 0) + 1);
  }

  /** Counts `command` and sends it. */
  send<T>(command: string, send: () => Promise<T>): Promise<T> {
    this.sent(command);
    return send();
  }

  get commands(): RealReaderCommand[] {
    return [...this.#counts].map(([command, count]) => ({ command, count }));
  }
}

/** A command's name with its options, as JSON: `next({"capture":true})`. */
export const command = (name: string, options?: object) =>
  `${name}(${options ? JSON.stringify(options) : ""})`;
