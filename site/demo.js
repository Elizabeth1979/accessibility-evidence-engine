const slides = [...document.querySelectorAll("[data-slide]")];
const slideButtons = [...document.querySelectorAll("[data-slide-target]")];
const previousButton = document.querySelector("#previous-example");
const nextButton = document.querySelector("#next-example");
const status = document.querySelector("#slideshow-status");
const labels = ["Icon label", "Headings", "Modal focus"];
let activeIndex = 0;

function showSlide(index, { announce = true } = {}) {
  activeIndex = (index + slides.length) % slides.length;

  for (const [slideIndex, slide] of slides.entries()) {
    slide.hidden = slideIndex !== activeIndex;
  }

  for (const [buttonIndex, button] of slideButtons.entries()) {
    button.setAttribute("aria-pressed", String(buttonIndex === activeIndex));
  }

  const message = `Example ${activeIndex + 1} of ${slides.length}: ${labels[activeIndex]}`;
  status.textContent = announce ? message : "";
  if (!announce) requestAnimationFrame(() => (status.textContent = message));
}

for (const button of slideButtons) {
  button.addEventListener("click", () => showSlide(Number(button.dataset.slideTarget)));
}

previousButton.addEventListener("click", () => showSlide(activeIndex - 1));
nextButton.addEventListener("click", () => showSlide(activeIndex + 1));

document.querySelector(".example-slideshow").addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    showSlide(activeIndex + (event.key === "ArrowRight" ? 1 : -1), { announce: false });
    slideButtons[activeIndex].focus();
  }
});

showSlide(0);
