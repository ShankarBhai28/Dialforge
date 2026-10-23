-- 0020: team hierarchy. A team may sit under another (TL team under a
-- manager's team under the head's team); an own-teams login then sees its
-- teams and every team below them. NULL = a top-level team (all existing ones).
-- Deleting a team moves its sub-teams up a level (the route does that); the
-- foreign key's SET NULL is only the safety net.
ALTER TABLE teams
  ADD COLUMN parent_id INT NULL AFTER name,
  ADD KEY teams_parent (parent_id),
  ADD CONSTRAINT teams_parent_fk FOREIGN KEY (parent_id) REFERENCES teams (id) ON DELETE SET NULL;
