# Guided Learning Loop Plan

## Why this is next

`Learning mode` exists today, but it is still mostly a prompt switch.

Current behavior:

- changes the instruction block in [src/main.ts](/Users/bytedance/Documents/Playground/obsidian-codex-workbench/src/main.ts)
- lets the user ask free-form follow-up questions
- supports study artifact generation after an answer is finished

What is still missing is the actual learning loop:

- the plugin does not establish the learner's goal or level
- answers are not consistently structured for teaching
- there is no guided next step after each answer
- users must type the same follow-up prompts manually

This is the highest-priority feature because it turns learning mode from "chat with a softer tone" into a real guided study workflow.

## Product goal

Make `learning mode` feel like a study coach inside the note instead of a general chat assistant.

Each learning turn should help the user:

- understand the current concept
- check whether they really got it
- choose the next best study action
- save useful learning output back into Obsidian

## Core experience

### 1. Learning session setup

When the user turns on `learning mode`, the workbench should initialize a lightweight learning profile for the current session:

- `Goal`: intro, deep understanding, or review
- `Level`: beginner, familiar, or advanced
- `Output preference`: explanation, quiz, or study note

This should be fast:

- use a compact popover or inline sheet the first time
- remember the choice per session
- allow quick edits from the top context rail

### 2. Structured learning replies

Every assistant reply in learning mode should default to a stable four-part structure:

- `Core idea`
- `Step by step`
- `Check yourself`
- `Next move`

This is not just presentation. The prompt should require the structure unless the user explicitly asks for a different format.

### 3. Guided quick actions

Every learning reply should expose one-tap follow-ups:

- `Simpler`
- `Example`
- `Compare`
- `Quiz me`
- `Turn into note`

These actions should send a structured follow-up prompt rather than forcing the user to type again.

### 4. Learning-aware artifact writing

The current study artifacts are a strong base.

This next feature should connect them more tightly to the learning loop:

- `Turn into note` should be a primary learning action, not hidden as a later export
- `Quiz me` can later feed `Anki cards`
- `Check yourself` responses can later feed `mistakes and confusion`

## UX changes

### Top rail

Add a compact learning chip group when `learning mode` is active:

- `Goal: Intro`
- `Level: Beginner`
- `Output: Explain`

Tapping a chip opens a small menu to change the value.

### Message cards

Learning replies should visually emphasize the four sections without making the UI heavy:

- section labels are small and muted
- body stays readable Markdown
- quick actions sit below the answer and above citations

### Composer

When `learning mode` is active, the composer hint should adapt:

- default hint: `Ask to explain, compare, quiz, or turn this into a study note...`

## Data model changes

Add a new per-session learning preferences object.

Suggested shape:

```ts
type LearningGoal = "intro" | "deep" | "review";
type LearningLevel = "beginner" | "familiar" | "advanced";
type LearningOutput = "explain" | "quiz" | "note";

interface LearningPreferences {
  goal: LearningGoal;
  level: LearningLevel;
  output: LearningOutput;
}
```

Plugin state additions:

- `learningPreferencesBySessionId`
- optional `lastLearningPreferences`

Chat turn additions:

- optional `learningLayout?: "guided" | "freeform"`
- optional `learningActions?: string[]`

## Prompting changes

Update the learning instruction block so it includes:

- the learner goal
- the learner level
- the preferred output style
- the required section structure

Example direction:

- if `goal = intro`, prefer plain language and fewer steps
- if `goal = review`, bias toward recall questions and misconceptions
- if `output = quiz`, keep explanation short and spend more space on the check phase

## Implementation plan

### Phase 1: Session preferences

Scope:

- add learning preference state
- add UI to set goal, level, and output
- include preferences in the learning prompt block

Files most likely touched:

- [src/types.ts](/Users/bytedance/Documents/Playground/obsidian-codex-workbench/src/types.ts)
- [src/main.ts](/Users/bytedance/Documents/Playground/obsidian-codex-workbench/src/main.ts)
- [src/chat-view.ts](/Users/bytedance/Documents/Playground/obsidian-codex-workbench/src/chat-view.ts)

Acceptance criteria:

- enabling learning mode always has a known goal, level, and output
- these values persist across app restart for the same restored session

### Phase 2: Guided reply layout

Scope:

- add learning-mode reply parsing and presentation
- render section labels consistently
- keep the raw Markdown copy behavior intact

Files most likely touched:

- [src/chat-view.ts](/Users/bytedance/Documents/Playground/obsidian-codex-workbench/src/chat-view.ts)
- [styles.css](/Users/bytedance/Documents/Playground/obsidian-codex-workbench/styles.css)

Acceptance criteria:

- learning replies default to the four-part layout
- regular mode replies remain unchanged

### Phase 3: Quick study actions

Scope:

- add `Simpler`, `Example`, `Compare`, `Quiz me`, and `Turn into note`
- map each button to a structured follow-up question
- keep actions available on restored replies when practical

Files most likely touched:

- [src/chat-view.ts](/Users/bytedance/Documents/Playground/obsidian-codex-workbench/src/chat-view.ts)
- [src/main.ts](/Users/bytedance/Documents/Playground/obsidian-codex-workbench/src/main.ts)

Acceptance criteria:

- a user can continue learning without typing
- quick actions preserve the current note context and citations

### Phase 4: Learning memory polish

Scope:

- remember common learning preferences across sessions
- allow one-click "reset learning setup"
- better default artifact type based on output preference

Acceptance criteria:

- the plugin feels personalized without becoming state-heavy

## Risks and guardrails

- Too much structure can make replies feel robotic.
  Keep a `freeform` fallback when the user clearly asks for a different format.

- Too many buttons can undo the recent UI simplification.
  Show learning actions only in learning mode and only on assistant replies.

- Parsing sectioned replies too aggressively can break Markdown rendering.
  Start with prompt-enforced headings instead of brittle post-processing.

## Non-goals for the first implementation

- spaced repetition scheduling
- quiz scoring analytics
- automatic mastery tracking
- cross-note study dashboards

These are good follow-ups, but they are not required for the first useful version.

## Suggested first build slice

If we want the fastest high-signal implementation, build this first:

1. session learning preferences
2. structured learning prompt
3. three quick actions: `Simpler`, `Example`, `Quiz me`

That slice is small enough to ship quickly and large enough to noticeably improve the learning experience.
