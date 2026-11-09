-- Removes every load-test station (id prefix 7300881) and its rows from CitrineOS.
-- Child tables first; a pass that hits a FK is retried in the next pass.
DO $$
DECLARE t text; pass int; n int; left_rows int;
BEGIN
  BEGIN
    DELETE FROM "MeterValues" WHERE "transactionDatabaseId" IN (SELECT id FROM "Transactions" WHERE "stationId" LIKE '7300881%');
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  FOR pass IN 1..6 LOOP
    left_rows := 0;
    FOR t IN SELECT table_name FROM information_schema.columns
             WHERE table_schema='public' AND column_name='stationId' LOOP
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE "stationId" LIKE %L', t, '7300881%');
      EXCEPTION WHEN foreign_key_violation THEN left_rows := left_rows + 1; END;
    END LOOP;
    BEGIN
      DELETE FROM "ChargingStations" WHERE id LIKE '7300881%';
    EXCEPTION WHEN foreign_key_violation THEN left_rows := left_rows + 1; END;
    EXIT WHEN left_rows = 0;
  END LOOP;
END $$;
SELECT (SELECT count(*) FROM "ChargingStations" WHERE id LIKE '7300881%') AS stations,
       (SELECT count(*) FROM "VariableAttributes" WHERE "stationId" LIKE '7300881%') AS attrs;
