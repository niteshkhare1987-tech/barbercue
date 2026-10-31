-- Inventory Phase 1: database rules for the movement kinds added in 20261031100000.
-- Kept in a separate migration because PostgreSQL cannot use newly added enum values in the
-- transaction that added them. Existing rows already satisfy the widened check.

ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_kind_shape_check";
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_kind_shape_check" CHECK (
  ("kind" IN ('OPENING', 'PURCHASE') AND "quantityDelta" > 0 AND "unitCost" IS NOT NULL
    AND ("kind" = 'PURCHASE' OR "supplierId" IS NULL))
  OR ("kind" = 'CONSUMPTION' AND "quantityDelta" < 0 AND "unitCost" IS NULL AND "supplierId" IS NULL)
  OR ("kind" = 'ADJUSTMENT' AND "unitCost" IS NULL AND "supplierId" IS NULL
    AND length(btrim(COALESCE("reason", ''))) > 0)
  -- Stock leaving for a reason; only a return to a supplier may name the supplier.
  OR ("kind" IN ('DAMAGE', 'EXPIRY', 'WASTAGE') AND "quantityDelta" < 0 AND "unitCost" IS NULL AND "supplierId" IS NULL)
  OR ("kind" = 'RETURN' AND "quantityDelta" < 0 AND "unitCost" IS NULL)
  -- Shelf transfers come in pairs sharing a transferGroupId; the incoming side carries the cost.
  OR ("kind" = 'TRANSFER_OUT' AND "quantityDelta" < 0 AND "unitCost" IS NULL AND "supplierId" IS NULL
    AND "transferGroupId" IS NOT NULL)
  OR ("kind" = 'TRANSFER_IN' AND "quantityDelta" > 0 AND "unitCost" IS NOT NULL AND "supplierId" IS NULL
    AND "transferGroupId" IS NOT NULL)
);

-- Same function as 20261017140000_inventory_core, plus: the new kinds' shapes, and TRANSFER_IN
-- blending its carried cost into the weighted average like a purchase.
CREATE OR REPLACE FUNCTION "fastque_inventory_apply_movement"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_stock DECIMAL(12,3);
  v_average_cost DECIMAL(12,2);
  v_new_stock DECIMAL(12,3);
  v_new_average_cost DECIMAL(12,2);
BEGIN
  IF NEW."quantityDelta" = 0 THEN
    RAISE EXCEPTION 'inventory movement quantity must be nonzero' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" IN ('OPENING', 'PURCHASE', 'TRANSFER_IN') AND (NEW."quantityDelta" <= 0 OR NEW."unitCost" IS NULL) THEN
    RAISE EXCEPTION 'incoming inventory movement requires positive quantity and unit cost'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" IN ('CONSUMPTION', 'DAMAGE', 'EXPIRY', 'WASTAGE', 'TRANSFER_OUT')
     AND (NEW."quantityDelta" >= 0 OR NEW."unitCost" IS NOT NULL OR NEW."supplierId" IS NOT NULL) THEN
    RAISE EXCEPTION 'outgoing movement shape is invalid' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'RETURN' AND (NEW."quantityDelta" >= 0 OR NEW."unitCost" IS NOT NULL) THEN
    RAISE EXCEPTION 'return movement shape is invalid' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" IN ('TRANSFER_IN', 'TRANSFER_OUT') AND NEW."transferGroupId" IS NULL THEN
    RAISE EXCEPTION 'shelf transfers require a transfer group' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'ADJUSTMENT' AND (NEW."unitCost" IS NOT NULL OR NEW."supplierId" IS NOT NULL OR length(btrim(COALESCE(NEW."reason", ''))) = 0) THEN
    RAISE EXCEPTION 'adjustment requires a reason and cannot set cost or supplier' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'OPENING' AND NEW."supplierId" IS NOT NULL THEN
    RAISE EXCEPTION 'opening movement cannot specify a supplier' USING ERRCODE = 'check_violation';
  END IF;

  SELECT "stockOnHand", "averageUnitCost"
    INTO v_stock, v_average_cost
    FROM "inventory_products"
    WHERE "id" = NEW."productId" AND "salonId" = NEW."salonId"
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory product not found in salon' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW."kind" = 'OPENING' AND (
      v_stock <> 0 OR EXISTS (SELECT 1 FROM "inventory_movements" m WHERE m."productId" = NEW."productId")
    ) THEN
    RAISE EXCEPTION 'opening stock may only be recorded once before any other movement'
      USING ERRCODE = 'check_violation';
  END IF;

  v_new_stock := v_stock + NEW."quantityDelta";
  IF v_new_stock < 0 THEN
    RAISE EXCEPTION 'inventory movement would result in negative stock' USING ERRCODE = 'check_violation';
  END IF;

  v_new_average_cost := v_average_cost;
  IF NEW."kind" IN ('OPENING', 'PURCHASE', 'TRANSFER_IN') THEN
    IF v_stock = 0 THEN
      v_new_average_cost := NEW."unitCost";
    ELSE
      v_new_average_cost := round(((v_stock * v_average_cost) + (NEW."quantityDelta" * NEW."unitCost")) / v_new_stock, 2);
    END IF;
  END IF;

  PERFORM set_config('fastque.inventory_movement_write', 'on', true);
  UPDATE "inventory_products"
    SET "stockOnHand" = v_new_stock,
        "averageUnitCost" = v_new_average_cost,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = NEW."productId" AND "salonId" = NEW."salonId";
  PERFORM set_config('fastque.inventory_movement_write', 'off', true);

  NEW."stockAfter" := v_new_stock;
  NEW."averageUnitCostAfter" := v_new_average_cost;
  RETURN NEW;
END;
$$;
