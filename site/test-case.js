// The HTML is the fixed page. Each defect below breaks it in one way, and its key is the
// issue id in test-lab-contract.json. `?case=fixed` applies none of them.
const defects = {
  "unnamed-archive-button": () => {
    document.querySelector("#archive-project").removeAttribute("aria-label");
  },
  "unnamed-help-link": () => {
    document.querySelector("#help-link").removeAttribute("aria-label");
  },
  // The label text stays on screen but is no longer tied to the field.
  "unlabelled-search": () => {
    const label = document.querySelector('label[for="project-search"]');
    const text = document.createElement("span");
    text.textContent = label.textContent;
    label.replaceWith(text);
  },
  "chart-without-alt": () => {
    document.querySelector("#usage-chart").removeAttribute("alt");
  },
  "faint-hint-text": () => {
    document.querySelector("#usage-hint").classList.add("faint");
  },
  "empty-heading": () => {
    document.querySelector("#usage-heading").textContent = "";
  },
  "wrong-heading-level": () => {
    const previous = document.querySelector("#settings-heading");
    const heading = document.createElement("h3");
    heading.id = previous.id;
    heading.className = previous.className;
    heading.textContent = previous.textContent;
    previous.replaceWith(heading);
  },
  "click-only-export": () => {
    const previous = document.querySelector("#export-report");
    const lookalike = document.createElement("div");
    lookalike.id = previous.id;
    lookalike.className = "button-lookalike";
    lookalike.textContent = previous.textContent;
    previous.replaceWith(lookalike);
  },
  "hover-only-plan-details": () => {
    const previous = document.querySelector("#plan-details");
    const title = document.createElement("p");
    title.append(document.createElement("strong"));
    title.firstChild.textContent = previous.querySelector("summary").textContent;
    const details = document.createElement("p");
    details.className = "hover-only";
    details.textContent = previous.querySelector("p").textContent;
    const card = document.createElement("div");
    card.id = previous.id;
    card.className = "plan-card";
    card.append(title, details);
    previous.replaceWith(card);
  },
  // Checked by the archive handler below: focus is left on the hidden button.
  "focus-lost-after-archive": () => {},
  // Checked by the sync handler below: a failed sync shows and says nothing.
  "silent-sync-failure": () => {},
  // The messages still show, but in a plain paragraph a screen reader does not say.
  "silent-status-message": () => {
    document.querySelector("#action-status").removeAttribute("role");
  }
};

const fixed = new URLSearchParams(location.search).get("case") === "fixed";
const applied = new Set(fixed ? [] : Object.keys(defects));
applied.forEach((id) => defects[id]());
document.body.dataset.defects = [...applied].join(" ");

const caseName = fixed ? "Fixed" : "With deliberate accessibility issues";
document.querySelector("#case-name").textContent = caseName;
document.title = `${caseName} · Workspace overview · AEE demo page`;
const otherVersion = document.querySelector("#other-version");
otherVersion.href = fixed ? "test-case.html" : "test-case.html?case=fixed";
otherVersion.textContent = fixed ? "Open the page with issues" : "Open the fixed page";

const status = document.querySelector("#action-status");
const project = document.querySelector("#project-alpha");
const archive = document.querySelector("#archive-project");
const restore = document.querySelector("#restore-project");
archive.addEventListener("click", () => {
  project.hidden = true;
  restore.hidden = false;
  if (!applied.has("focus-lost-after-archive")) restore.focus();
  status.textContent = "Project Alpha archived. You can restore it.";
});
restore.addEventListener("click", () => {
  project.hidden = false;
  restore.hidden = true;
  archive.focus();
  status.textContent = "Project Alpha restored.";
});
document.querySelector("#export-report").addEventListener("click", () => {
  status.textContent = "Report exported.";
});
document.querySelector("#toggle-digest").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const enabled = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(enabled));
  document.querySelector("#digest-state").textContent = enabled ? "Enabled" : "Disabled";
  status.textContent = `Weekly digest ${enabled ? "enabled" : "disabled"}.`;
});
// The lab has no server, so a sync always fails, as a save does when the network drops.
document.querySelector("#sync-settings").addEventListener("click", async () => {
  const response = await fetch("api/sync-settings").catch(() => undefined);
  if (response?.ok || applied.has("silent-sync-failure")) return;
  status.textContent = "Settings could not be synced. Check your connection and try again.";
});
