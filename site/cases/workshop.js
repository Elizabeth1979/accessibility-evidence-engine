// Behaviour of the a11y-for-feds-intro workshop page, kept as the workshop shipped it:
// the menu opens on click only, and the theme toggle has no accessible name.
// `?case=body-visible` applies the workshop's first fix (the body is no longer hidden),
// which exposes the defects that aria-hidden on the body suppresses.
const requested = new URLSearchParams(location.search).get("case");
const activeCase = requested === "body-visible" ? "body-visible" : "as-shipped";
document.body.dataset.testCase = activeCase;
if (activeCase === "body-visible") document.body.removeAttribute("aria-hidden");

const root = document.documentElement;
const moonIcon = document.getElementById("moon-icon");
const sunIcon = document.getElementById("sun-icon");
function setTheme(isDark) {
  root.classList.toggle("dark-theme", isDark);
  root.classList.toggle("light-theme", !isDark);
  moonIcon.style.display = isDark ? "block" : "none";
  sunIcon.style.display = isDark ? "none" : "block";
}
setTheme(matchMedia("(prefers-color-scheme: dark)").matches);
document.getElementById("theme-toggle").addEventListener("click", () => {
  setTheme(!root.classList.contains("dark-theme"));
});

const menu = document.getElementById("menu");
document.getElementById("hamburger-btn").addEventListener("click", () => {
  menu.classList.add("active");
});
document.getElementById("close-btn").addEventListener("click", () => {
  menu.classList.remove("active");
});
