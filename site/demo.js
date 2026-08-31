const scenarios = {
  pass: {
    afterFocus: "button#save",
    afterStatus: "Saved",
    domChanged: "Yes",
    verdict: "Pass",
    summary: "Observed a DOM response after keyboard activation.",
    evidenceIds: ["dom:before", "dom:after"],
    finding: null
  },
  fail: {
    afterFocus: "button#save",
    afterStatus: "Idle",
    domChanged: "No",
    verdict: "Fail",
    summary: "No observable response followed the Enter interaction on button “Save”.",
    evidenceIds: ["dom:before", "dom:after", "focus:before", "focus:after"],
    finding: {
      severity: "high",
      ruleId: "interaction-response-observable",
      suggestedFix: "Ensure keyboard activation produces a visible, focus, or network response."
    }
  }
};

if (new URLSearchParams(window.location.search).has("recording")) {
  document.body.classList.add("recording");
}

const buttons = document.querySelectorAll("[data-scenario]");
const afterFocus = document.querySelector("#after-focus");
const afterStatus = document.querySelector("#after-status");
const domChanged = document.querySelector("#dom-changed");
const verdict = document.querySelector("#verdict");
const summary = document.querySelector("#summary");
const evidenceIds = document.querySelector("#evidence-ids");
const jsonOutput = document.querySelector("#json-output");
const realSave = document.querySelector("#real-save");
const realStatus = document.querySelector("#real-status");

function selectScenario(name) {
  const scenario = scenarios[name];

  for (const button of buttons) {
    button.setAttribute("aria-pressed", String(button.dataset.scenario === name));
  }

  afterFocus.textContent = scenario.afterFocus;
  afterStatus.textContent = scenario.afterStatus;
  domChanged.textContent = scenario.domChanged;
  verdict.textContent = scenario.verdict;
  verdict.className = `verdict ${scenario.verdict.toLowerCase()}`;
  summary.textContent = scenario.summary;
  evidenceIds.textContent = scenario.evidenceIds.join(", ");
  jsonOutput.textContent = JSON.stringify(
    {
      judgeId: "change-response",
      verdict: scenario.verdict.toLowerCase(),
      summary: scenario.summary,
      evidenceRecordIds: scenario.evidenceIds,
      ...(scenario.finding ? { findings: [scenario.finding] } : {})
    },
    null,
    2
  );
}

for (const button of buttons) {
  button.addEventListener("click", () => selectScenario(button.dataset.scenario));
}

selectScenario("pass");

realSave.addEventListener("click", () => {
  realStatus.textContent = "Saved";
  realSave.classList.add("saved");
});
