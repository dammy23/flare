exports.up = (pgm) => {
  pgm.createTable('source_map_artifact', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    release_id: { type: 'uuid', notNull: true, references: 'release', onDelete: 'CASCADE' },
    file_path: { type: 'text', notNull: true },
    storage_key: { type: 'text', notNull: true },
    content_type: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('source_map_artifact', 'source_map_artifact_release_path_unique', 'UNIQUE(release_id, file_path)')
}

exports.down = (pgm) => {
  pgm.dropTable('source_map_artifact')
}
