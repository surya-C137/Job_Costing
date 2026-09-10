CREATE TABLE `assembly_standards` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`source_key` text,
	`section` text,
	`action` text NOT NULL,
	`standard_seconds` real NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assembly_standards_shop_idx` ON `assembly_standards` (`shop_id`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`quote_id` text,
	`part_id` text,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_path` text NOT NULL,
	`uploaded_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`quote_id`) REFERENCES `quotes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attachments_quote_idx` ON `attachments` (`quote_id`);--> statement-breakpoint
CREATE INDEX `attachments_part_idx` ON `attachments` (`part_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`entity_table` text,
	`entity_id` text,
	`summary` text,
	`before` text,
	`after` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_log_shop_created_idx` ON `audit_log` (`shop_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity_table`,`entity_id`);--> statement-breakpoint
CREATE TABLE `coating_models` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`source_key` text,
	`name` text NOT NULL,
	`minimum_charge_usd` real DEFAULT 0 NOT NULL,
	`legacy_rate_usd` real,
	`legacy_coverage` real,
	`legacy_s_constant` real,
	`modern_specific_gravity` real,
	`modern_film_thickness_mils` real,
	`modern_transfer_efficiency` real,
	`modern_powder_price_per_lb_usd` real,
	`modern_rack_labor_usd_per_part` real,
	`modern_masking_usd_per_feature` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coating_models_shop_name_idx` ON `coating_models` (`shop_id`,`name`);--> statement-breakpoint
CREATE TABLE `config_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`hash` text NOT NULL,
	`schema_version` integer NOT NULL,
	`config` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `config_snapshots_shop_hash_idx` ON `config_snapshots` (`shop_id`,`hash`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`name` text NOT NULL,
	`contact_name` text,
	`email` text,
	`phone` text,
	`terms` text,
	`markup_override` real,
	`rohs_required` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_shop_name_idx` ON `customers` (`shop_id`,`name`);--> statement-breakpoint
CREATE TABLE `gauge_reference` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`source_key` text,
	`family_id` text NOT NULL,
	`label` text NOT NULL,
	`thickness_in` real NOT NULL,
	`lb_per_sq_ft_override` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`family_id`) REFERENCES `material_families`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gauge_reference_shop_family_label_idx` ON `gauge_reference` (`shop_id`,`family_id`,`label`);--> statement-breakpoint
CREATE TABLE `intake_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text,
	`target_field` text,
	`alias` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intake_aliases_shop_kind_alias_idx` ON `intake_aliases` (`shop_id`,`kind`,`alias`);--> statement-breakpoint
CREATE INDEX `intake_aliases_target_idx` ON `intake_aliases` (`target_id`);--> statement-breakpoint
CREATE TABLE `machine_material_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`material_id` text NOT NULL,
	`cut_speed_in_per_min` real DEFAULT 0 NOT NULL,
	`pierce_seconds` real DEFAULT 0 NOT NULL,
	`punch_rate_factor` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_material_rates_pair_idx` ON `machine_material_rates` (`machine_id`,`material_id`);--> statement-breakpoint
CREATE TABLE `machines` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`source_key` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`time_model` text NOT NULL,
	`rate_per_hr_usd` real DEFAULT 0 NOT NULL,
	`setup_hrs_default` real DEFAULT 0 NOT NULL,
	`consumables_per_hr_usd` real DEFAULT 0 NOT NULL,
	`max_sheet_length_in` real,
	`max_sheet_width_in` real,
	`clamp_strip_in` real DEFAULT 0 NOT NULL,
	`kerf_in` real DEFAULT 0 NOT NULL,
	`pallet_change_sec` real DEFAULT 0 NOT NULL,
	`pallet_batch_parts` real DEFAULT 100 NOT NULL,
	`intersection_sec` real DEFAULT 0 NOT NULL,
	`rapid_sec_per_pierce` real DEFAULT 0 NOT NULL,
	`loss_factor` real DEFAULT 1 NOT NULL,
	`load_unload_sec_per_blank` real DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machines_shop_name_idx` ON `machines` (`shop_id`,`name`);--> statement-breakpoint
CREATE TABLE `material_families` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`source_key` text,
	`name` text NOT NULL,
	`density_lb_per_cu_in` real,
	`default_scrap_price_per_lb_usd` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `material_families_shop_name_idx` ON `material_families` (`shop_id`,`name`);--> statement-breakpoint
CREATE TABLE `material_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`material_id` text NOT NULL,
	`price_per_lb_usd` real NOT NULL,
	`sheet_cost_usd` real,
	`sheet_lbs` real,
	`effective_from` integer NOT NULL,
	`entered_by_user_id` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entered_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `material_prices_material_effective_idx` ON `material_prices` (`material_id`,`effective_from`);--> statement-breakpoint
CREATE TABLE `materials` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`source_key` text,
	`name` text NOT NULL,
	`family_id` text NOT NULL,
	`form` text DEFAULT 'sheet' NOT NULL,
	`thickness_in` real,
	`lb_per_sq_ft` real NOT NULL,
	`surcharge_pct` real DEFAULT 0 NOT NULL,
	`scrap_price_per_lb_usd` real DEFAULT 0 NOT NULL,
	`standard_length_in` real,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`family_id`) REFERENCES `material_families`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `materials_shop_name_idx` ON `materials` (`shop_id`,`name`);--> statement-breakpoint
CREATE INDEX `materials_family_idx` ON `materials` (`family_id`);--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`source_key` text,
	`name` text NOT NULL,
	`machine_id` text,
	`kind` text NOT NULL,
	`setup_hrs` real DEFAULT 0 NOT NULL,
	`standard_per_hr` real,
	`standard_unit` text,
	`rate_per_hr_usd` real,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `operations_shop_name_idx` ON `operations` (`shop_id`,`name`);--> statement-breakpoint
CREATE TABLE `parts` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`customer_id` text,
	`part_number` text NOT NULL,
	`rev` text,
	`description` text,
	`material_id` text,
	`flat_length_in` real,
	`flat_width_in` real,
	`finished_area_sq_in` real,
	`nesting` text,
	`cutting` text,
	`operations` text,
	`finish` text,
	`hardware` text,
	`nre` text,
	`material_extras_usd` real DEFAULT 0 NOT NULL,
	`setup_extra_labor_usd` real DEFAULT 0 NOT NULL,
	`notes` text,
	`source` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `parts_shop_number_idx` ON `parts` (`shop_id`,`part_number`);--> statement-breakpoint
CREATE INDEX `parts_customer_idx` ON `parts` (`customer_id`);--> statement-breakpoint
CREATE TABLE `plating_specs` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`source_key` text,
	`name` text NOT NULL,
	`lot_minimum_usd` real DEFAULT 0 NOT NULL,
	`price_per_sq_in_usd` real DEFAULT 0 NOT NULL,
	`part_minimum_usd` real DEFAULT 0 NOT NULL,
	`rohs_compliant` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plating_specs_shop_name_idx` ON `plating_specs` (`shop_id`,`name`);--> statement-breakpoint
CREATE TABLE `punch_hit_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`source_key` text,
	`machine_id` text NOT NULL,
	`name` text NOT NULL,
	`hits_per_hr` real NOT NULL,
	`multiplier` real DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `punch_hit_rates_machine_idx` ON `punch_hit_rates` (`machine_id`);--> statement-breakpoint
CREATE TABLE `quote_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`quote_id` text NOT NULL,
	`part_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`quantity_breaks` text NOT NULL,
	`result` text,
	`lead_time_days` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`quote_id`) REFERENCES `quotes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `quote_lines_quote_idx` ON `quote_lines` (`quote_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `quote_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`quote_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`config_snapshot_id` text NOT NULL,
	`input` text NOT NULL,
	`result` text NOT NULL,
	`reason` text DEFAULT 'save' NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`quote_id`) REFERENCES `quotes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`config_snapshot_id`) REFERENCES `config_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quote_versions_quote_no_idx` ON `quote_versions` (`quote_id`,`version_no`);--> statement-breakpoint
CREATE TABLE `quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`quote_number` text NOT NULL,
	`customer_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`quote_date` integer NOT NULL,
	`valid_until` integer,
	`terms` text,
	`notes` text,
	`won_lost_reason` text,
	`current_version_no` integer DEFAULT 0 NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quotes_shop_number_idx` ON `quotes` (`shop_id`,`quote_number`);--> statement-breakpoint
CREATE INDEX `quotes_customer_idx` ON `quotes` (`customer_id`);--> statement-breakpoint
CREATE INDEX `quotes_status_date_idx` ON `quotes` (`shop_id`,`status`,`quote_date`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `shops` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`logo_path` text,
	`unit_system` text DEFAULT 'imperial' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`validity_days` integer DEFAULT 30 NOT NULL,
	`quote_terms` text DEFAULT '' NOT NULL,
	`default_quantity_breaks` text NOT NULL,
	`shop_fixed_cost_per_job_usd` real DEFAULT 0 NOT NULL,
	`labor_markup` real NOT NULL,
	`material_markup` real NOT NULL,
	`nre_rate_per_hr_usd` real NOT NULL,
	`nre_markup` real NOT NULL,
	`min_charge_strip_in` real NOT NULL,
	`parity_markup_inside_min_charge_max` integer DEFAULT true NOT NULL,
	`parity_machine_time_factor` real DEFAULT 0.6 NOT NULL,
	`parity_legacy_coating_model` integer DEFAULT true NOT NULL,
	`parity_finishes_unmarked` integer DEFAULT true NOT NULL,
	`enabled_modules` text NOT NULL,
	`calc_schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE TABLE `silkscreen_tiers` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`source_key` text,
	`name` text NOT NULL,
	`screen_cost_usd` real,
	`print_cost_usd` real DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `silkscreen_tiers_shop_name_idx` ON `silkscreen_tiers` (`shop_id`,`name`);--> statement-breakpoint
CREATE TABLE `stock_sizes` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`source_key` text,
	`material_id` text,
	`family_id` text,
	`length_in` real NOT NULL,
	`width_in` real NOT NULL,
	`preferred` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`family_id`) REFERENCES `material_families`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stock_sizes_material_idx` ON `stock_sizes` (`material_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`username` text NOT NULL,
	`email` text,
	`display_name` text,
	`role` text NOT NULL,
	`password_hash` text NOT NULL,
	`must_change_password` integer DEFAULT false NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_shop_username_idx` ON `users` (`shop_id`,`username`);