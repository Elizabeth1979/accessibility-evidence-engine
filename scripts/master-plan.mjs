// Reads docs/MASTER-PLAN.md into milestones and their steps, for every page generated from it.
export function parsePlan(markdown) {
  const result = [];
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^### (M\d+) — (.+?)(?: \((.+)\))?$/);
    if (heading) {
      result.push({
        id: heading[1],
        title: heading[2],
        when: heading[3] ?? "",
        outcome: "",
        steps: []
      });
      continue;
    }
    const outcome = line.match(/^\*\*Outcome:\*\* (.+)$/);
    if (outcome && result.length > 0) {
      result.at(-1).outcome = outcome[1];
      continue;
    }
    const step = line.match(/^- \[( |x)\] \*\*(\d+\.\d+)\*\* (.+)$/);
    if (step && result.length > 0) {
      const [text, doneWhen = ""] = step[3].split(" _Done when:_ ");
      result.at(-1).steps.push({ id: step[2], done: step[1] === "x", text, doneWhen });
    }
  }
  return result;
}
