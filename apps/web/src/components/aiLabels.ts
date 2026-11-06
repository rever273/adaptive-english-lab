/** Labels shared by the AI Tasks page and the floating AI panel (kept apart so the panel does not pull in the whole page). */
export const KIND_LABEL: Record<string, string> = {
  free_text_analysis: "Check a written answer",
  generation: "Write draft exercises",
  dictation: "Audio Dictation",
  expression: "Write an expression draft",
  triage: "Quick screen of a draft",
  benchmark: "Model benchmark",
  vocabulary_enrichment: "Translate a saved word",
  tutor: "Tutor answer",
};

export const GPU_WAIT: Record<string, string> = {
  practice_active: "a practice session is in progress",
  insufficient_vram: "not enough free graphics memory",
  ollama_in_use: "another program is using the language model server",
  profile_unknown: "the model has not been measured yet",
  telemetry_unavailable: "the graphics card cannot be read",
  release_unproven: "the previous model has not been shown to be unloaded",
  no_adapter: "nothing is installed to run this kind of task",
  oom_pressure: "the card ran out of memory",
};
