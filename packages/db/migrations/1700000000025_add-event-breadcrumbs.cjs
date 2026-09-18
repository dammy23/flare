exports.up = (pgm) => {
  pgm.addColumn('event', {
    breadcrumbs: { type: 'jsonb' },
  })
}

exports.down = (pgm) => {
  pgm.dropColumn('event', 'breadcrumbs')
}
