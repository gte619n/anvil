// Anvil marketing site — tiny progressive enhancements (no framework, no build step).

// Reveal-on-scroll: fade sections in as they enter the viewport.
(() => {
  const els = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    els.forEach((el) => el.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
  );
  els.forEach((el) => io.observe(el));
})();

// Mobile nav: the compact toggle jumps to the features list (the links are hidden < 940px).
(() => {
  const toggle = document.getElementById("navToggle");
  if (toggle) toggle.addEventListener("click", () => location.assign("#features"));
})();

// Subtle parallax lift on the hero visual (pointer only; respects reduced-motion).
(() => {
  const v = document.querySelector(".hero-visual");
  if (!v || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!matchMedia("(pointer: fine)").matches) return;
  const grid = document.querySelector(".hero-grid");
  grid.addEventListener("pointermove", (e) => {
    const r = grid.getBoundingClientRect();
    const dx = (e.clientX - r.left - r.width / 2) / r.width;
    const dy = (e.clientY - r.top - r.height / 2) / r.height;
    v.style.transform = `translate(${dx * 8}px, ${dy * 8}px)`;
  });
  grid.addEventListener("pointerleave", () => (v.style.transform = ""));
})();
