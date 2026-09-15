exports.up = (pgm) => {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman`)

  pgm.sql(`ALTER TABLE event DROP CONSTRAINT event_project_event_id_unique`)
  pgm.sql(`ALTER TABLE event RENAME TO event_unpartitioned`)
  pgm.sql(`
    CREATE TABLE event (
      LIKE event_unpartitioned
    ) PARTITION BY RANGE ("timestamp")
  `)
  pgm.sql(`ALTER TABLE event ADD CONSTRAINT event_project_event_id_ts_unique UNIQUE (project_id, event_id, "timestamp")`)
  pgm.sql(`CREATE INDEX event_project_issue_ts_idx ON event (project_id, issue_id, "timestamp")`)
  pgm.sql(`INSERT INTO event SELECT * FROM event_unpartitioned`)
  pgm.sql(`DROP TABLE event_unpartitioned`)

  pgm.sql(`
    SELECT partman.create_parent(
      p_parent_table := 'public.event',
      p_control := 'timestamp',
      p_interval := 'monthly',
      p_default_table := true
    )
  `)
  pgm.sql(`UPDATE partman.part_config SET retention = '90 days', retention_keep_table = false WHERE parent_table = 'public.event'`)
}

exports.down = (pgm) => {
  pgm.sql(`SELECT partman.undo_partition('public.event', p_keep_table := true)`)
  pgm.sql(`ALTER TABLE event DROP CONSTRAINT event_project_event_id_ts_unique`)
  pgm.sql(`ALTER TABLE event ADD CONSTRAINT event_project_event_id_unique UNIQUE (project_id, event_id)`)
}
