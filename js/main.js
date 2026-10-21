/* Start both sheets and drive them from one animation loop. */
(function (global) {
  "use strict";
  const VC = global.VC;

  function start() {
    const swarm = new VC.SwarmView();
    const mfg = new VC.MFGView();

    // only spend CPU on the live sheet while it is on screen
    if ("IntersectionObserver" in global) {
      new IntersectionObserver((entries) => {
        for (const e of entries) swarm.visible = e.isIntersecting;
      }, { threshold: 0.05 }).observe(document.getElementById("swarm-canvas"));
    }

    let last = performance.now();
    function loop(now) {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      swarm.frame(now);
      mfg.frame(now, dt);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
    // solve the equilibrium once the page has painted
    setTimeout(() => mfg.requestSolve(), 300);
    // redraw once web fonts arrive so canvas labels use them
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { swarm.draw(); mfg.draw(); });
    VC.views = { swarm, mfg };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(window);
