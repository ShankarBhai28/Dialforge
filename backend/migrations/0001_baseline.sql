-- 0001 baseline: the whole DialForge structure as of 2026-10-13 (28 tables),
-- taken from the dev database with
--   mysqldump --no-data --skip-add-drop-table --compact
-- (AUTO_INCREMENT counters removed). Replaces backend/schema.sql and the
-- loose migration-*.sql files, kept for history in migrations/archive/.
-- A new install starts here; an existing database is marked as being at
-- this point once with:  npm run db:migrate -- --baseline
-- Tables are created alphabetically, so foreign keys to tables that come
-- later are only checked once everything exists.
SET FOREIGN_KEY_CHECKS = 0;

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `agent_status_log` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `status` varchar(30) NOT NULL,
  `reason` varchar(100) DEFAULT NULL,
  `started_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `ended_at` datetime DEFAULT NULL,
  `queue_id` int DEFAULT NULL,
  `extension_name` varchar(50) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_agent_status_user_time` (`user_id`,`started_at`),
  KEY `queue_id` (`queue_id`),
  CONSTRAINT `agent_status_log_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `agent_status_log_ibfk_2` FOREIGN KEY (`queue_id`) REFERENCES `queues` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `audit_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `user_id` int DEFAULT NULL,
  `username` varchar(50) DEFAULT NULL,
  `action` varchar(60) NOT NULL,
  `entity` varchar(30) DEFAULT NULL,
  `entity_id` varchar(40) DEFAULT NULL,
  `status` smallint DEFAULT NULL,
  `summary` varchar(255) DEFAULT NULL,
  `request_json` json DEFAULT NULL,
  `before_json` json DEFAULT NULL,
  `after_json` json DEFAULT NULL,
  `ip` varchar(45) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `audit_at` (`at`),
  KEY `audit_entity` (`entity`,`entity_id`),
  KEY `audit_user` (`user_id`,`at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `call_events` (
  `id` int NOT NULL AUTO_INCREMENT,
  `call_id` int NOT NULL,
  `event_type` varchar(50) NOT NULL,
  `payload` json DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_call_events_call` (`call_id`),
  CONSTRAINT `call_events_ibfk_1` FOREIGN KEY (`call_id`) REFERENCES `calls` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `callbacks` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL DEFAULT '1',
  `lead_id` int NOT NULL,
  `campaign_id` int DEFAULT NULL,
  `user_id` int DEFAULT NULL,
  `callback_at` datetime NOT NULL,
  `note` varchar(255) DEFAULT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'pending',
  `created_by` int NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_callbacks_due` (`status`,`callback_at`),
  KEY `lead_id` (`lead_id`),
  KEY `callbacks_ibfk_2` (`campaign_id`),
  KEY `callbacks_ibfk_3` (`user_id`),
  KEY `callbacks_ibfk_4` (`created_by`),
  CONSTRAINT `callbacks_ibfk_1` FOREIGN KEY (`lead_id`) REFERENCES `leads` (`id`),
  CONSTRAINT `callbacks_ibfk_2` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`id`),
  CONSTRAINT `callbacks_ibfk_3` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `callbacks_ibfk_4` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `calls` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL,
  `lead_id` int DEFAULT NULL,
  `extension_id` int DEFAULT NULL,
  `direction` varchar(20) NOT NULL DEFAULT 'outbound',
  `from_extension` varchar(50) DEFAULT NULL,
  `to_number` varchar(20) NOT NULL,
  `ari_channel_id` varchar(100) DEFAULT NULL,
  `disposition` varchar(30) DEFAULT NULL,
  `start_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `answer_time` datetime DEFAULT NULL,
  `end_time` datetime DEFAULT NULL,
  `campaign_id` int DEFAULT NULL,
  `auto_answer` tinyint(1) DEFAULT NULL,
  `channel_name` varchar(100) DEFAULT NULL,
  `dial_attempt_id` int DEFAULT NULL,
  `agent_channel` varchar(100) DEFAULT NULL,
  `transfer_ext` varchar(20) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `lead_id` (`lead_id`),
  KEY `extension_id` (`extension_id`),
  KEY `idx_calls_tenant` (`tenant_id`),
  KEY `campaign_id` (`campaign_id`),
  KEY `idx_calls_channel_name` (`channel_name`),
  CONSTRAINT `calls_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `calls_ibfk_2` FOREIGN KEY (`lead_id`) REFERENCES `leads` (`id`),
  CONSTRAINT `calls_ibfk_3` FOREIGN KEY (`extension_id`) REFERENCES `extensions` (`id`),
  CONSTRAINT `calls_ibfk_4` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `campaign_dispositions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `campaign_id` int NOT NULL,
  `code` varchar(30) NOT NULL,
  `label` varchar(60) NOT NULL,
  `is_final` tinyint(1) NOT NULL DEFAULT '0',
  `retry_after_min` int DEFAULT NULL,
  `marks_dnc` tinyint(1) NOT NULL DEFAULT '0',
  `is_callback` tinyint(1) NOT NULL DEFAULT '0',
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_campaign_code` (`campaign_id`,`code`),
  CONSTRAINT `campaign_dispositions_ibfk_1` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `campaign_recycle_rules` (
  `campaign_id` int NOT NULL,
  `result` varchar(20) NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `delay_min` int NOT NULL,
  `max_tries` int NOT NULL,
  PRIMARY KEY (`campaign_id`,`result`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `campaigns` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL DEFAULT '1',
  `name` varchar(100) NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'active',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `queue_id` int DEFAULT NULL,
  `outbound_caller_id` varchar(20) DEFAULT NULL,
  `auto_answer` tinyint(1) NOT NULL DEFAULT '0',
  `form_id` int DEFAULT NULL,
  `dial_mode` varchar(20) NOT NULL DEFAULT 'manual',
  `dial_ratio` decimal(4,2) NOT NULL DEFAULT '1.00',
  `max_dial_ratio` decimal(4,2) NOT NULL DEFAULT '2.50',
  `target_abandon_pct` decimal(4,2) NOT NULL DEFAULT '3.00',
  `ring_timeout_sec` int NOT NULL DEFAULT '30',
  `max_attempts` int NOT NULL DEFAULT '3',
  `max_channels` int NOT NULL DEFAULT '10',
  `amd_enabled` tinyint(1) NOT NULL DEFAULT '0',
  `preview_autodial_sec` int DEFAULT NULL,
  `wrapup_sec` int NOT NULL DEFAULT '10',
  `call_window_start` time NOT NULL DEFAULT '09:00:00',
  `call_window_end` time NOT NULL DEFAULT '21:00:00',
  `timezone` varchar(40) NOT NULL DEFAULT 'Asia/Kolkata',
  `dialer_state` varchar(20) NOT NULL DEFAULT 'stopped',
  `dialer_state_changed_at` datetime DEFAULT NULL,
  `dialer_state_changed_by` int DEFAULT NULL,
  `abandon_wait_sec` int NOT NULL DEFAULT '5',
  PRIMARY KEY (`id`),
  KEY `queue_id` (`queue_id`),
  KEY `campaigns_form_fk` (`form_id`),
  CONSTRAINT `campaigns_form_fk` FOREIGN KEY (`form_id`) REFERENCES `forms` (`id`),
  CONSTRAINT `campaigns_ibfk_1` FOREIGN KEY (`queue_id`) REFERENCES `queues` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `dial_attempts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL DEFAULT '1',
  `campaign_id` int NOT NULL,
  `lead_id` int NOT NULL,
  `call_id` int DEFAULT NULL,
  `phone` varchar(20) NOT NULL,
  `channel_id` varchar(100) DEFAULT NULL,
  `channel_name` varchar(100) DEFAULT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'dialing',
  `result` varchar(20) DEFAULT NULL,
  `hangup_cause` int DEFAULT NULL,
  `agent_user_id` int DEFAULT NULL,
  `ratio_at_dial` decimal(4,2) DEFAULT NULL,
  `started_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `answered_at` datetime DEFAULT NULL,
  `connected_at` datetime DEFAULT NULL,
  `ended_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_attempts_active` (`campaign_id`,`status`),
  KEY `idx_attempts_started` (`campaign_id`,`started_at`),
  KEY `lead_id` (`lead_id`),
  KEY `dial_attempts_ibfk_3` (`call_id`),
  KEY `dial_attempts_ibfk_4` (`agent_user_id`),
  KEY `idx_attempts_lead` (`lead_id`,`started_at`),
  CONSTRAINT `dial_attempts_ibfk_1` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`id`),
  CONSTRAINT `dial_attempts_ibfk_2` FOREIGN KEY (`lead_id`) REFERENCES `leads` (`id`),
  CONSTRAINT `dial_attempts_ibfk_3` FOREIGN KEY (`call_id`) REFERENCES `calls` (`id`),
  CONSTRAINT `dial_attempts_ibfk_4` FOREIGN KEY (`agent_user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `dial_hopper` (
  `id` int NOT NULL AUTO_INCREMENT,
  `campaign_id` int NOT NULL,
  `lead_id` int NOT NULL,
  `list_id` int DEFAULT NULL,
  `phone` varchar(20) NOT NULL,
  `is_callback` tinyint(1) NOT NULL DEFAULT '0',
  `list_priority` int NOT NULL DEFAULT '0',
  `lead_priority` int NOT NULL DEFAULT '0',
  `attempts` int NOT NULL DEFAULT '0',
  `reserved_user_id` int DEFAULT NULL,
  `status` varchar(10) NOT NULL DEFAULT 'ready',
  `locked_at` datetime DEFAULT NULL,
  `locked_by` varchar(40) DEFAULT NULL,
  `inserted_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_hopper_lead` (`lead_id`),
  KEY `idx_hopper_pick` (`campaign_id`,`status`),
  CONSTRAINT `dial_hopper_ibfk_1` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`id`) ON DELETE CASCADE,
  CONSTRAINT `dial_hopper_ibfk_2` FOREIGN KEY (`lead_id`) REFERENCES `leads` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `dialer_status` (
  `campaign_id` int NOT NULL,
  `hopper_ready` int NOT NULL DEFAULT '0',
  `hopper_locked` int NOT NULL DEFAULT '0',
  `idle_agents` int NOT NULL DEFAULT '0',
  `would_dial` int NOT NULL DEFAULT '0',
  `note` varchar(255) DEFAULT NULL,
  `last_tick_at` datetime NOT NULL,
  `in_flight` int NOT NULL DEFAULT '0',
  `active_calls` int NOT NULL DEFAULT '0',
  `current_ratio` decimal(4,2) DEFAULT NULL,
  `answer_rate` decimal(5,2) DEFAULT NULL,
  `abandon_pct` decimal(5,2) DEFAULT NULL,
  `ratio_adjust` decimal(4,2) DEFAULT NULL,
  `pacing_note` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`campaign_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `dids` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL DEFAULT '1',
  `number` varchar(20) NOT NULL,
  `campaign_id` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `number` (`number`),
  KEY `campaign_id` (`campaign_id`),
  CONSTRAINT `dids_ibfk_1` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `dnc_numbers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL DEFAULT '1',
  `phone` varchar(20) NOT NULL,
  `source` varchar(20) NOT NULL DEFAULT 'manual',
  `created_by` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_dnc_phone` (`tenant_id`,`phone`),
  KEY `dnc_numbers_ibfk_1` (`created_by`),
  CONSTRAINT `dnc_numbers_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `extensions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL,
  `name` varchar(50) NOT NULL,
  `label` varchar(100) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `sip_password` varchar(100) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `tenant_id` (`tenant_id`,`name`),
  CONSTRAINT `extensions_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `form_fields` (
  `id` int NOT NULL AUTO_INCREMENT,
  `form_id` int NOT NULL,
  `field_key` varchar(50) NOT NULL,
  `label` varchar(100) NOT NULL,
  `field_type` varchar(20) NOT NULL,
  `options` json DEFAULT NULL,
  `is_required` tinyint(1) NOT NULL DEFAULT '0',
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_form_field_key` (`form_id`,`field_key`),
  CONSTRAINT `form_fields_ibfk_1` FOREIGN KEY (`form_id`) REFERENCES `forms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `form_responses` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL DEFAULT '1',
  `form_id` int NOT NULL,
  `campaign_id` int DEFAULT NULL,
  `lead_id` int DEFAULT NULL,
  `call_id` int DEFAULT NULL,
  `user_id` int NOT NULL,
  `data` json NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `form_id` (`form_id`),
  KEY `lead_id` (`lead_id`),
  KEY `call_id` (`call_id`),
  KEY `form_responses_ibfk_2` (`campaign_id`),
  KEY `form_responses_ibfk_5` (`user_id`),
  CONSTRAINT `form_responses_ibfk_1` FOREIGN KEY (`form_id`) REFERENCES `forms` (`id`),
  CONSTRAINT `form_responses_ibfk_2` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`id`),
  CONSTRAINT `form_responses_ibfk_3` FOREIGN KEY (`lead_id`) REFERENCES `leads` (`id`),
  CONSTRAINT `form_responses_ibfk_4` FOREIGN KEY (`call_id`) REFERENCES `calls` (`id`),
  CONSTRAINT `form_responses_ibfk_5` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `forms` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL DEFAULT '1',
  `name` varchar(100) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'active',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_form_name` (`tenant_id`,`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `leads` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL,
  `phone` varchar(20) NOT NULL,
  `alt_phone` varchar(20) DEFAULT NULL,
  `name` varchar(100) DEFAULT NULL,
  `status` varchar(30) NOT NULL DEFAULT 'new',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `campaign_id` int DEFAULT NULL,
  `list_id` int DEFAULT NULL,
  `updated_by` int DEFAULT NULL,
  `attempts` int NOT NULL DEFAULT '0',
  `last_attempt_at` datetime DEFAULT NULL,
  `next_call_at` datetime DEFAULT NULL,
  `is_final` tinyint(1) NOT NULL DEFAULT '0',
  `priority` int NOT NULL DEFAULT '0',
  `custom_data` json DEFAULT NULL,
  `recycled_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_leads_tenant` (`tenant_id`),
  KEY `updated_by` (`updated_by`),
  KEY `leads_ibfk_4` (`list_id`),
  KEY `idx_leads_dialable` (`campaign_id`,`is_final`,`next_call_at`),
  CONSTRAINT `leads_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `leads_ibfk_2` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`id`),
  CONSTRAINT `leads_ibfk_3` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  CONSTRAINT `leads_ibfk_4` FOREIGN KEY (`list_id`) REFERENCES `lists` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `lists` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL DEFAULT '1',
  `campaign_id` int NOT NULL,
  `name` varchar(100) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `priority` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `campaign_id` (`campaign_id`),
  CONSTRAINT `lists_ibfk_1` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `queues` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL DEFAULT '1',
  `name` varchar(100) NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'active',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `ring_strategy` varchar(20) NOT NULL DEFAULT 'ringall',
  `wait_timeout` int NOT NULL DEFAULT '30',
  `announce` varchar(10) NOT NULL DEFAULT 'no',
  `retry` int NOT NULL DEFAULT '1',
  `timeout_restart` varchar(10) NOT NULL DEFAULT 'yes',
  `asterisk_name` varchar(50) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `recycle_log` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL DEFAULT '1',
  `list_id` int NOT NULL,
  `user_id` int DEFAULT NULL,
  `statuses` varchar(500) NOT NULL,
  `reset_attempts` tinyint(1) NOT NULL,
  `leads_recycled` int NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_recycle_list` (`list_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `roles` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL DEFAULT '1',
  `name` varchar(50) NOT NULL,
  `scope` varchar(10) NOT NULL DEFAULT 'all',
  `permissions` json NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_role_name` (`tenant_id`,`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sessions` (
  `sid` varchar(128) NOT NULL,
  `user_id` int DEFAULT NULL,
  `expires` datetime NOT NULL,
  `data` mediumtext NOT NULL,
  PRIMARY KEY (`sid`),
  KEY `sessions_user` (`user_id`),
  KEY `sessions_expires` (`expires`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `team_campaigns` (
  `team_id` int NOT NULL,
  `campaign_id` int NOT NULL,
  PRIMARY KEY (`team_id`,`campaign_id`),
  KEY `campaign_id` (`campaign_id`),
  CONSTRAINT `team_campaigns_ibfk_1` FOREIGN KEY (`team_id`) REFERENCES `teams` (`id`) ON DELETE CASCADE,
  CONSTRAINT `team_campaigns_ibfk_2` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `team_members` (
  `team_id` int NOT NULL,
  `user_id` int NOT NULL,
  PRIMARY KEY (`team_id`,`user_id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `team_members_ibfk_1` FOREIGN KEY (`team_id`) REFERENCES `teams` (`id`) ON DELETE CASCADE,
  CONSTRAINT `team_members_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `teams` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL DEFAULT '1',
  `name` varchar(100) NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'active',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_team_name` (`tenant_id`,`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `tenants` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL,
  `username` varchar(50) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `role` varchar(20) NOT NULL,
  `role_id` int DEFAULT NULL,
  `extension_id` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `status` varchar(20) NOT NULL DEFAULT 'active',
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`),
  KEY `tenant_id` (`tenant_id`),
  KEY `extension_id` (`extension_id`),
  KEY `users_role_fk` (`role_id`),
  CONSTRAINT `users_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `users_ibfk_2` FOREIGN KEY (`extension_id`) REFERENCES `extensions` (`id`),
  CONSTRAINT `users_role_fk` FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

SET FOREIGN_KEY_CHECKS = 1;

-- Every row carries tenant_id 1 (one client per install today).
INSERT INTO tenants (id, name) VALUES (1, 'DialForge');
