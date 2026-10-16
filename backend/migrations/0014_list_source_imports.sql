-- 0014: where a list's leads came from (a note, e.g. "Vendor X, Oct batch,
-- Rs 2/lead") and every upload into it (who, which file, what happened).
ALTER TABLE lists ADD COLUMN source VARCHAR(200) NULL;

CREATE TABLE list_imports (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  list_id INT NOT NULL,
  user_id INT NULL,
  file_name VARCHAR(200) NULL,
  total INT NOT NULL DEFAULT 0,
  imported INT NOT NULL DEFAULT 0,
  updated INT NOT NULL DEFAULT 0,
  skipped INT NOT NULL DEFAULT 0,
  duplicate_check VARCHAR(20) NULL,
  on_duplicate VARCHAR(10) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY list_imports_list (list_id, id),
  CONSTRAINT list_imports_list_fk FOREIGN KEY (list_id) REFERENCES lists (id),
  CONSTRAINT list_imports_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
);
