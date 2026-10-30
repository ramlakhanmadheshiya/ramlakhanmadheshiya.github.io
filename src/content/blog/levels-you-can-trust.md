---
title: 'How the levels in my games are verified'
description: 'How my Godot puzzle games use solvers and tests so that every level is solvable, fair and harder than the last.'
pubDate: 2026-10-24
tags: ['Games', 'Godot', 'Testing']
---

I've been building a small family of puzzle games under [Brainnova Studio](/BrainnovaStudio/games/): Single Shot, Mirrorlock, Snug Fit, Word Glow, Corral and Ringburst. Each has hundreds of levels, and I can't play them all before shipping. So the rule is simple: **a level isn't allowed to exist unless a program has proved it fair.**

## One answer, checked by a solver

In *Word Glow* every tile belongs to one word, and the level checker rejects any grid where a word could be spelled along a second path. *Snug Fit* builds each level from its answer, then a solver confirms there are at most three distinct solutions once the shape's own symmetry is accounted for.

Why care about uniqueness? A puzzle with accidental alternative answers feels broken: the hint points one way, the player finds another, and the game says they're wrong.

## Bots that play the level

*Corral* is an endless enclosure puzzle, but it also has 120 challenge levels. A level generator builds candidates from seeded layouts and piece sequences, a planning bot plays each one, and only candidates the bot can win are kept. The bot's winning moves are stored with the level and replayed in the tests, so a later change to the rules can't quietly break an old level. The bot's score also sets the star thresholds.

## Difficulty is a test, not a feeling

Every chapter follows the same curve: levels 1–5 easy, 6–10 easy to medium, 11–20 medium, 21–30 medium to hard, 31–39 hard, 40 extreme. `tests/levels_test.gd` in each game checks it. In spirit:

```gdscript
# every level is harder than the one before it,
# and every tier is harder on average than the tier before
for i in range(1, levels.size()):
    assert(difficulty(levels[i]) > difficulty(levels[i - 1]))
```

If I add a level or tweak the scorer and break the ramp, the test fails before a player ever feels the jolt.

## Deterministic by design

Ringburst builds each level from its world and level number, so it's identical every time. The same idea powers *Corral*'s daily board: it's built on the phone from the date, with no server, so everyone gets the same rocks, gems and 30 pieces in the same order.

## What this buys

- Confidence to ship hundreds of levels per game.
- Cheap changes: rules, scoring and art can move while the tests guard solvability.
- Honest stars: they come from a bot's par, not a guess.

The games run in the browser and on Android from one Godot 4 project each, built and published by GitHub Actions. They were made with Claude as an AI co-developer, which is noted in each repository's README.
