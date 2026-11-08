-- Character streaks are separate from the Words score combo. Old sessions stay unknown.
ALTER TABLE typing_sessions ADD COLUMN best_char_streak INTEGER CHECK (best_char_streak IS NULL OR best_char_streak >= 0);
ALTER TABLE typing_sessions ADD COLUMN current_char_streak INTEGER CHECK (current_char_streak IS NULL OR current_char_streak >= 0);
