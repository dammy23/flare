exports.up = (pgm) => {
  pgm.addColumn('event', {
    release_id: { type: 'uuid', references: 'release', onDelete: 'SET NULL' },
  })
}

exports.down = (pgm) => {
  pgm.dropColumn('event', 'release_id')
}
