const experimentNames = {
  "icon-labels": "Unnamed Previous and Next buttons",
  headings: "Incorrect Examples heading relationship",
  "body-hidden": "Body hidden from assistive technology"
};
const enabledIssues = new Set(
  new URLSearchParams(location.search)
    .getAll("issue")
    .filter((issue) => Object.hasOwn(experimentNames, issue))
);
for (const checkbox of document.querySelectorAll('input[name="issue"]')) {
  checkbox.checked = enabledIssues.has(checkbox.value);
}
function changeHeading(element, tag) {
  const replacement = document.createElement(tag);
  for (const attribute of element.attributes)
    replacement.setAttribute(attribute.name, attribute.value);
  replacement.append(...element.childNodes);
  element.replaceWith(replacement);
}
if (enabledIssues.has("icon-labels")) {
  for (const id of ["previous-example", "next-example"])
    document.getElementById(id).removeAttribute("aria-label");
}
if (enabledIssues.has("headings")) {
  // Preserve the visual hierarchy while deliberately corrupting its semantic relationship.
  document.querySelectorAll("#examples h3").forEach((heading) => {
    heading.classList.add("experiment-child-heading");
    changeHeading(heading, "h4");
  });
  const heading = document.querySelector("#examples-title");
  heading.classList.add("experiment-peer-heading");
  changeHeading(heading, "h3");
}
if (enabledIssues.has("body-hidden")) document.body.setAttribute("aria-hidden", "true");
document.body.dataset.issues = [...enabledIssues].sort().join(",");
if (enabledIssues.size) {
  document.querySelector("#experiment-status").textContent =
    `Intentional issues active: ${[...enabledIssues].map((issue) => experimentNames[issue]).join("; ")}. Press Escape to reset.`;
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && enabledIssues.size) {
    event.preventDefault();
    location.assign(new URL("index.html#experiments", location.href).href);
  }
});
