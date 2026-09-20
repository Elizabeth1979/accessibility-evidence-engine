const cases = {
  "body-hidden": "Body hidden",
  "icon-labels": "Unnamed icon buttons",
  headings: "Incorrect heading relationship",
  all: "All three failures",
  fixed: "Fixed baseline"
};
const requested = new URLSearchParams(location.search).get("case") ?? "fixed";
const activeCase = Object.hasOwn(cases, requested) ? requested : "fixed";
document.body.dataset.testCase = activeCase;
document.querySelector("#case-name").textContent = cases[activeCase];
document.title = `${cases[activeCase]} · AEE test fixture`;
if (activeCase === "body-hidden" || activeCase === "all") {
  document.body.setAttribute("aria-hidden", "true");
}
if (activeCase === "icon-labels" || activeCase === "all") {
  document.querySelectorAll("button[aria-label]").forEach((button) => {
    button.removeAttribute("aria-label");
  });
}
if (activeCase === "headings" || activeCase === "all") {
  const previous = document.querySelector("#settings-heading");
  const heading = document.createElement("h3");
  heading.id = previous.id;
  heading.className = previous.className;
  heading.textContent = previous.textContent;
  previous.replaceWith(heading);
}
const status = document.querySelector("#action-status");
const project = document.querySelector("#project-alpha");
const restore = document.querySelector("#restore-project");
document.querySelector("#archive-project").addEventListener("click", () => {
  project.hidden = true;
  restore.hidden = false;
  restore.focus();
  status.textContent = "Project Alpha archived. You can restore it.";
});
restore.addEventListener("click", () => {
  project.hidden = false;
  restore.hidden = true;
  document.querySelector("#archive-project").focus();
  status.textContent = "Project Alpha restored.";
});
document.querySelector("#toggle-digest").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const enabled = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(enabled));
  document.querySelector("#digest-state").textContent = enabled ? "Enabled" : "Disabled";
  status.textContent = `Weekly digest ${enabled ? "enabled" : "disabled"}.`;
});
