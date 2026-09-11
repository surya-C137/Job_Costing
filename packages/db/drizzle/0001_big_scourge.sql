DROP INDEX `coating_models_shop_name_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `coating_models_shop_name_idx` ON `coating_models` (`shop_id`,`name`) WHERE archived_at IS NULL;--> statement-breakpoint
DROP INDEX `customers_shop_name_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `customers_shop_name_idx` ON `customers` (`shop_id`,`name`) WHERE archived_at IS NULL;--> statement-breakpoint
DROP INDEX `gauge_reference_shop_family_label_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `gauge_reference_shop_family_label_idx` ON `gauge_reference` (`shop_id`,`family_id`,`label`) WHERE archived_at IS NULL;--> statement-breakpoint
DROP INDEX `intake_aliases_shop_kind_alias_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `intake_aliases_shop_kind_alias_idx` ON `intake_aliases` (`shop_id`,`kind`,`alias`) WHERE archived_at IS NULL;--> statement-breakpoint
DROP INDEX `machine_material_rates_pair_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `machine_material_rates_pair_idx` ON `machine_material_rates` (`machine_id`,`material_id`) WHERE archived_at IS NULL;--> statement-breakpoint
DROP INDEX `machines_shop_name_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `machines_shop_name_idx` ON `machines` (`shop_id`,`name`) WHERE archived_at IS NULL;--> statement-breakpoint
DROP INDEX `material_families_shop_name_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `material_families_shop_name_idx` ON `material_families` (`shop_id`,`name`) WHERE archived_at IS NULL;--> statement-breakpoint
DROP INDEX `materials_shop_name_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `materials_shop_name_idx` ON `materials` (`shop_id`,`name`) WHERE archived_at IS NULL;--> statement-breakpoint
DROP INDEX `plating_specs_shop_name_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `plating_specs_shop_name_idx` ON `plating_specs` (`shop_id`,`name`) WHERE archived_at IS NULL;--> statement-breakpoint
DROP INDEX `silkscreen_tiers_shop_name_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `silkscreen_tiers_shop_name_idx` ON `silkscreen_tiers` (`shop_id`,`name`) WHERE archived_at IS NULL;--> statement-breakpoint
DROP INDEX `users_shop_username_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_shop_username_idx` ON `users` (`shop_id`,`username`) WHERE archived_at IS NULL;