const scenarios = {
  pass: {
    afterFocus: "button#cancel-delete",
    afterStatus: "Open",
    domChanged: "Yes",
    verdict: "Pass",
    summary: "Focus moved from the trigger into the opened dialog.",
    evidenceIds: ["focus:before", "focus:after"],
    finding: null
  },
  fail: {
    afterFocus: "button#delete-project",
    afterStatus: "Open",
    domChanged: "Yes",
    verdict: "Fail",
    summary: "The dialog opened, but focus remained on the trigger behind it.",
    evidenceIds: ["dom:before", "dom:after", "focus:before", "focus:after"],
    finding: {
      severity: "high",
      ruleId: "dialog-initial-focus",
      suggestedFix: "Move focus to an appropriate element inside the opened dialog."
    }
  }
};

const pageParameters = new URLSearchParams(window.location.search);

if (pageParameters.has("recording")) {
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
const deleteProject = document.querySelector("#delete-project");
const deleteDialog = document.querySelector("#delete-dialog");
const cancelDelete = document.querySelector("#cancel-delete");
const confirmDelete = document.querySelector("#confirm-delete");
const realFocus = document.querySelector("#real-focus");

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
      judgeId: "focus-management",
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

if (pageParameters.get("label") === "missing") {
  deleteProject.removeAttribute("aria-label");
}

function updateFocusStatus() {
  if (document.activeElement === cancelDelete) {
    realFocus.textContent = "Cancel inside dialog";
  } else if (document.activeElement === confirmDelete) {
    realFocus.textContent = "Delete project inside dialog";
  } else if (document.activeElement === deleteProject) {
    realFocus.textContent = deleteDialog.hidden ? "Delete button" : "Delete button behind dialog";
  } else {
    realFocus.textContent = document.activeElement?.tagName.toLowerCase() ?? "None";
  }
}

function closeDeleteDialog() {
  deleteDialog.hidden = true;
  deleteProject.focus();
  updateFocusStatus();
}

deleteProject.addEventListener("click", () => {
  deleteDialog.hidden = false;

  if (pageParameters.get("focus") !== "broken") {
    cancelDelete.focus();
  }

  updateFocusStatus();
});

cancelDelete.addEventListener("click", closeDeleteDialog);
confirmDelete.addEventListener("click", closeDeleteDialog);
document.addEventListener("focusin", updateFocusStatus);
