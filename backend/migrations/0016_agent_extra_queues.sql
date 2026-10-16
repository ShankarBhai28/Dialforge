-- 0016: blended agents. Besides their main queue (= the campaign they work,
-- agent_status_log.queue_id), an agent can take calls from extra queues of
-- their teams for the shift. Cleared when they log out.
CREATE TABLE agent_extra_queues (
  user_id INT NOT NULL,
  queue_id INT NOT NULL,
  PRIMARY KEY (user_id, queue_id),
  KEY agent_extra_queues_queue (queue_id),
  CONSTRAINT agent_extra_queues_user_fk FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT agent_extra_queues_queue_fk FOREIGN KEY (queue_id) REFERENCES queues (id)
);
