exports.up = (pgm) => {
  pgm.createTable('dashboard_widget', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    dashboard_id: { type: 'uuid', notNull: true, references: 'dashboard', onDelete: 'CASCADE' },
    widget_type: { type: 'text', notNull: true },
    title: { type: 'text', notNull: true },
    layout: { type: 'jsonb', notNull: true },
    config: { type: 'jsonb', notNull: true, default: '{}' },
    environment_mode: { type: 'text', notNull: true, default: 'inherit' },
    pinned_environment_name: { type: 'text' },
    layout_updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    config_updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint(
    'dashboard_widget',
    'dashboard_widget_environment_mode_check',
    "CHECK (environment_mode IN ('inherit', 'pin'))"
  )
  pgm.createIndex('dashboard_widget', ['dashboard_id'])
}

exports.down = (pgm) => {
  pgm.dropTable('dashboard_widget')
}
