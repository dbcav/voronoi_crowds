/* Typeset TeX on the page with the bundled KaTeX: $$...$$ for display, \( ... \) inline. */
(function () {
  "use strict";
  function typeset() {
    if (!window.renderMathInElement) return; // KaTeX missing: the raw TeX stays readable
    renderMathInElement(document.body, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\(", right: "\\)", display: false },
      ],
      ignoredClasses: ["no-math"],
      throwOnError: false,
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", typeset);
  else typeset();
})();
