import type { ReporterArtifact, ReporterInput, ReporterPlugin } from "@aee/core";
import { CURRENT_SCHEMA_VERSION } from "@aee/schemas";

export function createJsonReporter(): ReporterPlugin {
  return {
    manifest: {
      id: "json",
      displayName: "JSON Reporter",
      version: "0.1.0",
      kind: "reporter",
      capabilities: ["json"]
    },
    async render(input: ReporterInput): Promise<ReporterArtifact[]> {
      return [
        {
          label: "aee-report.json",
          mimeType: "application/json",
          content: JSON.stringify(
            {
              schemaVersion: CURRENT_SCHEMA_VERSION,
              run: input.run,
              bundles: input.bundles,
              records: input.records,
              judgments: input.judgments,
              findings: input.findings,
              artifacts: input.artifacts
            },
            null,
            2
          )
        }
      ];
    }
  };
}

export function createMarkdownReporter(): ReporterPlugin {
  return {
    manifest: {
      id: "markdown",
      displayName: "Markdown Reporter",
      version: "0.1.0",
      kind: "reporter",
      capabilities: ["markdown"]
    },
    async render(input: ReporterInput): Promise<ReporterArtifact[]> {
      const totalBundles = input.bundles.length;
      const lines = [
        `# AEE Report`,
        ``,
        `Run: \`${input.run.id}\``,
        `Status: \`${input.run.status}\``,
        `Bundles: ${totalBundles}`,
        ``,
        `## Judgments`,
        ...input.judgments.map((judgment) => `- [${judgment.verdict}] ${judgment.summary}`)
      ];

      return [
        {
          label: "aee-report.md",
          mimeType: "text/markdown",
          content: lines.join("\n")
        }
      ];
    }
  };
}
