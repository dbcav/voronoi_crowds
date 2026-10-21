# Crowds on a Voronoi mesh

**Live site:** https://dbcav.github.io/voronoi_crowds/

![A crowd planning ahead (left) and a crowd that only reacts (right), from the same starting spots](assets/demo.gif)

Interactive mean field games that run entirely in the browser. A mean field game models a huge crowd in which every agent plans its own route while accounting for where everyone else will be. The page solves one live, turns the solution back into individual agents, and races them against agents who only react to the crowd in front of them.

By David Cavender, applied mathematics PhD candidate at UC San Diego (optimization, mean field games, multi-agent control). [LinkedIn](https://www.linkedin.com/in/david-cavender/) · [dcavende@ucsd.edu](mailto:dcavende@ucsd.edu)

## What I built

- **A Voronoi tessellation from scratch**, in plain JavaScript: about 20,000 cells in under 0.2 s, matching scipy to about 1e-15.
- **A structure-preserving mean field game solver.** The forward (Fokker–Planck) step is the exact transpose of the backward (Hamilton–Jacobi–Bellman) step. So mass is conserved, densities stay non-negative, and the average cost to go equals the cost actually paid to about nine digits. The equilibrium itself is found by fictitious play.
- **The equilibrium turned back into agents.** N agents follow the solved feedback policy and reproduce the equilibrium's cost term by term, including which door they choose. Myopic agents driven by an exact Voronoi pressure gradient pay about twice as much.
- **Checks for each claim:** `tests/check_gradient.js`, `tests/check_mfg.js` and `tests/check_duel.js` (run with Node).

The same ideas show up in machine learning: the transpose trick is the adjoint method behind backpropagation, fictitious play is a learning-in-games algorithm, and the agents-versus-density check is the population limit behind mean field multi-agent reinforcement learning. [How the game works](how-it-works.html) explains the model, every parameter and the solver in a few minutes.

---

## Details

A static, single-page site with two interactive sheets:

1. **A crowd that reacts.** A live simulation where every agent is a Voronoi seed. Each cell is capped by a personal-space disk, and agents follow the exact gradient of one crowding energy, E = Σ |Wᵢ| ρᵢ⁶ / 5 with ρᵢ = a₀ / |Wᵢ|. You can switch that pressure on or off, add plain contact repulsion, change the room, and drag the start and target regions.
2. **A crowd that plans ahead.** One pipeline from the game to agents, run again whenever you change something:
   1. *Solve the game* on a fixed Voronoi mesh: a monotone upwind Hamiltonian on the cell graph, an implicit HJB step, a Fokker–Planck step that uses the transpose of the HJB matrix, and fictitious play. The crowd-blind game (κ = 0) is solved too.
   2. *Draw N agents* from the solved starting density m₀.
   3. *Run three crowds* from those same N spots: planners following the crowd-aware equilibrium, planners following the crowd-blind one, and reacting agents that walk down the terminal cost with Voronoi pressure (a zero-horizon plan). Every step is recorded, so one scrubber drives the equilibrium density and all the agents.

   Every agent is billed with the game's cost, ∫(|v|²/2 + κ m̂) dt + urgency × distance left, with the real κ for every crowd. Planners reproduce the equilibrium term by term, including which door they use. Crowd-blind planners pay for the crowding they cause, and reacting agents pay about twice as much.

   The results table is written from whatever game was just played. A sentence above it spells out the settings. The table fills in live while step 3 runs (costs so far), and the equilibrium column appears as soon as step 1 is solved. Every finished run is added to a "Your runs" log with what changed since the previous run, so slider changes can be compared side by side.

There is no backend and no external dependencies. Everything is plain JavaScript in classic `<script>` tags, so it also runs from `file://`. The math is TeX typeset by a bundled copy of KaTeX 0.16.47 (MIT, in `vendor/katex`). The only external request is Google Fonts, and the page falls back to system fonts without it.

## Modelling notes

- The pressure force is the exact gradient of the disk-capped energy (see `tests/check_gradient.js`). Faces shared with walls are held rigid, so near walls it is the gradient with the wall treated as fixed.
- Stiff pressure is stepped with a diagonal backward-Euler factor 1/(1 + dt·stiffness). This keeps the same resting states and stays stable. Its visible side effect is that agents in a tight crowd move more slowly.
- Voronoi pressure is a crowd-level force. It does very little for two agents bumping into each other in an empty room, and contact repulsion handles that case. The comparison chart on sheet 1 shows the difference.
- The MFG terminal cost is urgency × graph-geodesic distance to the target zone (Dijkstra on the cell graph, zero inside the zone), and the running congestion cost is κ·m.
- Steps 2–3, planning agents: drift v_i = Σ_j S_ij (u_i − u_j)⁺ n_ij / |V_i| (≈ −∇u), blended across neighbouring cells. Noise has the covariance of the scheme's own jump process, Σ_j rate_ij d_ij² n_ij n_ij^T. That covariance includes ν plus the upwind scheme's numerical diffusion (~h|v|, much larger than ν here). Without it (the "spread" toggle), the total cost still lands near the equilibrium, but the split shifts: more crowding, less distance left. The discrete equilibrium really is that smeared.
- Steps 2–3, scoring: crowding is the crowd's own density on the MFG mesh, pooled over each cell and its neighbours, with the agent itself left out (unbiased). Scoring each agent's own Voronoi cell instead overstates density for randomly scattered agents by roughly 40% (E[1/area] > 1/E[area]), which would unfairly penalize the noisier planning crowd.
- Steps 2–3, bodies: radius is chosen so the densest part of m₀ sits at comfort density, (1.8 r)² π = 1/(N max m₀). With ν > 0 every crowd jostles at the step scale, so touching counts are partly Brownian; set randomness to 0 for a cleaner contact comparison.
