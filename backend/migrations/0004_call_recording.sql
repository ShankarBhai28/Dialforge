-- 0004: call recording.
-- campaigns.record_calls: record this campaign's calls (on by default).
-- calls.recording_path: the recording's final file (MP3, made from the
-- WAV right after the call by ops/recording-done.sh). NULL = not recorded.
ALTER TABLE campaigns ADD COLUMN record_calls TINYINT(1) NOT NULL DEFAULT 1;
ALTER TABLE calls ADD COLUMN recording_path VARCHAR(255) NULL;
