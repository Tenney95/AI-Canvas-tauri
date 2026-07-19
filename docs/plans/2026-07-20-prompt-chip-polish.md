# Prompt Chip Polish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refine canvas-node mention and Skill chips into a restrained, polished visual system without changing mention serialization or editor behavior.

**Architecture:** Keep the existing imperative DOM builders and `@{...}` / `@skill{...}` formats intact. Add semantic chip roles in `MentionEditor.tsx`, then centralize sizing, borders, inset highlights, type accents, and truncation in `prompt.css`.

**Tech Stack:** React 19, TypeScript, DOM APIs, CSS custom properties, Vite.

---

### Task 1: Refine chip semantics

**Files:**
- Modify: `src/components/nodes/shared/MentionEditor.tsx:205`

**Step 1: Preserve serialized behavior**

Keep all reference data attributes and serialization code unchanged.

**Step 2: Add presentational roles**

Mark canvas references with a dedicated class, expose the canvas reference marker as `@`, and render a compact Skill glyph plus a separately styled Skill name.

**Step 3: Run the focused linter**

Run: `npx eslint src/components/nodes/shared/MentionEditor.tsx`

Expected: no new lint errors, or only the repository's documented ESLint 10/parser compatibility failure.

### Task 2: Apply the restrained visual system

**Files:**
- Modify: `src/styles/prompt.css:47`

**Step 1: Refine the shared shell**

Use stable height, compact spacing, a 6px radius, subtle semantic borders, and an inset top highlight. Avoid layout movement on hover.

**Step 2: Separate node and Skill hierarchy**

Give node mentions semantic type accents and a clear tabular ID. Give Skill chips a neutral surface, amber accent glyph, readable proportional label, and safe truncation.

**Step 3: Verify themes and responsive layout**

Check dark and light themes, media thumbnails, long Skill names, multiline prompt wrapping, and a narrow viewport.

### Task 3: Verify the change

**Files:**
- Verify: `src/components/nodes/shared/MentionEditor.tsx`
- Verify: `src/styles/prompt.css`

**Step 1: Run static checks**

Run: `npm run typecheck`

Run: `git diff --check`

Expected: both commands pass.

**Step 2: Verify encoding**

Strictly decode both modified source files as UTF-8 and scan them for common mojibake markers.

**Step 3: Inspect in the running app**

Start Vite on an available local port and inspect the prompt editor at desktop and narrow viewport sizes.
