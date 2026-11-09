-- Removes the load-test chargers (citrineChargePointId prefix 7300881) from the CSMS.
DO $$
DECLARE t text; pass int; left_rows int;
BEGIN
  CREATE TEMP TABLE lt_ids ON COMMIT DROP AS SELECT id FROM chargers WHERE "citrineChargePointId" LIKE '7300881%';
  FOR pass IN 1..6 LOOP
    left_rows := 0;
    FOR t IN SELECT table_name FROM information_schema.columns
             WHERE table_schema='public' AND column_name='chargerId' AND table_name <> 'chargers' LOOP
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE "chargerId" IN (SELECT id FROM lt_ids)', t);
      EXCEPTION WHEN foreign_key_violation THEN left_rows := left_rows + 1; END;
    END LOOP;
    BEGIN
      DELETE FROM chargers WHERE id IN (SELECT id FROM lt_ids);
    EXCEPTION WHEN foreign_key_violation THEN left_rows := left_rows + 1; END;
    EXIT WHEN left_rows = 0;
  END LOOP;
END $$;
SELECT count(*) AS chargers_left FROM chargers WHERE "citrineChargePointId" LIKE '7300881%';
