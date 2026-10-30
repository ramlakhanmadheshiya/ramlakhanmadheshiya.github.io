---
title: 'Fixes to the delay-equation solver in OrdinaryDiffEq.jl'
description: 'What I learned from my first month of pull requests to OrdinaryDiffEq.jl: lags, constrained mode, composite algorithms and units.'
pubDate: 2026-10-27
tags: ['Julia', 'SciML', 'Open source']
---

Over the last few weeks I've sent a run of pull requests to [OrdinaryDiffEq.jl](https://github.com/SciML/OrdinaryDiffEq.jl), the Julia package behind many of SciML's differential equation solvers. Most of them touch one corner: the delay differential equation (DDE) path, `MethodOfSteps`. Two are merged, five are in review. This post is the map I wish I'd had on day one.

## What a delay equation changes

In an ODE the right-hand side depends on the current state. In a DDE it also depends on the state at an earlier time, like `u(t - τ)`. To evaluate that, the solver keeps a *history* and interpolates into it. `MethodOfSteps` reuses an ordinary ODE solver for each step and layers the history on top.

That layering is where the bugs live. Every ODE feature (composite algorithms, unit-carrying time, SDE caches) has to keep working when a history sits underneath it.

## The fixes, grouped

**Lags that are zero or have the wrong sign** ([#4849](https://github.com/SciML/OrdinaryDiffEq.jl/pull/4849), merged). A zero lag maps a discontinuity onto itself and would cap the maximum step size at zero, so both places that look at lags now skip it. The sign check is relative to the time direction, because a reversed `tspan` legitimately takes negative lags. Comparing against `zero(lag)` instead of `0` keeps Unitful lags working.

**Method order** ([#4834](https://github.com/SciML/OrdinaryDiffEq.jl/pull/4834), merged). `default_linear_interpolation(prob, alg)` had its methods defined algorithm-first, so solver-specific opt-outs stopped applying after a refactor. Flipping the argument order restored them. DAE algorithms stay on dense output because the adjoint machinery in SciMLSensitivity rejects a solution without it.

**Constrained mode needs a fixed-point solver** ([#4874](https://github.com/SciML/OrdinaryDiffEq.jl/pull/4874)). `constrained = true` limits the step only when the problem has *constant* lags. With dependent or undeclared lags, a step can still be longer than a lag, and the missing fixed-point solver surfaced as a `MethodError`. Now those steps fall back to fixed-point iteration. With only constant lags the solver is built but never called, so those solutions don't change.

**Composite algorithms** ([#4892](https://github.com/SciML/OrdinaryDiffEq.jl/pull/4892), [#4899](https://github.com/SciML/OrdinaryDiffEq.jl/pull/4899)). `MethodOfSteps` rebuilds the algorithm it wraps. For an `AutoSwitch` algorithm (and `DefaultODEAlgorithm`, which goes through the same rebuild) that rebuild silently dropped `constrained` and `fpsolve`. Separately, the history integrator's stiff sub-caches wrapped `prob.h` instead of the history function, so they had a different type from the solver's. The stiff ones now get their own instance; the Tsit5 and Vern7 ones stay shared, so non-stiff solves are untouched.

**`repeat_step`** ([#4879](https://github.com/SciML/OrdinaryDiffEq.jl/pull/4879)). Several SDE caches only define `perform_step!(integrator, cache)`, so passing `repeat_step` threw whenever the history was extrapolated. Every `perform_step!` that accepts `repeat_step` defaults it to `false`, so calling the two-argument form keeps the existing behaviour.

**Units** ([#4872](https://github.com/SciML/OrdinaryDiffEq.jl/pull/4872)). The discontinuity bracket holds a step *fraction*, not a time. Building it as `[zero(tType), one(tType)]` produced `[0.0 s, 1.0]` with Unitful time. Typing it as `typeof(one(tType))` fixes that and lets Measurements time run with discontinuity detection.

## What I took away

- **Read the issue as a spec.** Maintainers often describe two possible fixes. Checking each one against a failing case (the lag can shrink *during* a step, so clamping `dt` at the start isn't enough) is faster than defending an opinion.
- **Say what is still broken.** Some of my PRs depend on others or on open issues. Writing that in the description, with links, saves a reviewer from discovering it.
- **Keep the diff small.** Each of these adds fewer than 50 lines. Small changes are easier to review and easier to revert.

I also filed the issues behind these ([#4875](https://github.com/SciML/OrdinaryDiffEq.jl/issues/4875), [#4876](https://github.com/SciML/OrdinaryDiffEq.jl/issues/4876), [#4891](https://github.com/SciML/OrdinaryDiffEq.jl/issues/4891), [#4895](https://github.com/SciML/OrdinaryDiffEq.jl/issues/4895)). The full list, with current status, is on the [projects page](/projects/#open-source).
